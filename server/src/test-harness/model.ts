import { isAbsolute, normalize, sep } from "node:path";

/**
 * Dominio del test harness. Todo lo que llega del renderer, del CLI o del JSON local pasa por
 * estos parsers ANTES de tocar disco o de spawnear nada: el harness ejecuta sólo `program + args`
 * declarados (nunca una cadena de shell) y sólo identificadores con charset restringido.
 */

export const SUITES = ["unit", "e2e", "api", "browser"] as const;
export type TestSuite = (typeof SUITES)[number];

/** Suites que se ejecutan como proceso hijo declarado. `api` (curl/OpenAPI) queda fuera de este corte. */
export const COMMAND_SUITES = ["unit", "e2e", "browser"] as const satisfies readonly TestSuite[];
export type CommandSuite = (typeof COMMAND_SUITES)[number];

export type RunStatus = "queued" | "running" | "passed" | "failed" | "error" | "timeout" | "cancelled" | "blocked";
export const TERMINAL_STATUSES: readonly RunStatus[] = ["passed", "failed", "error", "timeout", "cancelled", "blocked"];
export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type CoverageStatus = "reported" | "not_reported" | "invalid" | "not_applicable";

export interface CommandSpec {
  program: string;
  args: string[];
}

export interface Profile {
  name: string;
  variables: Record<string, string>;
  apiBaseUrl?: string;
  allowedOrigins: string[];
  allowMutations: boolean;
}

export interface SuiteConfig {
  command: CommandSpec;
  /** Subcarpeta relativa a la raíz del repo (monorepos). Se valida que no escape. */
  cwd?: string;
  timeoutMs: number;
  junitPath?: string;
  coberturaPath?: string;
  lcovPath?: string;
}

export interface RepoHarnessConfig {
  profiles: Profile[];
  suites: Partial<Record<TestSuite, SuiteConfig>>;
}

export interface Coverage {
  status: CoverageStatus;
  /** 0–100, sólo cuando `status === "reported"`. */
  lines?: number;
  branches?: number;
  reason?: string;
}

export interface TestTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
}

export interface FailedCase {
  name: string;
  classname?: string;
  message: string;
}

export interface Run {
  runId: string;
  batchId?: string;
  repo: string;
  suite: TestSuite;
  profile: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  /** Argv ejecutado (sin variables de entorno). */
  command?: CommandSpec;
  cwd?: string;
  totals?: TestTotals;
  /** Por qué no hay conteos (sin JUnit declarado / artefacto ausente / inválido). */
  totalsReason?: string;
  coverage?: Coverage;
  failures?: FailedCase[];
  stdout?: string;
  stderr?: string;
  /** Copias locales bajo test-artifacts/<runId>/ — nunca rutas dentro del repo. */
  artifacts?: string[];
  /** Motivo cuando `status === "blocked"`. */
  reason?: string;
  fingerprint?: string;
}

export interface Batch {
  batchId: string;
  kind: "all" | "failed";
  profile: string;
  createdAt: string;
  runIds: string[];
}

export type RunSelection =
  | { kind: "suites"; repo: string; profile: string; suites: TestSuite[] }
  | { kind: "all"; profile: string }
  | { kind: "failed"; profile: string };

export class HarnessValidationError extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = "HarnessValidationError";
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "cmd", "cmd.exe", "powershell", "pwsh"]);
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 6 * 3_600_000;

function fail(path: string, message: string): never {
  throw new HarnessValidationError(`${path}: ${message}`, path);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseId(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) fail(path, "identificador inválido (letras, dígitos, . _ -)");
  return value;
}

/** Ruta relativa que no escapa del cwd: sin absolutas, sin `..` como segmento. */
export function parseRelativePath(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "ruta relativa requerida");
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) fail(path, "debe ser relativa al repo");
  const norm = normalize(value);
  if (norm === ".." || norm.startsWith(`..${sep}`) || norm.startsWith("../")) fail(path, "no puede salir del repo");
  return value;
}

export function parseCommandSpec(value: unknown, path = "command"): CommandSpec {
  if (!isRecord(value)) fail(path, "se requiere { program, args } — nunca una cadena de shell");
  const program = value.program;
  if (typeof program !== "string" || !program.trim() || /[\n\r\0]/.test(program)) fail(`${path}.program`, "programa inválido");
  const base = program.split(/[\\/]/).pop()!.toLowerCase();
  if (SHELLS.has(base)) fail(`${path}.program`, "no se permite un intérprete de shell");
  const args = value.args ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string" && !/[\n\r\0]/.test(a))) fail(`${path}.args`, "args debe ser una lista de cadenas");
  return { program: program.trim(), args: [...(args as string[])] };
}

export function parseProfile(value: unknown, path = "profile"): Profile {
  if (!isRecord(value)) fail(path, "perfil inválido");
  const name = parseId(value.name, `${path}.name`);
  const variables: Record<string, string> = {};
  if (value.variables !== undefined) {
    if (!isRecord(value.variables)) fail(`${path}.variables`, "debe ser un objeto");
    for (const [k, v] of Object.entries(value.variables)) {
      if (!VAR_RE.test(k)) fail(`${path}.variables.${k}`, "nombre de variable inválido (UPPER_SNAKE_CASE)");
      if (typeof v !== "string" || /[\n\r\0]/.test(v)) fail(`${path}.variables.${k}`, "valor inválido (sin saltos de línea)");
      variables[k] = v;
    }
  }
  let apiBaseUrl: string | undefined;
  if (value.apiBaseUrl !== undefined) {
    apiBaseUrl = parseHttpUrl(value.apiBaseUrl, `${path}.apiBaseUrl`);
  }
  const allowedOrigins: string[] = [];
  if (value.allowedOrigins !== undefined) {
    if (!Array.isArray(value.allowedOrigins)) fail(`${path}.allowedOrigins`, "debe ser una lista");
    for (const o of value.allowedOrigins) allowedOrigins.push(new URL(parseHttpUrl(o, `${path}.allowedOrigins`)).origin);
  }
  const allowMutations = value.allowMutations === true;
  const profile: Profile = { name, variables, allowedOrigins, allowMutations };
  if (apiBaseUrl) profile.apiBaseUrl = apiBaseUrl;
  return profile;
}

function parseHttpUrl(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "URL requerida");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, "URL inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(path, "sólo http/https");
  return url.href;
}

export function parseSuiteConfig(value: unknown, path = "suite"): SuiteConfig {
  if (!isRecord(value)) fail(path, "configuración de suite inválida");
  const suite: SuiteConfig = { command: parseCommandSpec(value.command, `${path}.command`), timeoutMs: DEFAULT_TIMEOUT_MS };
  if (value.cwd !== undefined && value.cwd !== "") suite.cwd = parseRelativePath(value.cwd, `${path}.cwd`);
  if (value.timeoutMs !== undefined) {
    const t = value.timeoutMs;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 1_000 || t > MAX_TIMEOUT_MS) fail(`${path}.timeoutMs`, "timeout fuera de rango");
    suite.timeoutMs = Math.floor(t);
  }
  for (const key of ["junitPath", "coberturaPath", "lcovPath"] as const) {
    const v = value[key];
    if (v !== undefined && v !== "") suite[key] = parseRelativePath(v, `${path}.${key}`);
  }
  return suite;
}

export function isSuite(value: unknown): value is TestSuite {
  return typeof value === "string" && (SUITES as readonly string[]).includes(value);
}

export function parseRepoHarnessConfig(value: unknown, path = "config"): RepoHarnessConfig {
  if (!isRecord(value)) fail(path, "configuración inválida");
  const profiles: Profile[] = [];
  const seen = new Set<string>();
  const rawProfiles = value.profiles ?? [];
  if (!Array.isArray(rawProfiles)) fail(`${path}.profiles`, "debe ser una lista");
  rawProfiles.forEach((p, i) => {
    const profile = parseProfile(p, `${path}.profiles[${i}]`);
    if (seen.has(profile.name)) fail(`${path}.profiles[${i}].name`, `profile duplicado: ${profile.name}`);
    seen.add(profile.name);
    profiles.push(profile);
  });
  const suites: Partial<Record<TestSuite, SuiteConfig>> = {};
  const rawSuites = value.suites ?? {};
  if (!isRecord(rawSuites)) fail(`${path}.suites`, "debe ser un objeto");
  for (const [key, cfg] of Object.entries(rawSuites)) {
    if (!isSuite(key)) fail(`${path}.suites.${key}`, `suite desconocida (válidas: ${SUITES.join(", ")})`);
    if (cfg === null || cfg === undefined) continue;
    suites[key] = parseSuiteConfig(cfg, `${path}.suites.${key}`);
  }
  return { profiles, suites };
}

export function parseSelection(value: unknown): RunSelection {
  if (!isRecord(value)) fail("selection", "selección inválida");
  const kind = value.kind;
  if (kind === "all" || kind === "failed") return { kind, profile: parseId(value.profile, "selection.profile") };
  if (kind === "suites") {
    const repo = parseId(value.repo, "selection.repo");
    const profile = parseId(value.profile, "selection.profile");
    if (!Array.isArray(value.suites) || value.suites.length === 0) fail("selection.suites", "lista de suites requerida");
    const suites: TestSuite[] = [];
    for (const s of value.suites) {
      if (!isSuite(s)) fail("selection.suites", `suite desconocida: ${String(s)}`);
      if (!suites.includes(s)) suites.push(s);
    }
    return { kind, repo, profile, suites };
  }
  fail("selection.kind", "kind debe ser suites | all | failed");
}

/** Copia profunda para que nadie mute estado persistido por referencia. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}
