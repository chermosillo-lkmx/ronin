import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dataPath } from "./data-dir.js";

const SETTINGS_FILE = dataPath("settings.json");
interface StoredSettings { allowedRoots?: string[]; }

function load(file = SETTINGS_FILE): StoredSettings {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(raw?.allowedRoots)
      ? { allowedRoots: raw.allowedRoots.filter((root: unknown): root is string => typeof root === "string") }
      : {};
  } catch { return {}; }
}

export function readAllowedRoots(file = SETTINGS_FILE): string[] { return load(file).allowedRoots ?? []; }
export function saveAllowedRoots(input: unknown, file = SETTINGS_FILE): string[] {
  if (!Array.isArray(input)) throw new Error("se esperaba una lista de raíces (rutas absolutas existentes)");
  const roots: string[] = [];
  for (const value of input) {
    const root = typeof value === "string" ? value.trim() : String(value);
    if (!isAbsolute(root) || !existsSync(root)) throw new Error(`raíz inválida: ${root} (debe existir y ser absoluta)`);
    const resolved = realpathSync(root);
    if (!roots.includes(resolved)) roots.push(resolved);
  }
  writeFileSync(file, JSON.stringify({ allowedRoots: roots }, null, 2) + "\n");
  return roots;
}
