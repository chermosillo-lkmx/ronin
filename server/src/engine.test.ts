import { strict as assert } from "node:assert";
import { test } from "node:test";

// engine.ts initializes activeMode from COWORK_MODE (default "simulated") at import — safe,
// no server/tmux side effects until start() is called.
const { applyContextPressure, launchAdhoc, owningSession, stopWorker, worktreeReferencedByOthers } =
  await import("./engine.js");
type W = { id: string; worktree?: string };

test("owningSession: strips the verifier suffix to find the parent (P1g)", () => {
  assert.equal(owningSession("cowork-CU-123"), "cowork-CU-123");
  assert.equal(owningSession("cowork-CU-123-verify"), "cowork-CU-123");
  assert.equal(owningSession("cowork-CU-123-verify-2"), "cowork-CU-123");
  assert.equal(owningSession("cowork-CU-123-action-review-verify"), "cowork-CU-123-action-review");
  // a task whose key legitimately ends in "verify" is only stripped at the suffix boundary
  assert.equal(owningSession("cowork-verify-login"), "cowork-verify-login");
});

test("worktreeReferencedByOthers: a verifier sharing the parent's worktree keeps it alive (refcount, P1-6)", () => {
  const wt = "/home/u/.cowork/worktrees/abc/cowork-CU-1";
  const main = { id: "w1", worktree: wt };
  const verifier = { id: "v1", worktree: wt }; // inherited the parent's worktree
  const all: W[] = [main, verifier];
  // Tearing down the MAIN worker: the verifier still references the worktree → keep it.
  assert.equal(worktreeReferencedByOthers(all as any, main.id, wt), true);
  // Once the verifier is gone, nothing else references it → safe to remove.
  assert.equal(worktreeReferencedByOthers([main] as any, main.id, wt), false);
  // A worker never counts itself.
  assert.equal(worktreeReferencedByOthers([main] as any, main.id, wt), false);
});

test("applyContextPressure: change-gated set + clear-on-disappearance (P4)", () => {
  const worker: any = { id: "w1" };
  // first detection → changed
  assert.equal(applyContextPressure(worker, "Run /clear to save 45k tokens\n› "), true);
  assert.equal(worker.contextPressure.tokens, 45);
  // same pane again → NOT changed (no SSE churn / log spam)
  assert.equal(applyContextPressure(worker, "Run /clear to save 45k tokens\n› "), false);
  // signal leaves the recent lines → cleared, and that's a change
  assert.equal(applyContextPressure(worker, "just working\n› "), true);
  assert.equal(worker.contextPressure, undefined);
  // still clear → not a change
  assert.equal(applyContextPressure(worker, "still working\n› "), false);
});

test("simulated mode: a launched worker touches NO git worktree and NO tmux session (P1-8)", async () => {
  const w = await launchAdhoc("hacer algo simulado", "sim task", "monorepo");
  try {
    assert.ok(w);
    assert.equal(w!.session, undefined);  // no tmux session
    assert.equal(w!.worktree, undefined); // no git worktree → simulated never touches git
    assert.equal(w!.cwd, undefined);
  } finally {
    if (w) await stopWorker(w.id);
  }
});
