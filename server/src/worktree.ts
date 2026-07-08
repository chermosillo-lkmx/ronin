import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

/**
 * P1: per-worker git worktree isolation. Two concurrent workers over the same repo would
 * otherwise write to the same working tree (the article's failure mode #1). Each live task
 * worker gets an ephemeral worktree on a `cowork/<session>` branch, cleaned up on
 * completion/stop UNLESS it holds uncommitted or committed-but-unmerged work.
 *
 * Everything here is best-effort and never throws on cleanup — a stuck worktree is a visible
 * note, never a crashed launch. Git ops are serialized per shared `.git` (git-common-dir),
 * because in this monorepo many repo *names* resolve to the SAME root (repos.ts _default).
 */

const pexec = promisify(execFile);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec("git", ["-C", cwd, ...args]);
  return stdout;
}

/** True if `dir` is inside a git working tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the shared `.git` (common dir) — the correct serialization key (P1a). */
export async function gitCommonDir(dir: string): Promise<string | null> {
  try {
    const p = (await git(dir, ["rev-parse", "--git-common-dir"])).trim();
    return isAbsolute(p) ? p : join(dir, p);
  } catch {
    return null;
  }
}

/** Ephemeral branch name for a session. */
export function branchForSession(session: string): string {
  return `cowork/${session}`;
}

/**
 * Base dir for ephemeral worktrees. Read at CALL time (not module-eval) so tests can point it at a
 * temp dir via COWORK_WORKTREE_HOME and never touch the user's real ~/.cowork.
 */
function worktreeHome(): string {
  return process.env.COWORK_WORKTREE_HOME || join(homedir(), ".cowork", "worktrees");
}

/**
 * Deterministic worktree path from (repoRoot, session), OUTSIDE the user's code tree
 * (<worktreeHome>/<hash(repoRoot)>/<session>) so it's always writable and never dirties ~/code.
 * Deterministic so rediscoverSessions can rebuild the cwd after a restart (P1c/P1-1).
 */
export function worktreePathForSession(repoRoot: string, session: string): string {
  const h = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
  return join(worktreeHome(), h, session);
}

export function worktreeExists(path: string): boolean {
  return existsSync(path);
}

// ---- per-common-dir serialization (in-proc queue + cross-proc disk lock) ----

const queues = new Map<string, Promise<unknown>>();

async function acquireDiskLock(lockDir: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      mkdirSync(lockDir); // atomic O_EXCL-style: fails if it already exists
      return true;
    } catch {
      // Steal a clearly-stale lock (older than 60s → a crashed holder).
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 60_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* gone between calls */
      }
      await delay(100);
    }
  }
  return false; // couldn't acquire in ~5s → proceed degraded (P1b: mitigated cross-proc, not eliminated)
}

async function withGitLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = (await gitCommonDir(repoRoot)) ?? repoRoot;
  const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
    const lockDir = `${key}.cowork-lock`;
    const got = await acquireDiskLock(lockDir);
    try {
      return await fn();
    } finally {
      if (got) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  });
  queues.set(key, run.then(() => {}, () => {})); // keep the chain alive even if fn rejects
  return run;
}

// ---- add / remove ----

/** True if a local branch ref exists. */
async function refExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await git(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a worktree at `path` on a fresh `branch`. Reconciles a leaked dir/branch from a
 * prior crash first (P1d — `worktree prune` alone doesn't reclaim a dir that still exists),
 * so a re-add with the same deterministic names is clean instead of failing "already exists".
 *
 * CRITICAL: the reconcile applies the SAME dirty-guard as removeWorktree — a leaked worktree
 * with uncommitted changes or commits on its branch is NEVER destroyed (a relaunch of the same
 * task computes the identical deterministic path/branch, so an unguarded force-remove here
 * would delete exactly the work removeWorktree/reconcile just preserved). If it's dirty we
 * throw → launchLive falls back to the repo root with a visible note, leaving the work intact.
 *
 * Serialized per common-dir. Throws on a dirty leak or a genuine add failure → caller handles.
 */
export async function addWorktree(repoRoot: string, path: string, branch: string): Promise<void> {
  await withGitLock(repoRoot, async () => {
    const pathExists = existsSync(path);
    const branchExists = await refExists(repoRoot, branch);
    if (pathExists || branchExists) {
      const dirty =
        (pathExists && (await hasUncommitted(path))) || (branchExists && (await hasUniqueCommits(repoRoot, branch)));
      if (dirty) {
        throw new Error(`worktree/rama fugada con trabajo sin integrar (${branch}) — conservada, no se recrea`);
      }
      // Clean leak → safe to reclaim.
      if (pathExists) {
        await git(repoRoot, ["worktree", "remove", "--force", path]).catch(() => {});
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      }
      await git(repoRoot, ["worktree", "prune"]).catch(() => {});
      if (branchExists) await git(repoRoot, ["branch", "-D", branch]).catch(() => {});
    } else {
      await git(repoRoot, ["worktree", "prune"]).catch(() => {});
    }
    mkdirSync(dirname(path), { recursive: true });
    try {
      await git(repoRoot, ["worktree", "add", path, "-b", branch]);
    } catch (e) {
      // P1 pt4: a partial add can leave a registered worktree/branch behind — clean it before rethrow.
      await git(repoRoot, ["worktree", "prune"]).catch(() => {});
      await git(repoRoot, ["branch", "-D", branch]).catch(() => {});
      if (existsSync(path)) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      throw e;
    }
  });
}

/** Uncommitted (staged/unstaged/untracked) changes in the worktree. */
async function hasUncommitted(path: string): Promise<boolean> {
  try {
    return (await git(path, ["status", "--porcelain"])).trim().length > 0;
  } catch {
    return true; // can't inspect → treat as dirty (never delete blindly)
  }
}

/** Commits on `branch` not reachable from any OTHER local branch (real work to preserve). */
async function hasUniqueCommits(repoRoot: string, branch: string): Promise<boolean> {
  try {
    // Enumerate other branch refs explicitly — `--exclude=<glob> --branches` doesn't reliably
    // drop our own branch across git versions, which would subtract the branch from itself → 0.
    const refs = (await git(repoRoot, ["for-each-ref", "--format=%(refname)", "refs/heads/"]))
      .split("\n")
      .map((r) => r.trim())
      .filter((r) => r && r !== `refs/heads/${branch}`);
    const out = await git(repoRoot, ["rev-list", "--count", branch, "--not", ...refs]);
    return Number(out.trim()) > 0; // no other refs → all commits are "unique" → preserve (conservative)
  } catch {
    return true; // unknown → preserve
  }
}

/**
 * Remove a clean worktree + its ephemeral branch. If the worktree has uncommitted changes OR
 * unique commits on its branch, it is KEPT (returns {kept:true}) — never silently deleted
 * (P1-2). Never throws.
 */
export async function removeWorktree(
  repoRoot: string,
  path: string,
  branch: string
): Promise<{ removed: boolean; kept: boolean }> {
  return withGitLock(repoRoot, async () => {
    const dirty = (existsSync(path) && (await hasUncommitted(path))) || (await hasUniqueCommits(repoRoot, branch));
    if (dirty) return { removed: false, kept: true };
    if (existsSync(path)) {
      await git(repoRoot, ["worktree", "remove", "--force", path]).catch(() => {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      });
    }
    await git(repoRoot, ["worktree", "prune"]).catch(() => {});
    await git(repoRoot, ["branch", "-D", branch]).catch(() => {});
    rmdirEmptyParent(path); // clean the now-empty <hash> dir (issue 2a — don't leak empty dirs)
    return { removed: true, kept: false };
  });
}

/** rmdir the immediate parent dir ONLY if it's now empty (best-effort; ignores non-empty/errors). */
function rmdirEmptyParent(path: string): void {
  try {
    rmdirSync(dirname(path)); // throws ENOTEMPTY if other worktrees still live there → ignored
  } catch {
    /* non-empty or already gone */
  }
}

// ---- startup reconcile (P1-5) ----

interface CoworkWt {
  path: string;
  branch: string;
  session: string;
}

/** Parse `git worktree list --porcelain`, returning only our `cowork/*` worktrees. */
export async function listCoworkWorktrees(repoRoot: string): Promise<CoworkWt[]> {
  let out = "";
  try {
    out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const wts: CoworkWt[] = [];
  let path = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim(); // refs/heads/cowork/<session>
      const m = ref.match(/^refs\/heads\/cowork\/(.+)$/);
      if (m && path) wts.push({ path, branch: `cowork/${m[1]}`, session: m[1] });
    }
  }
  return wts;
}

/**
 * Remove leaked worktrees whose tmux session is no longer live (crash cleanup), honoring the
 * dirty guard. `liveSessions` are the currently-live `cowork-*` session names. Best-effort.
 */
export async function reconcileWorktrees(repoRoot: string, liveSessions: Set<string>): Promise<number> {
  let removed = 0;
  for (const wt of await listCoworkWorktrees(repoRoot)) {
    if (liveSessions.has(wt.session)) continue; // still in use
    const res = await removeWorktree(repoRoot, wt.path, wt.branch).catch(() => ({ removed: false, kept: false }));
    if (res.removed) removed++;
  }
  return removed;
}
