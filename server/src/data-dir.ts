import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const DEFAULT_DATA_FILES = ["actions.json", "clickup-seed.json", "jira-seed.json", "prompts.json", "workflow.json", "workflows.json"];

export function resolveDataDirectory(value: string | undefined, bundledDirectory: string): string {
  return value?.trim() || bundledDirectory;
}

export function dataPath(file: string, directory = DATA_DIR): string {
  return join(directory, file);
}

export const DATA_DIR = resolveDataDirectory(process.env.COWORK_DATA_DIR, BUNDLED_DATA_DIR);

function prepareUserDataDirectory(): void {
  if (DATA_DIR === BUNDLED_DATA_DIR) return;
  mkdirSync(DATA_DIR, { recursive: true });
  for (const file of DEFAULT_DATA_FILES) {
    const source = dataPath(file, BUNDLED_DATA_DIR);
    const target = dataPath(file);
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
  }
}

// Electron's asar is intentionally read-only. Only safe defaults are copied; settings, history,
// reports and curl credentials remain user-owned and are never bundled into a new profile.
prepareUserDataDirectory();
