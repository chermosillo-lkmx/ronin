import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LIEBRE_ROOT } from "./config.js";
import { dataPath } from "./data-dir.js";
import { DEFAULT_ENGINE, sanitizeEngine, type EngineChoice } from "./engine-config.js";
import { listRepos, resolveCwd } from "./repos.js";

const SETTINGS_FILE = dataPath("settings.json");

/** Ajustes globales del gate de pruebas previo al merge. */
export interface GateSettings { timeoutMin: number; maxConcurrent: number; maxConcurrentLight: number; }
export const DEFAULT_GATE_SETTINGS: GateSettings = { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 };
/** Rango válido del timeout del gate (minutos); también lo usa el override por repo. */
export const GATE_TIMEOUT_RANGE = { min: 5, max: 240 } as const;
const GATE_CONCURRENT_RANGE = { min: 1, max: 8 } as const;
const GATE_CONCURRENT_LIGHT_RANGE = { min: 1, max: 16 } as const;

/** Entero dentro de [min, max]; cualquier otro tipo o valor fuera de rango → undefined (cae al default). */
export function boundedInt(v: unknown, { min, max }: { min: number; max: number }): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/** Repos configurados que resuelven a un checkout git dentro de LIEBRE_ROOT. */
export function discoverMainHealthRepos(
  repos: string[],
  resolveRepo: (repo: string) => { cwd: string; real: boolean },
  liebreRoot: string,
  isGitRepo: (cwd: string) => boolean,
): string[] {
  const root = resolve(liebreRoot);
  const seen = new Set<string>();
  return repos.filter((repo) => {
    if (seen.has(repo)) return false;
    seen.add(repo);
    const resolved = resolveRepo(repo);
    const fromRoot = relative(root, resolve(resolved.cwd));
    return resolved.real && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot) && isGitRepo(resolved.cwd);
  });
}

export interface MainHealthSettings {
  enabled: boolean;
  intervalMin: number;
  repos: string[];
  commentOnPr: boolean;
  remoteClaim: boolean;
  autoFix: boolean;
  leaseMin: number;
  aliases: Record<string, string>;
}

export const DEFAULT_MAIN_HEALTH_ALIASES: Readonly<Record<string, string>> = {
  "ant-liebre-api": "api",
  "ant-ms-cfdis": "cfdis",
  "ant-liebre-data-extraction-contpaqi": "dex",
  "ant-liebre-app": "app",
  "ant-ms-i18n": "i18n",
  "ant-ms-permissions": "perms",
};

export const DEFAULT_MAIN_HEALTH_SETTINGS: Readonly<Omit<MainHealthSettings, "repos" | "aliases">> = {
  enabled: true,
  intervalMin: 10,
  commentOnPr: false,
  remoteClaim: true,
  autoFix: true,
  leaseMin: 30,
};
export const MAIN_HEALTH_INTERVAL_RANGE = { min: 1, max: 1_440 } as const;
export const MAIN_HEALTH_LEASE_RANGE = { min: 1, max: 1_440 } as const;

const SAFE_MAIN_HEALTH_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_MAIN_HEALTH_ALIAS = /^[a-z0-9][a-z0-9-]{0,39}$/;

function uniqueNonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : "";
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function sanitizeAliases(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const aliases: Record<string, string> = {};
  for (const [rawRepo, rawAlias] of Object.entries(value)) {
    const repo = rawRepo.trim();
    const alias = typeof rawAlias === "string" ? rawAlias.trim() : "";
    if (SAFE_MAIN_HEALTH_REPO.test(repo) && SAFE_MAIN_HEALTH_ALIAS.test(alias) && !Object.hasOwn(aliases, repo)) aliases[repo] = alias;
  }
  return aliases;
}

function sanitizeMainHealth(raw: unknown): Partial<MainHealthSettings> {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const intervalMin = boundedInt(value.intervalMin, MAIN_HEALTH_INTERVAL_RANGE);
  const leaseMin = boundedInt(value.leaseMin, MAIN_HEALTH_LEASE_RANGE);
  const repos = uniqueNonEmptyStrings(value.repos);
  const aliases = sanitizeAliases(value.aliases);
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(intervalMin !== undefined ? { intervalMin } : {}),
    ...(repos !== undefined ? { repos } : {}),
    ...(typeof value.commentOnPr === "boolean" ? { commentOnPr: value.commentOnPr } : {}),
    ...(typeof value.remoteClaim === "boolean" ? { remoteClaim: value.remoteClaim } : {}),
    ...(typeof value.autoFix === "boolean" ? { autoFix: value.autoFix } : {}),
    ...(leaseMin !== undefined ? { leaseMin } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
  };
}

export function defaultMainHealthSettings(repos: string[]): MainHealthSettings {
  return { ...DEFAULT_MAIN_HEALTH_SETTINGS, repos: [...repos], aliases: { ...DEFAULT_MAIN_HEALTH_ALIASES } };
}

function discoverDefaultMainHealthRepos(): string[] {
  return discoverMainHealthRepos(listRepos(), resolveCwd, LIEBRE_ROOT, (cwd) => existsSync(join(cwd, ".git")));
}

export function readMainHealthSettings(
  file = SETTINGS_FILE,
  discoverRepos: () => string[] = discoverDefaultMainHealthRepos,
): MainHealthSettings {
  const defaults = defaultMainHealthSettings(discoverRepos());
  const stored = load(file).mainHealth;
  return {
    ...defaults,
    ...stored,
    repos: [...(stored?.repos ?? defaults.repos)],
    aliases: { ...(stored?.aliases ?? defaults.aliases) },
  };
}

interface StoredSettings { allowedRoots?: string[]; engine?: EngineChoice; gate?: Partial<GateSettings>; mainHealth?: Partial<MainHealthSettings>; }

function sanitizeGate(raw: any): Partial<GateSettings> {
  const timeoutMin = boundedInt(raw?.timeoutMin, GATE_TIMEOUT_RANGE);
  const maxConcurrent = boundedInt(raw?.maxConcurrent, GATE_CONCURRENT_RANGE);
  const maxConcurrentLight = boundedInt(raw?.maxConcurrentLight, GATE_CONCURRENT_LIGHT_RANGE);
  return { ...(timeoutMin !== undefined ? { timeoutMin } : {}), ...(maxConcurrent !== undefined ? { maxConcurrent } : {}), ...(maxConcurrentLight !== undefined ? { maxConcurrentLight } : {}) };
}

function load(file = SETTINGS_FILE): StoredSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      ...(Array.isArray(raw?.allowedRoots) ? { allowedRoots: raw.allowedRoots.filter((root: unknown): root is string => typeof root === "string") } : {}),
      ...(raw && typeof raw === "object" && "engine" in raw ? { engine: sanitizeEngine(raw.engine) } : {}),
      ...(raw?.gate && typeof raw.gate === "object" ? { gate: sanitizeGate(raw.gate) } : {}),
      ...(raw?.mainHealth && typeof raw.mainHealth === "object" ? { mainHealth: sanitizeMainHealth(raw.mainHealth) } : {}),
    };
  } catch { return {}; }
}

export function readAllowedRoots(file = SETTINGS_FILE): string[] { return load(file).allowedRoots ?? []; }
export function readEngine(file = SETTINGS_FILE): EngineChoice { return load(file).engine ?? { ...DEFAULT_ENGINE }; }
/** Defaults del gate; un valor ausente, de otro tipo o fuera de rango cae al predeterminado. */
export function readGateSettings(file = SETTINGS_FILE): GateSettings {
  const gate = load(file).gate;
  return {
    timeoutMin: gate?.timeoutMin ?? DEFAULT_GATE_SETTINGS.timeoutMin,
    maxConcurrent: gate?.maxConcurrent ?? DEFAULT_GATE_SETTINGS.maxConcurrent,
    maxConcurrentLight: gate?.maxConcurrentLight ?? DEFAULT_GATE_SETTINGS.maxConcurrentLight,
  };
}
export function saveAllowedRoots(input: unknown, file = SETTINGS_FILE): string[] {
  if (!Array.isArray(input)) throw new Error("se esperaba una lista de raíces (rutas absolutas existentes)");
  const roots: string[] = [];
  for (const value of input) {
    const root = typeof value === "string" ? value.trim() : String(value);
    if (!isAbsolute(root) || !existsSync(root)) throw new Error(`raíz inválida: ${root} (debe existir y ser absoluta)`);
    const resolved = realpathSync(root);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  writeFileSync(file, JSON.stringify({ ...load(file), allowedRoots: roots }, null, 2) + "\n");
  return roots;
}

export function saveEngine(input: unknown, file = SETTINGS_FILE): EngineChoice {
  const engine = sanitizeEngine(input);
  writeFileSync(file, JSON.stringify({ ...load(file), engine }, null, 2) + "\n");
  return engine;
}
