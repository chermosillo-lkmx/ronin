import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { readCapabilityToken } from "./capability.js";
import { DATA_DIR } from "./data-dir.js";
import { addRepoSkillAssociation, getRepoVars } from "./repo-config.js";
import { listRepos, resolveCwd } from "./repos.js";
import { learnedSkillsRoot } from "./skills.js";

/**
 * Skills que se aprenden (spec 2026-09-30-skills-aprendidas-design.md). Este módulo reúne las
 * funciones puras (armado del SKILL.md, validación, filtros de secretos y rutas, nombre, diff,
 * índice de lanzamiento) y, más abajo, el store. Nada aquí ejecuta procesos.
 */

export const LEARNED_SKILL_MAX_BYTES = 8 * 1024;
export const LEARNED_SKILL_MAX_LINES = 200;
export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;
export const SKILL_SUMMARY_MAX_CHARS = 200;
export const SKILL_CHANGES_MAX_CHARS = 500;
export const SKILL_INDEX_MAX_BYTES = 1024;
export const SKILL_INDEX_MAX_SKILLS = 8;
export const SKILL_INDEX_DESCRIPTION_MAX_CHARS = 120;
export const SKILL_CATALOG_MAX_BYTES = 4 * 1024;
export const SKILL_HISTORY_KEEP = 5;
export const MAX_PENDING_SKILL_PROPOSALS = 10;
/** Un valor de `vars` más corto que esto no se busca: "abc" aparecería en cualquier texto. */
export const SKILL_VAR_MIN_CHARS = 6;

export const SKILL_WARNINGS = ["menciona-repo", "url-externa", "comentario-html", "comando-destructivo", "nombre-ajustado"] as const;
export type SkillWarning = (typeof SKILL_WARNINGS)[number];

export type LearnedSkillErrorCode = "SKILL_INVALID" | "SKILL_PROPOSAL_NOT_FOUND" | "SKILL_STALE" | "SKILL_FLOW_INCOMPLETE" | "REPO_UNKNOWN";

/** Error esperado de las skills aprendidas: trae el status HTTP y, en SKILL_INVALID, los motivos. */
export class LearnedSkillError extends Error {
  constructor(readonly code: LearnedSkillErrorCode, message: string, readonly status: number, readonly reasons: string[] = []) {
    super(message);
    this.name = "LearnedSkillError";
  }
}

export function skillInvalid(reasons: string[]): LearnedSkillError {
  return new LearnedSkillError("SKILL_INVALID", `la skill no cumple las reglas: ${reasons.join("; ")}`, 400, reasons);
}

export function skillHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

// Control C0/C1 salvo \t (09) y \n (0a); \r ya se normalizó antes.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Sin BOM, sin formato Unicode (\p{Cf}: bidi y ancho cero), sin control salvo \n y \t; saltos en \n. */
export function cleanSkillText(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\p{Cf}/gu, "").replace(CONTROL_CHARS, "");
}

export function singleLine(raw: string): string {
  return cleanSkillText(raw).replace(/\s+/g, " ").trim();
}

const STRICT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Regla de agentskills.io: minúsculas, números y guiones simples, sin guion al inicio ni al final. */
export function isStrictSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX_CHARS && STRICT_NAME.test(name);
}

export function normalizeSkillName(raw: string): string {
  return cleanSkillText(raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_CHARS)
    .replace(/-+$/g, "");
}

export function orderWarnings(warnings: SkillWarning[]): SkillWarning[] {
  return SKILL_WARNINGS.filter((warning) => warnings.includes(warning));
}

export interface SkillDraftParts {
  name: string;
  description: string;
  body: string;
}

/** Ronin arma el frontmatter: el modelo nunca escribe campos como `allowed-tools`. */
export function buildSkillDocument(parts: SkillDraftParts): string {
  const body = cleanSkillText(parts.body).replace(/^\n+/, "").replace(/\s+$/, "");
  return `---\nname: ${parts.name}\ndescription: ${singleLine(parts.description)}\n---\n\n${body}\n`;
}

export interface SkillValidationContext {
  /** Carpeta de la skill: el `name` del frontmatter debe coincidir. */
  name: string;
  repo?: string;
  /** Ruta real del repo en disco. */
  repoPath?: string;
  dataDir?: string;
  /** `vars` del repo (clave → valor); sólo se buscan los valores de 6 caracteres o más. */
  vars?: Record<string, string>;
  /** Token de capacidad de Ronin. */
  token?: string | null;
}

export interface ValidatedSkill {
  content: string;
  name: string;
  description: string;
  warnings: SkillWarning[];
}

// Límite antes de una ruta absoluta: inicio de texto o un carácter que normalmente introduce una
// ruta (espacio, comillas, backtick, paréntesis/corchete de apertura, `=`, `:`, `>` o `/`). Así
// "src/home/x" o "https://cdn.example.com/Users/a.png" (la subcadena sigue a una letra del host) no
// se marcan, pero "file:///Users/x" y "///Users/x" sí (la barra que precede es otra barra, `/`).
const PATH_START_CHARS = '\\s"\'`\\(\\[=:>/';
const PATH_START = `(?:^|[${PATH_START_CHARS}])`;

// Límite después de una ruta absoluta buscada literalmente (repoPath/dataDir): el siguiente
// carácter debe cerrar la ruta (fin de texto, separador o puntuación), no seguir siendo parte del
// mismo nombre — así "/srv/code/acme-apiary" no coincide con el repoPath "/srv/code/acme-api".
const PATH_END_CHARS = '/\\s"\'`.,;:!?)\\]}>';
const PATH_END = `(?=$|[${PATH_END_CHARS}])`;

function absolutePathPattern(needle: string): RegExp {
  return new RegExp(`${PATH_START}${escapeRegExp(needle)}`);
}

function includesBoundedPath(content: string, path: string): boolean {
  return new RegExp(`${escapeRegExp(path)}${PATH_END}`).test(content);
}

const ABSOLUTE_PATHS: Array<[RegExp, string]> = [
  [absolutePathPattern("/Users/"), "/Users/"],
  [absolutePathPattern("/home/"), "/home/"],
  [absolutePathPattern("/tmp/cowork-cycle-"), "/tmp/cowork-cycle-"],
  [absolutePathPattern("~/"), "~/"],
  [/\b[A-Za-z]:\\/, "C:\\"],
];

const SECRETS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "llave privada PEM"],
  [/\bAKIA[0-9A-Z]{16}\b/, "llave de acceso de AWS (AKIA…)"],
  [/\bghp_[A-Za-z0-9]{20,}/, "token de GitHub (ghp_)"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "token de GitHub (github_pat_)"],
  [/\bsk-[A-Za-z0-9_-]{16,}/, "llave de API (sk-…)"],
  [/\bxox[bp]-[A-Za-z0-9-]{10,}/, "token de Slack (xox…)"],
  [/\b(?:password|secret|token|api_key)\b\s*[:=]\s*["']?[^\s"']{8,}/i, "credencial asignada (password, secret, token o api_key)"],
];

const DESTRUCTIVE = [
  /\brm\s+-(?:rf|fr)\b/,
  /\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b/,
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(content: string, word: string): boolean {
  return word.length >= 3 && new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(word)}($|[^A-Za-z0-9_-])`, "i").test(content);
}

function hasExternalUrl(content: string): boolean {
  for (const match of content.matchAll(/\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[^\s/?#)>\]"']+)/gi)) {
    const host = match[1].toLowerCase().replace(/:\d+$/, "");
    if (!LOCAL_HOSTS.has(host)) return true;
  }
  return false;
}

function lineCount(content: string): number {
  const lines = content.split("\n");
  return content.endsWith("\n") ? lines.length - 1 : lines.length;
}

/**
 * Reglas duras de §4 (rechazan con `reasons[]`) y avisos que no bloquean. El texto se limpia antes
 * de medir y de buscar, y lo que se guarda es el texto limpio. Deterministas: no dependen del modelo.
 */
export function validateLearnedSkill(raw: unknown, context: SkillValidationContext): ValidatedSkill {
  if (typeof raw !== "string") throw skillInvalid(["el contenido debe ser texto"]);
  const content = cleanSkillText(raw);
  const reasons: string[] = [];
  let name = "";
  let description = "";

  const lines = content.split("\n");
  if (lines[0] !== "---") {
    reasons.push("falta el frontmatter inicial (---)");
  } else {
    const end = lines.indexOf("---", 1);
    if (end < 0) {
      reasons.push("el frontmatter no se cierra (---)");
    } else {
      for (const line of lines.slice(1, end)) {
        if (!line.trim()) continue;
        const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/);
        if (!match) reasons.push(`línea inválida en el frontmatter: ${line.slice(0, 40)}`);
        else if (match[1] === "name") name = match[2];
        else if (match[1] === "description") description = match[2];
        else reasons.push(`el frontmatter sólo admite name y description (sobra ${match[1]})`);
      }
      if (name !== context.name) reasons.push(`name debe ser ${context.name}`);
      if (description.length < 1 || description.length > SKILL_DESCRIPTION_MAX_CHARS) {
        reasons.push(`description debe tener entre 1 y ${SKILL_DESCRIPTION_MAX_CHARS} caracteres`);
      }
    }
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > LEARNED_SKILL_MAX_BYTES) reasons.push(`ocupa ${bytes} bytes; el tope es ${LEARNED_SKILL_MAX_BYTES} bytes (8 KB)`);
  const count = lineCount(content);
  if (count > LEARNED_SKILL_MAX_LINES) reasons.push(`tiene ${count} líneas; el tope es ${LEARNED_SKILL_MAX_LINES}`);

  for (const [pattern, label] of ABSOLUTE_PATHS) if (pattern.test(content)) reasons.push(`contiene una ruta absoluta (${label})`);
  if (context.repoPath && context.repoPath.length > 1 && includesBoundedPath(content, context.repoPath)) reasons.push("contiene la ruta real del repo");
  if (context.dataDir && context.dataDir.length > 1 && includesBoundedPath(content, context.dataDir)) reasons.push("contiene la ruta de datos de Ronin");
  for (const [pattern, label] of SECRETS) if (pattern.test(content)) reasons.push(`contiene un secreto: ${label}`);
  for (const [key, value] of Object.entries(context.vars ?? {})) {
    if (value.length >= SKILL_VAR_MIN_CHARS && content.includes(value)) reasons.push(`contiene el valor de una variable del repo (${key})`);
  }
  if (context.token && content.includes(context.token)) reasons.push("contiene el token de capacidad de Ronin");

  if (reasons.length) throw skillInvalid(reasons);

  const warnings: SkillWarning[] = [];
  const repoNames = [context.repo, context.repoPath ? basename(context.repoPath) : undefined].filter((item): item is string => Boolean(item));
  if (repoNames.some((word) => mentions(content, word))) warnings.push("menciona-repo");
  if (hasExternalUrl(content)) warnings.push("url-externa");
  if (content.includes("<!--")) warnings.push("comentario-html");
  if (DESTRUCTIVE.some((pattern) => pattern.test(content))) warnings.push("comando-destructivo");
  return { content, name, description, warnings: orderWarnings(warnings) };
}

// ---- Diff unificado (LCS por líneas; las skills tienen 200 líneas como máximo). ----

type DiffOp = { kind: " " | "-" | "+"; text: string };

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((text) => ({ kind: "-" as const, text })), ...b.map((text) => ({ kind: "+" as const, text }))];
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ kind: "-", text: a[i++] });
    } else {
      ops.push({ kind: "+", text: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: "-", text: a[i++] });
  while (j < m) ops.push({ kind: "+", text: b[j++] });
  return ops;
}

/** Diff unificado de `before` → `after` con `context` líneas alrededor de cada cambio. "" si son iguales. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  if (before === after) return "";
  const ops = diffLines(splitLines(before), splitLines(after));
  const changes = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  if (!changes.length) return "";
  const groups: Array<[number, number]> = [];
  for (const index of changes) {
    const last = groups[groups.length - 1];
    if (last && index - last[1] <= context * 2 + 1) last[1] = index;
    else groups.push([index, index]);
  }
  const out = ["--- a/SKILL.md", "+++ b/SKILL.md"];
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context);
    const end = Math.min(ops.length, last + context + 1);
    const before = ops.slice(0, start);
    const slice = ops.slice(start, end);
    const oldBefore = before.filter((op) => op.kind !== "+").length;
    const newBefore = before.filter((op) => op.kind !== "-").length;
    const oldCount = slice.filter((op) => op.kind !== "+").length;
    const newCount = slice.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldCount ? oldBefore + 1 : oldBefore},${oldCount} +${newCount ? newBefore + 1 : newBefore},${newCount} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return `${out.join("\n")}\n`;
}

// ---- Índice de lanzamiento (§6) y catálogo del triaje (§5). ----

const bytesOf = (value: string): number => Buffer.byteLength(value, "utf8");

export interface SkillIndexCandidate {
  root: string;
  name: string;
  sourceRepo?: string;
  description: string;
  /** Ruta absoluta del SKILL.md: el agente la lee sólo si la tarea encaja. */
  path: string;
  hash: string;
  uses: number;
  approvedAt: number;
}

export interface SkillIndex {
  text: string;
  bytes: number;
  included: SkillIndexCandidate[];
  omitted: number;
}

export function skillIndexHeader(repo: string): string {
  return `Skills disponibles para ${repo} (aprobadas por el usuario; lee el SKILL.md sólo si la tarea encaja):`;
}

function indexDescription(description: string): string {
  const text = singleLine(description);
  return text.length > SKILL_INDEX_DESCRIPTION_MAX_CHARS ? `${text.slice(0, SKILL_INDEX_DESCRIPTION_MAX_CHARS - 1)}…` : text;
}

/**
 * Índice literal (nombre, descripción y ruta; nunca el cuerpo). Prioridad: `uses` descendente y
 * después la aprobación más reciente. Como máximo 8 skills y 1 KB en bytes UTF-8, contando la nota
 * "(+N omitidas)". Se corta en la primera que ya no cabe. Sin candidatas → "".
 */
export function buildSkillIndex(repo: string, candidates: SkillIndexCandidate[], maxBytes = SKILL_INDEX_MAX_BYTES, maxSkills = SKILL_INDEX_MAX_SKILLS): SkillIndex {
  const sorted = [...candidates].sort((a, b) => b.uses - a.uses || b.approvedAt - a.approvedAt || a.name.localeCompare(b.name));
  const empty: SkillIndex = { text: "", bytes: 0, included: [], omitted: 0 };
  if (!sorted.length) return empty;
  const lines = [skillIndexHeader(repo)];
  const included: SkillIndexCandidate[] = [];
  const compose = (extra: string[], omitted: number): string =>
    [...lines, ...extra, ...(omitted > 0 ? [`(+${omitted} omitidas)`] : [])].join("\n");
  for (let index = 0; index < sorted.length && included.length < maxSkills; index++) {
    const skill = sorted[index];
    const line = `- ${skill.name}: ${indexDescription(skill.description)} → ${skill.path}`;
    if (bytesOf(compose([line], sorted.length - index - 1)) > maxBytes) break;
    lines.push(line);
    included.push(skill);
  }
  if (!included.length) return empty;
  const omitted = sorted.length - included.length;
  const text = compose([], omitted);
  return { text, bytes: bytesOf(text), included, omitted };
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Propuesta descartada: el triaje no debe repetirla. */
  discarded: boolean;
}

/** Catálogo que recibe el triaje: nombre y descripción, 4 KB como máximo. */
export function formatSkillCatalog(entries: SkillCatalogEntry[], maxBytes = SKILL_CATALOG_MAX_BYTES): string {
  if (!entries.length) return "(vacío)";
  const lines: string[] = [];
  const compose = (extra: string[], omitted: number): string =>
    [...lines, ...extra, ...(omitted > 0 ? [`(+${omitted} omitidas)`] : [])].join("\n");
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const line = `- ${entry.name}: ${singleLine(entry.description)}${entry.discarded ? " (descartada: no repetir)" : ""}`;
    if (bytesOf(compose([line], entries.length - index - 1)) > maxBytes) break;
    lines.push(line);
  }
  return compose([], entries.length - lines.length);
}

// ---- Store: <dataDir>/skills/learned.json (metadatos, propuestas e interruptor por repo). ----

export interface LearnedSkillMeta {
  originRepo: string;
  version: number;
  hash: string;
  /** Sesiones que la propusieron o la refinaron. */
  sources: string[];
  /** Veces que entró en el índice de una sesión nueva. */
  uses: number;
  approvedAt: number;
}

export type SkillProposalKind = "new" | "update";
export type SkillProposalStatus = "pending" | "approved" | "discarded";

export interface SkillProposal {
  id: string;
  kind: SkillProposalKind;
  name: string;
  repo: string;
  source: string;
  description: string;
  /** SKILL.md completo; se vacía al resolver la propuesta (quedan name y description). */
  content: string;
  contentHash: string;
  /** Sólo en update: hash del SKILL.md sobre el que se redactó. */
  baseHash?: string;
  changes: string;
  warnings: SkillWarning[];
  status: SkillProposalStatus;
  createdAt: number;
  resolvedAt?: number;
}

export interface LearnedSkillsFile {
  repos: Record<string, { enabled: boolean }>;
  skills: Record<string, LearnedSkillMeta>;
  proposals: SkillProposal[];
}

export interface SkillProposalSummary {
  id: string;
  kind: SkillProposalKind;
  name: string;
  repo: string;
  source: string;
  description: string;
  warnings: SkillWarning[];
  createdAt: number;
}

export interface SkillProposalDetail extends SkillProposalSummary {
  changes: string;
  content: string;
  contentHash: string;
  base?: { content: string; hash: string };
  diff?: string;
}

export interface ProposeSkillInput {
  repo: string;
  source: string;
  name: string;
  description: string;
  body: string;
  changes?: string;
  /** Skill `learned` que el triaje pidió refinar. */
  updates?: string | null;
  /** Nombres de skills global y de repo: una colisión recibe el sufijo -2, -3… */
  reservedNames?: string[];
}

export interface ApprovedSkill {
  name: string;
  version: number;
  hash: string;
  kind: SkillProposalKind;
  repo: string;
}

export type SkillIntegrity = "ok" | "modified";
export type SkillProposalAction = "approve" | "discard" | "edit";

export interface SkillResolution {
  proposal: SkillProposalSummary & { status: SkillProposalStatus };
  skill?: ApprovedSkill;
}

export interface SkillLearningView {
  repo: string;
  enabled: boolean;
}

export interface LearnedSkillStoreOptions {
  /** Carpeta de las skills aprendidas; por defecto learnedSkillsRoot(). */
  root?: string;
  /** Por defecto `learned.json` junto a la raíz. */
  metaFile?: string;
  /** Por defecto `history/` junto a la raíz. */
  historyDir?: string;
  listRepos?: () => string[];
  contextFor?: (repo: string) => Omit<SkillValidationContext, "name">;
  /** Asociar una skill nueva a su repo de origen; por defecto en repo-config.json. */
  associate?: (repo: string, name: string) => void;
  now?: () => number;
  newId?: () => string;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sanitizeMeta(raw: unknown): LearnedSkillMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.hash !== "string") return null;
  return {
    originRepo: typeof value.originRepo === "string" ? value.originRepo : "",
    version: Math.max(1, Math.floor(finiteOrZero(value.version))),
    hash: value.hash,
    sources: stringList(value.sources),
    uses: finiteOrZero(value.uses),
    approvedAt: finiteOrZero(value.approvedAt),
  };
}

function sanitizeProposal(raw: unknown): SkillProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.name !== "string" || typeof value.repo !== "string") return null;
  if (value.kind !== "new" && value.kind !== "update") return null;
  if (value.status !== "pending" && value.status !== "approved" && value.status !== "discarded") return null;
  return {
    id: value.id,
    kind: value.kind,
    name: value.name,
    repo: value.repo,
    source: typeof value.source === "string" ? value.source : "",
    description: typeof value.description === "string" ? value.description : "",
    content: typeof value.content === "string" ? value.content : "",
    contentHash: typeof value.contentHash === "string" ? value.contentHash : "",
    ...(typeof value.baseHash === "string" ? { baseHash: value.baseHash } : {}),
    changes: typeof value.changes === "string" ? value.changes : "",
    warnings: orderWarnings(stringList(value.warnings) as SkillWarning[]),
    status: value.status,
    createdAt: finiteOrZero(value.createdAt),
    ...(typeof value.resolvedAt === "number" ? { resolvedAt: value.resolvedAt } : {}),
  };
}

function sanitizeLearnedFile(raw: unknown): LearnedSkillsFile {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const repos: LearnedSkillsFile["repos"] = {};
  if (value.repos && typeof value.repos === "object") {
    for (const [repo, entry] of Object.entries(value.repos as Record<string, unknown>)) {
      if (entry && typeof entry === "object") repos[repo] = { enabled: (entry as { enabled?: unknown }).enabled !== false };
    }
  }
  const skills: LearnedSkillsFile["skills"] = {};
  if (value.skills && typeof value.skills === "object") {
    for (const [name, entry] of Object.entries(value.skills as Record<string, unknown>)) {
      const meta = sanitizeMeta(entry);
      if (meta && isStrictSkillName(name)) skills[name] = meta;
    }
  }
  const proposals = Array.isArray(value.proposals) ? value.proposals.flatMap((item) => { const clean = sanitizeProposal(item); return clean ? [clean] : []; }) : [];
  return { repos, skills, proposals };
}

function summaryOf(proposal: SkillProposal): SkillProposalSummary {
  const { id, kind, name, repo, source, description, warnings, createdAt } = proposal;
  return { id, kind, name, repo, source, description, warnings, createdAt };
}

function describe(content: string | null): string {
  return content?.match(/^description:[ \t]*(.*?)[ \t]*$/m)?.[1] ?? "";
}

/** Contexto real de validación: ruta del repo, dataDir, `vars` del repo y token de capacidad. */
function defaultSkillContext(repo: string): Omit<SkillValidationContext, "name"> {
  const base = { dataDir: DATA_DIR, token: readCapabilityToken() };
  if (!repo) return base;
  const resolved = resolveCwd(repo);
  return { ...base, repo, ...(resolved.real ? { repoPath: resolved.cwd } : {}), vars: getRepoVars(repo) };
}

/**
 * Store de las skills aprendidas. Cada operación relee `learned.json` (es pequeño) y lo escribe con
 * `writeJsonAtomic`. Leer nunca escribe. Nada entra al catálogo sin una aprobación explícita con el
 * hash del texto mostrado.
 */
export function createLearnedSkillStore(options: LearnedSkillStoreOptions = {}) {
  const root = options.root ?? learnedSkillsRoot();
  const metaFile = options.metaFile ?? join(dirname(root), "learned.json");
  const historyDir = options.historyDir ?? join(dirname(root), "history");
  const repos = options.listRepos ?? listRepos;
  const contextFor = options.contextFor ?? defaultSkillContext;
  const associate = options.associate ?? ((repo: string, name: string) => { addRepoSkillAssociation(repo, { root: "learned", name }); });
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => `s_${randomBytes(3).toString("hex")}`);

  function load(): LearnedSkillsFile {
    try {
      return sanitizeLearnedFile(JSON.parse(readFileSync(metaFile, "utf8")));
    } catch {
      return { repos: {}, skills: {}, proposals: [] };
    }
  }

  function save(file: LearnedSkillsFile): void {
    mkdirSync(dirname(metaFile), { recursive: true });
    writeJsonAtomic(metaFile, file);
  }

  const knows = (repo: string): boolean => repos().includes(repo);

  function requireRepo(repo: string): void {
    if (!knows(repo)) throw new LearnedSkillError("REPO_UNKNOWN", `el repositorio ${repo} no está configurado`, 404);
  }

  const fileOf = (name: string): string => join(root, name, "SKILL.md");

  function current(name: string): string | null {
    if (!isStrictSkillName(name)) return null;
    try {
      return readFileSync(fileOf(name), "utf8");
    } catch {
      return null;
    }
  }

  function findProposal(file: LearnedSkillsFile, id: string): SkillProposal {
    const found = file.proposals.find((proposal) => proposal.id === id);
    if (!found) throw new LearnedSkillError("SKILL_PROPOSAL_NOT_FOUND", `no existe la propuesta ${id}`, 404);
    return found;
  }

  function findPending(file: LearnedSkillsFile, id: string): SkillProposal {
    const proposal = findProposal(file, id);
    if (proposal.status !== "pending") throw new LearnedSkillError("SKILL_STALE", "la propuesta ya no está pendiente", 409);
    return proposal;
  }

  function pruneHistory(directory: string): void {
    const versions = readdirSync(directory)
      .flatMap((file) => { const match = /^v(\d+)\.md$/.exec(file); return match ? [Number(match[1])] : []; })
      .sort((a, b) => b - a);
    for (const version of versions.slice(SKILL_HISTORY_KEEP)) rmSync(join(directory, `v${version}.md`), { force: true });
  }

  /** La versión anterior va a history/ (se conservan 5) y el SKILL.md se reemplaza con rename atómico. */
  function writeVersion(name: string, content: string, previousVersion: number): void {
    const previous = current(name);
    if (previous !== null && previousVersion > 0) {
      const directory = join(historyDir, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `v${previousVersion}.md`), previous);
      pruneHistory(directory);
    }
    mkdirSync(join(root, name), { recursive: true });
    const target = fileOf(name);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temporary, content);
    renameSync(temporary, target);
  }

  function approveWith(file: LearnedSkillsFile, proposal: SkillProposal, content: string): SkillResolution {
    const previous = file.skills[proposal.name];
    if (proposal.kind === "new" && (previous || existsSync(join(root, proposal.name)))) {
      throw new LearnedSkillError("SKILL_STALE", `ya existe una skill aprendida llamada ${proposal.name}`, 409);
    }
    if (proposal.kind === "update") {
      const base = current(proposal.name);
      if (!previous || base === null || skillHash(base) !== proposal.baseHash) {
        throw new LearnedSkillError("SKILL_STALE", `${proposal.name} cambió desde que se propuso la actualización`, 409);
      }
    }
    const at = now();
    const hash = skillHash(content);
    writeVersion(proposal.name, content, previous?.version ?? 0);
    const meta: LearnedSkillMeta = {
      originRepo: previous?.originRepo ?? proposal.repo,
      version: (previous?.version ?? 0) + 1,
      hash,
      sources: [...new Set([...(previous?.sources ?? []), proposal.source])],
      uses: previous?.uses ?? 0,
      approvedAt: at,
    };
    file.skills[proposal.name] = meta;
    proposal.status = "approved";
    proposal.resolvedAt = at;
    proposal.content = "";
    proposal.contentHash = hash;
    save(file);
    if (proposal.kind === "new") {
      try {
        associate(proposal.repo, proposal.name);
      } catch {
        /* la asociación es una comodidad: la skill ya quedó aprobada y se puede asociar a mano */
      }
    }
    return {
      proposal: { ...summaryOf(proposal), status: proposal.status },
      skill: { name: proposal.name, version: meta.version, hash, kind: proposal.kind, repo: proposal.repo },
    };
  }

  return {
    root,
    knows,

    learning(repo: string): SkillLearningView {
      requireRepo(repo);
      return { repo, enabled: load().repos[repo]?.enabled !== false };
    },

    learningEnabled(repo: string): boolean {
      try {
        return knows(repo) && load().repos[repo]?.enabled !== false;
      } catch {
        return false;
      }
    },

    setLearning(repo: string, enabled: unknown): SkillLearningView {
      requireRepo(repo);
      if (typeof enabled !== "boolean") throw skillInvalid(["enabled debe ser true o false"]);
      const file = load();
      file.repos[repo] = { enabled };
      save(file);
      return { repo, enabled };
    },

    names(): string[] {
      return Object.keys(load().skills).sort();
    },

    meta(name: string): LearnedSkillMeta | null {
      return load().skills[name] ?? null;
    },

    current,

    integrity(name: string): SkillIntegrity {
      const meta = load().skills[name];
      const text = current(name);
      return meta && text !== null && skillHash(text) === meta.hash ? "ok" : "modified";
    },

    /** Para el triaje: las learned y las descartadas (marcadas "no repetir"). */
    catalog(): SkillCatalogEntry[] {
      const file = load();
      const entries: SkillCatalogEntry[] = Object.keys(file.skills).sort().map((name) => ({ name, description: describe(current(name)), discarded: false }));
      const seen = new Set(entries.map((entry) => entry.name));
      for (const proposal of file.proposals) {
        if (proposal.status !== "discarded" || seen.has(proposal.name)) continue;
        seen.add(proposal.name);
        entries.push({ name: proposal.name, description: proposal.description, discarded: true });
      }
      return entries;
    },

    pending(repo?: string): SkillProposalSummary[] {
      if (repo !== undefined) requireRepo(repo);
      return load().proposals.filter((proposal) => proposal.status === "pending" && (repo === undefined || proposal.repo === repo)).map(summaryOf);
    },

    pendingCount(): number {
      return load().proposals.filter((proposal) => proposal.status === "pending").length;
    },

    hasPendingUpdate(name: string): boolean {
      return load().proposals.some((proposal) => proposal.status === "pending" && proposal.kind === "update" && proposal.name === name);
    },

    /** Texto completo, hash y, en una actualización, la versión actual y el diff. Sólo pendientes. */
    detail(id: string): SkillProposalDetail {
      const proposal = findProposal(load(), id);
      if (proposal.status !== "pending") throw new LearnedSkillError("SKILL_PROPOSAL_NOT_FOUND", `la propuesta ${id} ya no está pendiente`, 404);
      const base = proposal.kind === "update" ? current(proposal.name) ?? "" : null;
      return {
        ...summaryOf(proposal),
        changes: proposal.changes,
        content: proposal.content,
        contentHash: proposal.contentHash,
        ...(base !== null ? { base: { content: base, hash: skillHash(base) }, diff: unifiedDiff(base, proposal.content) } : {}),
      };
    },

    /**
     * Borrador de la redacción → propuesta `pending`. Si el nombre (o `updates`) es una learned, es una
     * actualización con `baseHash`; si choca con una global o de repo, recibe sufijo y el aviso
     * `nombre-ajustado`. Lanza si no pasa las reglas de §4.
     */
    propose(input: ProposeSkillInput): SkillProposal {
      requireRepo(input.repo);
      const file = load();
      if (file.proposals.filter((proposal) => proposal.status === "pending").length >= MAX_PENDING_SKILL_PROPOSALS) {
        throw new LearnedSkillError("SKILL_STALE", `ya hay ${MAX_PENDING_SKILL_PROPOSALS} propuestas pendientes`, 409);
      }
      const learned = new Set(Object.keys(file.skills));
      let name = normalizeSkillName(input.updates && learned.has(input.updates) ? input.updates : input.name);
      if (!name) throw skillInvalid(["el nombre propuesto no produce un slug válido"]);
      const warnings: SkillWarning[] = name === input.name ? [] : ["nombre-ajustado"];
      const kind: SkillProposalKind = learned.has(name) ? "update" : "new";
      if (kind === "new" && (input.reservedNames ?? []).includes(name)) {
        const taken = new Set([...(input.reservedNames ?? []), ...learned]);
        const base = name;
        for (let suffix = 2; taken.has(name); suffix++) {
          const tail = `-${suffix}`;
          name = `${base.slice(0, SKILL_NAME_MAX_CHARS - tail.length).replace(/-+$/, "")}${tail}`;
        }
        if (!warnings.includes("nombre-ajustado")) warnings.push("nombre-ajustado");
      }
      if (kind === "update" && file.proposals.some((proposal) => proposal.status === "pending" && proposal.kind === "update" && proposal.name === name)) {
        throw new LearnedSkillError("SKILL_STALE", `ya hay una actualización pendiente para ${name}`, 409);
      }
      const validated = validateLearnedSkill(buildSkillDocument({ name, description: input.description, body: input.body }), { ...contextFor(input.repo), name });
      const base = kind === "update" ? current(name) : null;
      const proposal: SkillProposal = {
        id: newId(),
        kind,
        name,
        repo: input.repo,
        source: input.source,
        description: validated.description,
        content: validated.content,
        contentHash: skillHash(validated.content),
        ...(kind === "update" ? { baseHash: base === null ? "" : skillHash(base) } : {}),
        changes: singleLine(input.changes ?? "").slice(0, SKILL_CHANGES_MAX_CHARS),
        warnings: orderWarnings([...warnings, ...validated.warnings]),
        status: "pending",
        createdAt: now(),
      };
      file.proposals.push(proposal);
      save(file);
      return proposal;
    },

    resolve(id: string, action: unknown, payload: { contentHash?: unknown; content?: unknown } = {}): SkillResolution {
      if (action !== "approve" && action !== "discard" && action !== "edit") throw skillInvalid(["action debe ser approve, discard o edit"]);
      const file = load();
      const proposal = findPending(file, id);
      if (action === "discard") {
        proposal.status = "discarded";
        proposal.resolvedAt = now();
        proposal.content = "";
        save(file);
        return { proposal: { ...summaryOf(proposal), status: proposal.status } };
      }
      if (action === "approve") {
        if (typeof payload.contentHash !== "string" || !payload.contentHash) throw skillInvalid(["contentHash es obligatorio para aprobar"]);
        if (payload.contentHash !== proposal.contentHash) {
          throw new LearnedSkillError("SKILL_STALE", "el texto que aprobaste no coincide con la propuesta guardada", 409);
        }
        return approveWith(file, proposal, proposal.content);
      }
      const validated = validateLearnedSkill(payload.content, { ...contextFor(proposal.repo), name: proposal.name });
      proposal.description = validated.description;
      proposal.warnings = validated.warnings;
      return approveWith(file, proposal, validated.content);
    },

    /** Edición desde el editor de Ronin (PUT /api/skills): mismas reglas, versión nueva y hash al día. */
    saveEdited(name: string, content: unknown): ApprovedSkill {
      if (current(name) === null) throw skillInvalid([`no existe la skill aprendida ${name}`]);
      const file = load();
      const previous = file.skills[name];
      const repo = previous?.originRepo ?? "";
      const validated = validateLearnedSkill(content, { ...contextFor(repo), name });
      const hash = skillHash(validated.content);
      writeVersion(name, validated.content, previous?.version ?? 0);
      const meta: LearnedSkillMeta = {
        originRepo: repo,
        version: (previous?.version ?? 0) + 1,
        hash,
        sources: previous?.sources ?? [],
        uses: previous?.uses ?? 0,
        approvedAt: now(),
      };
      file.skills[name] = meta;
      save(file);
      return { name, version: meta.version, hash, kind: previous ? "update" : "new", repo };
    },

    markUsed(names: string[]): void {
      const file = load();
      let changed = false;
      for (const name of names) {
        const meta = file.skills[name];
        if (!meta) continue;
        meta.uses += 1;
        changed = true;
      }
      if (changed) save(file);
    },
  };
}

export type LearnedSkillStore = ReturnType<typeof createLearnedSkillStore>;

let sharedLearnedStore: LearnedSkillStore | null = null;

/** Store de producción sobre <dataDir>/skills. Crearlo no toca el disco. */
export function defaultLearnedSkillStore(): LearnedSkillStore {
  return (sharedLearnedStore ??= createLearnedSkillStore());
}
