import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  addWorktree,
  branchForSession,
  gitCommonDir,
  isGitRepo,
  removeWorktree,
  worktreePathForSession,
} from "./worktree.js";

const pexec = promisify(execFile);

// Point worktrees at a throwaway home so tests NEVER write to the user's real ~/.cowork.
// worktreePathForSession reads COWORK_WORKTREE_HOME at call time, so setting it here suffices.
const WT_HOME = mkdtempSync(join(tmpdir(), "cowork-wt-home-"));
process.env.COWORK_WORKTREE_HOME = WT_HOME;
test.after(() => rmSync(WT_HOME, { recursive: true, force: true }));

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cowork-repo-"));
  await pexec("git", ["-C", dir, "init", "-q"]);
  await pexec("git", ["-C", dir, "config", "user.email", "t@t.io"]);
  await pexec("git", ["-C", dir, "config", "user.name", "t"]);
  await pexec("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  await pexec("git", ["-C", dir, "add", "-A"]);
  await pexec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("isGitRepo: true for a repo, false for a plain dir", async () => {
  const repo = await makeRepo();
  const plain = mkdtempSync(join(tmpdir(), "cowork-plain-"));
  try {
    assert.equal(await isGitRepo(repo), true);
    assert.equal(await isGitRepo(plain), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});

test("worktreePathForSession: deterministic from repoRoot + session", () => {
  const a = worktreePathForSession("/some/repo", "cowork-CU-1");
  const b = worktreePathForSession("/some/repo", "cowork-CU-1");
  const c = worktreePathForSession("/some/repo", "cowork-CU-2");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.includes("cowork-CU-1")); // session is the leaf
});

test("addWorktree: creates the path + the ephemeral branch", async () => {
  const repo = await makeRepo();
  const session = "cowork-add-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch);
    assert.ok(existsSync(wt));
    assert.ok(existsSync(join(wt, "README.md")));
    const { stdout } = await pexec("git", ["-C", repo, "branch", "--list", branch]);
    assert.ok(stdout.includes(branch));
  } finally {
    await removeWorktree(repo, wt, branch).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree: clean worktree → removed, path + branch gone, empty <hash> parent cleaned", async () => {
  const repo = await makeRepo();
  const session = "cowork-rm-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch);
    const res = await removeWorktree(repo, wt, branch);
    assert.equal(res.removed, true);
    assert.equal(res.kept, false);
    assert.equal(existsSync(wt), false);
    assert.equal(existsSync(dirname(wt)), false); // issue 2a: the now-empty <hash> dir is removed too
    const { stdout } = await pexec("git", ["-C", repo, "branch", "--list", branch]);
    assert.equal(stdout.trim(), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree: does NOT remove the <hash> parent while a sibling worktree still lives there", async () => {
  const repo = await makeRepo();
  const [sA, sB] = ["cowork-sib-a", "cowork-sib-b"];
  const [wtA, wtB] = [worktreePathForSession(repo, sA), worktreePathForSession(repo, sB)];
  try {
    await addWorktree(repo, wtA, branchForSession(sA));
    await addWorktree(repo, wtB, branchForSession(sB)); // same repo → same <hash> parent
    await removeWorktree(repo, wtA, branchForSession(sA));
    assert.equal(existsSync(wtB), true); // sibling intact
    assert.equal(existsSync(dirname(wtB)), true); // parent kept (not empty)
  } finally {
    await removeWorktree(repo, wtB, branchForSession(sB)).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree: UNCOMMITTED changes → kept, not deleted (no borres lo que no creaste)", async () => {
  const repo = await makeRepo();
  const session = "cowork-dirty-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch);
    writeFileSync(join(wt, "wip.txt"), "unsaved work\n"); // untracked change
    const res = await removeWorktree(repo, wt, branch);
    assert.equal(res.kept, true);
    assert.equal(res.removed, false);
    assert.ok(existsSync(wt)); // preserved
  } finally {
    // force cleanup for the test only
    await pexec("git", ["-C", repo, "worktree", "remove", "--force", wt]).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree: COMMITTED work on the ephemeral branch → kept (unique commits preserved)", async () => {
  const repo = await makeRepo();
  const session = "cowork-committed-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch);
    writeFileSync(join(wt, "feature.txt"), "done\n");
    await pexec("git", ["-C", wt, "add", "-A"]);
    await pexec("git", ["-C", wt, "commit", "-q", "-m", "feature"]);
    const res = await removeWorktree(repo, wt, branch);
    assert.equal(res.kept, true);
    assert.ok(existsSync(wt));
  } finally {
    await pexec("git", ["-C", repo, "worktree", "remove", "--force", wt]).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("addWorktree: reconciles a leaked dir + branch from a prior crash (re-add is clean, no throw)", async () => {
  const repo = await makeRepo();
  const session = "cowork-leak-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch); // first
    // simulate crash: worktree dir + branch still around, tmux session gone → re-add same names
    await addWorktree(repo, wt, branch); // must not throw ("already exists")
    assert.ok(existsSync(wt));
  } finally {
    await removeWorktree(repo, wt, branch).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("addWorktree: a leaked DIRTY worktree at the deterministic path is NOT destroyed (point 1 — data loss)", async () => {
  const repo = await makeRepo();
  const session = "cowork-leak-dirty-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch);
    writeFileSync(join(wt, "unsaved.txt"), "precious uncommitted work\n"); // dirty leak
    // A relaunch of the same task computes the SAME path/branch. addWorktree must refuse to
    // destroy the dirty leak (throws → launchLive falls back to root), preserving the work.
    await assert.rejects(() => addWorktree(repo, wt, branch));
    assert.ok(existsSync(join(wt, "unsaved.txt"))); // still there — NOT deleted
  } finally {
    await pexec("git", ["-C", repo, "worktree", "remove", "--force", wt]).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("addWorktree: a leaked worktree with COMMITTED work is NOT destroyed either (point 1)", async () => {
  const repo = await makeRepo();
  const session = "cowork-leak-committed-1";
  const wt = worktreePathForSession(repo, session);
  const branch = branchForSession(session);
  try {
    await addWorktree(repo, wt, branch);
    writeFileSync(join(wt, "feat.txt"), "done\n");
    await pexec("git", ["-C", wt, "add", "-A"]);
    await pexec("git", ["-C", wt, "commit", "-q", "-m", "feat"]);
    await assert.rejects(() => addWorktree(repo, wt, branch)); // must not blow away the commit
    assert.ok(existsSync(join(wt, "feat.txt")));
  } finally {
    await pexec("git", ["-C", repo, "worktree", "remove", "--force", wt]).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gitCommonDir: a subdir/worktree resolves to the SAME common dir as the root (P1a keying)", async () => {
  const repo = await makeRepo();
  const session = "cowork-common-1";
  const wt = worktreePathForSession(repo, session);
  try {
    await addWorktree(repo, wt, branchForSession(session));
    const rootCommon = await gitCommonDir(repo);
    const wtCommon = await gitCommonDir(wt);
    assert.ok(rootCommon && wtCommon);
    // compare real paths (macOS /var → /private/var symlink); same underlying .git → one lock key
    assert.equal(realpathSync(wtCommon!), realpathSync(rootCommon!));
  } finally {
    await removeWorktree(repo, wt, branchForSession(session)).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("concurrent addWorktree on the SAME repo root serialize (no index.lock failure)", async () => {
  const repo = await makeRepo();
  const sessions = ["cowork-c-1", "cowork-c-2", "cowork-c-3"];
  const wts = sessions.map((s) => worktreePathForSession(repo, s));
  try {
    // launched concurrently — the per-common-dir lock must serialize them
    await Promise.all(sessions.map((s) => addWorktree(repo, worktreePathForSession(repo, s), branchForSession(s))));
    for (const wt of wts) assert.ok(existsSync(wt));
  } finally {
    for (const s of sessions) await removeWorktree(repo, worktreePathForSession(repo, s), branchForSession(s)).catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});
