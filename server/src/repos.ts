import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIEBRE_ROOT } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const MAP_FILE = join(here, "..", "data", "repos.json");

/**
 * Folder where a worker starts, per inferred repo. Configurable via
 * server/data/repos.json. Default: every Liebre repo starts at the monorepo
 * root (claude can `cd` into the target sub-repo). `_default` covers anything
 * not listed — including Jira tasks — so a worker never lands in an unexpected cwd.
 */
function defaultMap(): Record<string, string> {
  return { _default: LIEBRE_ROOT };
}

function loadMap(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(MAP_FILE, "utf8")) as Record<string, string>;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string") clean[k] = v;
    return { ...defaultMap(), ...clean };
  } catch {
    return defaultMap();
  }
}

let MAP = loadMap();

/** Re-read repos.json into MAP (after an edit) so resolveCwd/listRepos see changes at runtime. */
function reload(): void {
  MAP = loadMap();
}

export function resolveCwd(repo: string): { cwd: string; real: boolean } {
  const mapped = MAP[repo] ?? MAP._default ?? LIEBRE_ROOT;
  if (existsSync(mapped)) return { cwd: mapped, real: true };
  return { cwd: process.cwd(), real: false };
}

/**
 * Repo keys the UI can offer as a target folder (excludes internal keys like
 * `_default` / `_comment`). `monorepo` is always present and listed first so the
 * custom-request modal can default to it even if it isn't in repos.json.
 */
export function listRepos(): string[] {
  const keys = Object.keys(MAP).filter((k) => !k.startsWith("_") && k !== "monorepo");
  return ["monorepo", ...keys.sort()];
}

/** Normalize a repo key the same way workflow.ts slug() does. */
function slugKey(s: string): string {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export interface RepoConfig {
  defaultPath: string;
  repos: { key: string; path: string }[];
}

/** Editable repo config for the settings UI: the real repo→folder entries + the _default folder. */
export function readRepoConfig(): RepoConfig {
  const defaultPath = MAP._default ?? LIEBRE_ROOT;
  const repos = Object.keys(MAP)
    .filter((k) => !k.startsWith("_"))
    .sort()
    .map((key) => ({ key, path: MAP[key] }));
  return { defaultPath, repos };
}

/**
 * Validate + persist repo config, preserving repos.json's `_comment`, then reload MAP.
 * Invalid rows (empty key/path, or duplicate key) are dropped silently; an empty repos
 * list is valid. defaultPath falls back to the current _default when missing/blank.
 */
export function saveRepoConfig(input: { defaultPath?: unknown; repos?: unknown }): RepoConfig {
  const seen = new Set<string>();
  const entries: Record<string, string> = {};
  const inRepos = Array.isArray(input.repos) ? input.repos : [];
  for (const r of inRepos) {
    const key = slugKey((r as { key?: unknown })?.key as string ?? "");
    const rawPath = (r as { path?: unknown })?.path;
    const path = typeof rawPath === "string" ? rawPath.trim() : "";
    if (!key || !path || seen.has(key)) continue;
    seen.add(key);
    entries[key] = path;
  }
  const dp =
    typeof input.defaultPath === "string" && input.defaultPath.trim()
      ? input.defaultPath.trim()
      : (MAP._default ?? LIEBRE_ROOT);

  // Preserve the human comment already in repos.json. loadMap() keeps every string value, so
  // MAP._comment still holds the on-disk comment (reload() runs after this write) — no file re-read needed.
  const comment =
    typeof MAP._comment === "string"
      ? MAP._comment
      : "Carpeta donde arranca el worker según el repo inferido. Editable desde el dashboard (⚙ Configuración → Repos) o a mano. _default cubre lo no listado (incluye Jira).";

  writeFileSync(MAP_FILE, JSON.stringify({ _comment: comment, _default: dp, ...entries }, null, 2) + "\n");
  reload();
  return readRepoConfig();
}
