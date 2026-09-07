import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

export const KB_CANDIDATES = ["knowledge-base", "kb", "docs/kb"];

/** Límite deliberado para que un directorio enorme no bloquee la inspección de la UI. */
export const MAX_KB_FILES = 10_000;

const exec = promisify(execFile);

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

function resolveDirectory(repoRoot: string, requested: string): string | null {
  try {
    const root = realpathSync(repoRoot);
    if (!statSync(root).isDirectory()) return null;
    const candidate = isAbsolute(requested) ? requested : resolve(root, requested);
    // Check before realpath as well: a configured ../ must never become a permitted alias.
    if (!isInside(root, candidate)) return null;
    const actual = realpathSync(candidate);
    if (!statSync(actual).isDirectory() || !isInside(root, actual)) return null;
    return actual;
  } catch {
    return null;
  }
}

/** Resolve a configured KB directory, or the first known in-repository convention that exists. */
export function resolveKbDir(repoRoot: string, configured: string | null): string | null {
  const value = configured?.trim();
  if (value) return resolveDirectory(repoRoot, value);
  for (const candidate of KB_CANDIDATES) {
    const directory = resolveDirectory(repoRoot, candidate);
    if (directory) return directory;
  }
  return null;
}

function existingCandidates(repoRoot: string): string[] {
  return KB_CANDIDATES.filter((candidate) => resolveDirectory(repoRoot, candidate) !== null);
}

function countTree(root: string, directory: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (current: string): void => {
    if (files >= MAX_KB_FILES) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= MAX_KB_FILES) return;
      const target = resolve(current, entry.name);
      let metadata;
      try {
        metadata = lstatSync(target);
      } catch {
        continue;
      }
      // Never recurse through a link. This also prevents a linked file outside the repo from
      // contributing metadata to the shared KB summary.
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        const actual = resolveDirectory(root, target);
        if (actual) visit(actual);
      } else if (metadata.isFile()) {
        try {
          if (!isInside(root, realpathSync(target))) continue;
          files++;
          bytes += metadata.size;
        } catch {
          // A file may disappear while scanning; omit it rather than failing the whole scan.
        }
      }
    }
  };
  visit(directory);
  return { files, bytes };
}

export interface KbScan {
  path: string | null;
  relativePath: string | null;
  exists: boolean;
  files: number;
  bytes: number;
  candidates: string[];
}

/** Inspect the KB without following symlinks; counts stop after MAX_KB_FILES regular files. */
export function scanKb(repoRoot: string, configured: string | null): KbScan {
  const path = resolveKbDir(repoRoot, configured);
  const candidates = existingCandidates(repoRoot);
  if (!path) return { path: null, relativePath: null, exists: false, files: 0, bytes: 0, candidates };
  const root = realpathSync(repoRoot);
  const count = countTree(root, path);
  return { path, relativePath: relative(root, path), exists: true, ...count, candidates };
}

export interface ZipKbOptions {
  /** Costura de prueba; producción usa el ejecutable zip disponible en PATH. */
  binary?: string;
}

/** Create a ZIP containing the KB directory itself, using the system zip binary and argv only. */
export async function zipKb(kbDir: string, outDir: string, nombreBase: string, options: ZipKbOptions = {}): Promise<string> {
  const directory = realpathSync(kbDir);
  const base = basename(nombreBase).trim() || "knowledge-base";
  const destination = resolve(outDir, `${base}.zip`);
  const parent = resolve(directory, "..");
  const folder = `./${basename(directory)}`;
  try {
    await exec(options.binary ?? "zip", ["-r", "-q", destination, folder], { cwd: parent });
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      throw new Error("No se encontró el binario 'zip' en PATH; instálalo para empaquetar la base de conocimiento.");
    }
    throw error;
  }
  return destination;
}
