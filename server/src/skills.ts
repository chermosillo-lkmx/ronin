import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { resolveCwd } from "./repos.js";
import type { SkillRef, SkillRoot } from "./repo-config.js";

const exec = promisify(execFile);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SkillErrorCode = "SKILL_NOT_FOUND" | "SKILL_PATH_OUTSIDE_ROOT" | "NAME_REQUIRED" | "DESCRIPTION_REQUIRED" | "SKILL_ALREADY_EXISTS" | "SKILL_REF_INVALID";
export class SkillError extends Error {
  constructor(readonly code: SkillErrorCode, message: string) { super(message); }
}

export interface SkillDocument {
  ref: SkillRef;
  content: string;
  name: string;
  description: string;
  valid: true;
}

export interface SkillSummary {
  ref: SkillRef;
  name: string;
  description: string;
  valid: boolean;
  error?: string;
}

function rootDirectory(root: SkillRoot, sourceRepo?: string): string {
  // Mirrors the mockup and Claude Code's conventional global location. `COWORK_SKILLS_ROOT`
  // makes tests and managed deployments deterministic without depending on the utility
  // process's cwd (which is not stable after Electron packaging).
  if (root === "global") return process.env.COWORK_SKILLS_ROOT?.trim() || join(homedir(), ".claude", "skills");
  if (!sourceRepo) throw new SkillError("SKILL_REF_INVALID", "las skills de repositorio requieren sourceRepo");
  const resolved = resolveCwd(sourceRepo);
  if (!resolved.real) throw new SkillError("SKILL_REF_INVALID", "el repositorio de la skill no existe");
  return root === "repo-claude" ? join(resolved.cwd, ".claude", "skills") : join(resolved.cwd, "skills");
}

function safeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!NAME.test(name)) throw new SkillError("NAME_REQUIRED", "el nombre debe ser un slug corto (minúsculas, números y guiones)");
  return name;
}

function normalizedRef(raw: Partial<SkillRef>): SkillRef {
  const root = raw.root;
  if (root !== "global" && root !== "repo-claude" && root !== "repo-skills") {
    throw new SkillError("SKILL_REF_INVALID", "raíz de skill inválida");
  }
  const name = safeName(raw.name);
  const sourceRepo = typeof raw.sourceRepo === "string" ? raw.sourceRepo.trim() : "";
  if (root === "global") return { root, name };
  if (!sourceRepo) throw new SkillError("SKILL_REF_INVALID", "las skills de repositorio requieren sourceRepo");
  return { root, name, sourceRepo };
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

function existingRoot(ref: SkillRef): string {
  const root = rootDirectory(ref.root, ref.sourceRepo);
  if (!existsSync(root)) throw new SkillError("SKILL_NOT_FOUND", "la raíz de skills no existe");
  return realpathSync(root);
}

function skillDirectory(ref: SkillRef): { root: string; directory: string } {
  const root = existingRoot(ref);
  const candidate = join(root, ref.name);
  if (!existsSync(candidate)) throw new SkillError("SKILL_NOT_FOUND", "la skill no existe");
  const directory = realpathSync(candidate);
  if (!inside(root, directory) || !lstatSync(directory).isDirectory()) {
    throw new SkillError("SKILL_PATH_OUTSIDE_ROOT", "la ruta de la skill abandona su raíz autorizada");
  }
  return { root, directory };
}

export function parseSkillDocument(content: string, folderName: string): Omit<SkillDocument, "ref" | "content"> {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new SkillError("SKILL_REF_INVALID", "falta el frontmatter inicial de la skill");
  let end = -1;
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { end = i; break; }
    const match = lines[i].match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  if (end < 0) throw new SkillError("SKILL_REF_INVALID", "frontmatter sin cierre");
  if (!fields.name?.trim()) throw new SkillError("NAME_REQUIRED", "el frontmatter requiere name");
  if (!fields.description?.trim()) throw new SkillError("DESCRIPTION_REQUIRED", "el frontmatter requiere description");
  if (fields.name.trim() !== folderName) throw new SkillError("SKILL_REF_INVALID", "el name del frontmatter debe coincidir con la carpeta");
  return { name: fields.name.trim(), description: fields.description.trim(), valid: true };
}

export function readSkill(raw: Partial<SkillRef>): SkillDocument {
  const ref = normalizedRef(raw);
  const { directory } = skillDirectory(ref);
  const file = join(directory, "SKILL.md");
  if (!existsSync(file)) throw new SkillError("SKILL_NOT_FOUND", "falta SKILL.md");
  const resolvedFile = realpathSync(file);
  if (!inside(directory, resolvedFile)) throw new SkillError("SKILL_PATH_OUTSIDE_ROOT", "SKILL.md abandona el directorio de la skill");
  const content = readFileSync(resolvedFile, "utf8");
  return { ref, content, ...parseSkillDocument(content, ref.name) };
}

function summariesAt(root: SkillRoot, sourceRepo?: string): SkillSummary[] {
  let directory: string;
  try { directory = existingRoot(root === "global" ? { root, name: "x" } : { root, name: "x", sourceRepo }); }
  catch { return []; }
  const source = root === "global" ? undefined : sourceRepo;
  const out: SkillSummary[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !NAME.test(entry.name)) continue;
    const ref: SkillRef = source ? { root, name: entry.name, sourceRepo: source } : { root, name: entry.name };
    try {
      const skill = readSkill(ref);
      out.push({ ref, name: skill.name, description: skill.description, valid: true });
    } catch (error) {
      out.push({ ref, name: entry.name, description: "", valid: false, error: (error as Error).message });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** List global skills and the two conventional local roots for every requested configured repo. */
export function listSkills(repos: string[]): SkillSummary[] {
  return [
    ...summariesAt("global"),
    ...repos.flatMap((repo) => [...summariesAt("repo-claude", repo), ...summariesAt("repo-skills", repo)]),
  ];
}

function ensureCreationRoot(ref: SkillRef): string {
  const root = rootDirectory(ref.root, ref.sourceRepo);
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

export function createSkill(raw: Partial<SkillRef>, content: string): SkillDocument {
  const ref = normalizedRef(raw);
  parseSkillDocument(content, ref.name); // validate before writing anything
  const root = ensureCreationRoot(ref);
  const destination = join(root, ref.name);
  if (!inside(root, destination)) throw new SkillError("SKILL_PATH_OUTSIDE_ROOT", "destino inválido");
  if (existsSync(destination)) throw new SkillError("SKILL_ALREADY_EXISTS", "ya existe una skill con ese nombre");
  mkdirSync(destination);
  try {
    writeFileSync(join(destination, "SKILL.md"), content);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return readSkill(ref);
}

/** Validate first, then replace a single SKILL.md with a sibling temporary + atomic rename. */
export function updateSkill(raw: Partial<SkillRef>, content: string): SkillDocument {
  const ref = normalizedRef(raw);
  parseSkillDocument(content, ref.name);
  const { root, directory } = skillDirectory(ref);
  const destination = join(directory, "SKILL.md");
  const existing = realpathSync(destination);
  if (!inside(root, existing) || !inside(directory, existing)) throw new SkillError("SKILL_PATH_OUTSIDE_ROOT", "SKILL.md abandona su raíz");
  const temporary = join(directory, `.SKILL.md.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(temporary, content);
  renameSync(temporary, destination);
  return readSkill(ref);
}

function archiveFiles(root: string, directory: string, baseDirectory: string = directory): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) continue; // never follow a symlink into an archive
    if (stat.isDirectory()) files.push(...archiveFiles(root, absolute, baseDirectory));
    else if (stat.isFile()) {
      const real = realpathSync(absolute);
      if (!inside(root, real)) throw new SkillError("SKILL_PATH_OUTSIDE_ROOT", "un archivo de la skill abandona la raíz");
      files.push(relative(baseDirectory, absolute));
    }
  }
  return files;
}

/** Build a portable ZIP from regular files only; returned bytes are sent by the HTTP handler. */
export async function archiveSkill(raw: Partial<SkillRef>): Promise<{ filename: string; bytes: Buffer }> {
  const ref = normalizedRef(raw);
  const { root, directory } = skillDirectory(ref);
  readSkill(ref); // invalid frontmatter must not be distributed
  const files = archiveFiles(root, directory);
  const output = join(tmpdir(), `cowork-skill-${ref.name}-${process.pid}-${Date.now()}.zip`);
  try {
    await exec("zip", ["-q", output, ...files], { cwd: directory });
    return { filename: `${basename(directory)}.zip`, bytes: readFileSync(output) };
  } finally {
    rmSync(output, { force: true });
  }
}
