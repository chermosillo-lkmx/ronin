// Primitivas de caché por commit del gate de pruebas unitarias: HEAD y suciedad de cada sub-repo
// de un worktree, y si un PASS guardado sigue cubriendo los HEADs actuales (mismos SHAs, o commits
// posteriores que sólo tocan rutas e2e).
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { VerifyState } from "./stages.js";

export interface RepoHead {
  repo: string;
  sha: string;
  dirty: boolean;
}

export interface GitPort {
  run(args: string[], cwd: string): Promise<{ ok: boolean; out: string }>;
}

export const realGitPort: GitPort = {
  run: (args, cwd) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
        resolve({ ok: !err, out: String(stdout ?? "") }),
      );
    }),
};

// Mismo criterio que scripts/unit-gate.sh: `.git` (dir o archivo) y además `tests/` o `package.json`.
function isGateRepo(dir: string): boolean {
  return existsSync(join(dir, ".git")) && (existsSync(join(dir, "tests")) || existsSync(join(dir, "package.json")));
}

function subRepos(worktree: string): string[] {
  const out: string[] = [];
  if (isGateRepo(worktree)) out.push(worktree);
  let names: string[] = [];
  try {
    names = readdirSync(worktree, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .sort();
  } catch {
    /* sin listado: sólo el propio worktree, si aplica */
  }
  for (const n of names) {
    if (n.endsWith("-base") || n === "node_modules" || n === "reports" || n.startsWith(".")) continue;
    const d = join(worktree, n);
    if (isGateRepo(d)) out.push(d);
  }
  return out;
}

const inReports = (p: string): boolean => p === "reports" || p.startsWith("reports/");

// Rutas de una línea de `git status --porcelain`: «XY path» o «XY old -> new».
function statusPaths(line: string): string[] {
  const body = line.slice(3);
  return body.includes(" -> ") ? body.split(" -> ") : [body];
}

// reports/ se ignora sólo para untracked («??», lo que escribe el gate); un archivo trackeado
// modificado bajo reports/ puede ser código de producto y sí ensucia.
function isDirty(porcelain: string): boolean {
  return porcelain
    .split("\n")
    .filter((l) => l.trim() !== "")
    .some((l) => {
      if (!l.startsWith("??")) return true;
      return statusPaths(l).some((p) => !inReports(p.replace(/^"|"$/g, "")));
    });
}

/** HEAD y suciedad de cada sub-repo del worktree; `null` si algún comando git falla. */
export async function repoHeads(worktree: string, git: GitPort): Promise<RepoHead[] | null> {
  const heads: RepoHead[] = [];
  for (const dir of subRepos(worktree)) {
    const rev = await git.run(["rev-parse", "HEAD"], dir);
    if (!rev.ok || rev.out.trim() === "") return null;
    const st = await git.run(["status", "--porcelain", "--untracked-files=all"], dir);
    if (!st.ok) return null;
    heads.push({ repo: basename(dir), sha: rev.out.trim(), dirty: isDirty(st.out) });
  }
  return heads;
}

const normDir = (p: string): string => p.replace(/\/+$/, "") + "/";

/**
 * `true` sólo si el PASS guardado cubre los HEADs actuales: mismo conjunto de sub-repos y, por
 * cada uno, el mismo SHA o un diff cacheado→actual cuyas rutas son todas e2e. Todo error → false.
 */
export async function cacheHit(
  cached: VerifyState | null,
  heads: RepoHead[],
  git: GitPort,
  worktree: string,
  e2eDirs: string[],
): Promise<boolean> {
  if (heads.length === 0) return false;
  if (!cached || cached.status !== "passed" || !cached.shas) return false;
  const shas = cached.shas;
  if (Object.keys(shas).length !== heads.length) return false;
  const prefixes = e2eDirs.map(normDir);
  for (const h of heads) {
    if (!Object.hasOwn(shas, h.repo)) return false;
    const prev = shas[h.repo];
    // Defensa en profundidad: el SHA guardado llega a git, así que debe ser hex puro.
    if (typeof prev !== "string" || !/^[0-9a-f]{40,64}$/.test(prev)) return false;
    if (prev === h.sha) continue;
    // El cwd del sub-repo: el propio worktree si es repo, si no el hijo con ese nombre.
    const cwd = basename(worktree) === h.repo && isGateRepo(worktree) ? worktree : join(worktree, h.repo);
    // --no-renames: un renombre no debe esconder el borrado de código de producto.
    const d = await git.run(["diff", "--name-only", "--no-renames", "--end-of-options", prev, h.sha], cwd);
    if (!d.ok) return false;
    const files = d.out.split("\n").filter((l) => l.trim() !== "");
    if (!files.every((f) => prefixes.some((p) => f.startsWith(p)))) return false;
  }
  return true;
}
