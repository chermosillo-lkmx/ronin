import { createHash } from "node:crypto";
import { basename } from "node:path";

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
// ruta (espacio, comillas, backtick, paréntesis/corchete de apertura, `=` o `:`). Así "src/home/x"
// o "https://cdn.example.com/Users/a.png" (la subcadena sigue a una letra del host) no se marcan.
const PATH_START_CHARS = '\\s"\'`\\(\\[=:>';
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
