import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dataPath } from "./data-dir.js";
import { DEFAULT_ENGINE, sanitizeEngine, type EngineChoice } from "./engine-config.js";

const SETTINGS_FILE = dataPath("settings.json");

/** Ajustes globales del gate de pruebas previo al merge. */
export interface GateSettings { timeoutMin: number; maxConcurrent: number; }
export const DEFAULT_GATE_SETTINGS: GateSettings = { timeoutMin: 45, maxConcurrent: 2 };
/** Rango válido del timeout del gate (minutos); también lo usa el override por repo. */
export const GATE_TIMEOUT_RANGE = { min: 5, max: 240 } as const;
const GATE_CONCURRENT_RANGE = { min: 1, max: 8 } as const;

/** Entero dentro de [min, max]; cualquier otro tipo o valor fuera de rango → undefined (cae al default). */
export function boundedInt(v: unknown, { min, max }: { min: number; max: number }): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

interface StoredSettings { allowedRoots?: string[]; engine?: EngineChoice; gate?: Partial<GateSettings>; }

function sanitizeGate(raw: any): Partial<GateSettings> {
  const timeoutMin = boundedInt(raw?.timeoutMin, GATE_TIMEOUT_RANGE);
  const maxConcurrent = boundedInt(raw?.maxConcurrent, GATE_CONCURRENT_RANGE);
  return { ...(timeoutMin !== undefined ? { timeoutMin } : {}), ...(maxConcurrent !== undefined ? { maxConcurrent } : {}) };
}

function load(file = SETTINGS_FILE): StoredSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return {
      ...(Array.isArray(raw?.allowedRoots) ? { allowedRoots: raw.allowedRoots.filter((root: unknown): root is string => typeof root === "string") } : {}),
      ...(raw && typeof raw === "object" && "engine" in raw ? { engine: sanitizeEngine(raw.engine) } : {}),
      ...(raw?.gate && typeof raw.gate === "object" ? { gate: sanitizeGate(raw.gate) } : {}),
    };
  } catch { return {}; }
}

export function readAllowedRoots(file = SETTINGS_FILE): string[] { return load(file).allowedRoots ?? []; }
export function readEngine(file = SETTINGS_FILE): EngineChoice { return load(file).engine ?? { ...DEFAULT_ENGINE }; }
/** Defaults del gate; un valor ausente, de otro tipo o fuera de rango cae al predeterminado. */
export function readGateSettings(file = SETTINGS_FILE): GateSettings {
  const gate = load(file).gate;
  return { timeoutMin: gate?.timeoutMin ?? DEFAULT_GATE_SETTINGS.timeoutMin, maxConcurrent: gate?.maxConcurrent ?? DEFAULT_GATE_SETTINGS.maxConcurrent };
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
