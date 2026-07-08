import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureCycleDir,
  markModelSwitched,
  markModelSwitchFailed,
  markVerifierSpawned,
  modelSwitched,
  modelSwitchFailed,
  readModelsInfo,
  readVerifyState,
  removeCycleDir,
  verifierSpawned,
  verifyPassed,
  writeModelsInfo,
  writeVerifyState,
} from "./stages.js";

function freshCycle(): string {
  return mkdtempSync(join(tmpdir(), "cowork-cycle-test-"));
}

test("writeModelsInfo/readModelsInfo: round-trips worker + switchEnabled", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    writeModelsInfo(cycle, { worker: "sonnet", switchEnabled: true });
    assert.deepEqual(readModelsInfo(cycle), { worker: "sonnet", switchEnabled: true });

    writeModelsInfo(cycle, { worker: "opus", switchEnabled: false });
    assert.deepEqual(readModelsInfo(cycle), { worker: "opus", switchEnabled: false });
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("readModelsInfo: null when absent", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(readModelsInfo(cycle), null);
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("markModelSwitched/modelSwitched: latch is set and detected", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(modelSwitched(cycle), false);
    markModelSwitched(cycle);
    assert.equal(modelSwitched(cycle), true);
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("markModelSwitchFailed/modelSwitchFailed: separate give-up latch", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(modelSwitchFailed(cycle), false);
    markModelSwitchFailed(cycle);
    assert.equal(modelSwitchFailed(cycle), true);
    assert.equal(modelSwitched(cycle), false); // give-up is NOT success
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("F3: a fresh launch (removeCycleDir + ensureCycleDir) clears a stale switch latch", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    markModelSwitched(cycle);
    writeModelsInfo(cycle, { worker: "sonnet", switchEnabled: true });
    assert.equal(modelSwitched(cycle), true);

    // launchLive does exactly this on a fresh launch reusing the same deterministic path:
    removeCycleDir(cycle);
    ensureCycleDir(cycle);

    assert.equal(modelSwitched(cycle), false); // stale latch gone
    assert.equal(readModelsInfo(cycle), null); // stale models.json gone
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("P1h: verifier-spawned latch is set + detected (survives restart in the cycle dir)", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(verifierSpawned(cycle), false);
    markVerifierSpawned(cycle);
    assert.equal(verifierSpawned(cycle), true); // a rediscovered parent sees this → no 2nd verifier
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("P2: verify state round-trips per stage + verifyPassed reflects status (survives restart)", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(readVerifyState(cycle, "curl"), null);
    assert.equal(verifyPassed(cycle, "curl"), false);

    writeVerifyState(cycle, "curl", { attempts: 1, status: "pending" });
    assert.deepEqual(readVerifyState(cycle, "curl"), { attempts: 1, status: "pending" });
    assert.equal(verifyPassed(cycle, "curl"), false);

    writeVerifyState(cycle, "curl", { attempts: 1, status: "passed" });
    assert.equal(verifyPassed(cycle, "curl"), true);

    // distinct stages are independent
    writeVerifyState(cycle, "build", { attempts: 2, status: "failed" });
    assert.equal(readVerifyState(cycle, "build")!.status, "failed");
    assert.equal(verifyPassed(cycle, "build"), false);
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("F3: rediscovery (no removeCycleDir) PRESERVES the latch across a restart", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    markModelSwitched(cycle);
    // rediscoverSessions rebuilds the worker but never wipes the cycle dir → latch survives.
    assert.equal(modelSwitched(cycle), true);
    assert.ok(existsSync(join(cycle, "model-switched")));
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});
