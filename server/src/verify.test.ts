import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runVerify, verifyOutcome, verifyRunDecision } from "./verify.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("verifyRunDecision: paces retries by the worker's busy/idle cycle (survives restart)", () => {
  // first attempt (no state): idle → run
  assert.equal(verifyRunDecision(false, 0, false), "run");
  // busy first time → skip (never verify mid-work)
  assert.equal(verifyRunDecision(true, 0, false), "skip");
  // after a fail, restart drops in-memory arming → idle+attempts>0+unarmed → SKIP (no double-run)
  assert.equal(verifyRunDecision(false, 1, false), "skip");
  // worker goes busy (fixing) → ARM the retry
  assert.equal(verifyRunDecision(true, 1, false), "arm");
  // worker idle again + armed → run the retry once
  assert.equal(verifyRunDecision(false, 1, true), "run");
});

test("verifyOutcome: pass → passed (advance)", () => {
  assert.deepEqual(verifyOutcome(true, 0, 2), { attempts: 0, status: "passed" });
});

test("verifyOutcome: fail with retries left → pending (retry)", () => {
  assert.deepEqual(verifyOutcome(false, 0, 2), { attempts: 1, status: "pending" });
});

test("verifyOutcome: fail exhausting the limit → failed (held, no false-green)", () => {
  assert.deepEqual(verifyOutcome(false, 1, 2), { attempts: 2, status: "failed" });
});

test("verifyOutcome: maxRetries=0 → first fail is terminal", () => {
  assert.deepEqual(verifyOutcome(false, 0, 0), { attempts: 1, status: "failed" });
});

test("runVerify: exit 0 → ok", async () => {
  const r = await runVerify("exit 0", process.cwd());
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
});

test("runVerify: non-zero exit → not ok, code captured", async () => {
  const r = await runVerify("exit 3", process.cwd());
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
});

test("runVerify: captures stdout + stderr in output", async () => {
  const r = await runVerify("echo out; echo err 1>&2; exit 1", process.cwd());
  assert.equal(r.ok, false);
  assert.match(r.output, /out/);
  assert.match(r.output, /err/);
});

test("runVerify: timeout → not ok (default-deny), kills the process group", async () => {
  const start = Date.now();
  const r = await runVerify("sleep 5", process.cwd(), 250);
  assert.equal(r.ok, false); // never a false-green on timeout
  assert.ok(Date.now() - start < 3000); // returned promptly, didn't wait the full 5s
});

test("runVerify: a missing cwd → not ok (default-deny), never throws", async () => {
  const r = await runVerify("echo hi", "/nonexistent/dir/xyz");
  assert.equal(r.ok, false);
});

test("runVerify: timeout kills the whole process GROUP — a backgrounded grandchild dies too (D2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-gc-"));
  const marker = join(dir, "grandchild-ran");
  try {
    // A backgrounded grandchild that would touch the marker after 2s. If only the shell were
    // killed, the detached grandchild survives and the marker appears; group-kill prevents it.
    await runVerify(`(sleep 2 && touch ${marker}) & wait`, dir, 300);
    await delay(2500); // wait past when the grandchild would have fired
    assert.equal(existsSync(marker), false); // grandchild was killed with the group
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
