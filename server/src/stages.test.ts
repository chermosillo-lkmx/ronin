import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureCycleDir,
  lastSentinelAt,
  markModelSwitched,
  markModelSwitchFailed,
  markVerifierSpawned,
  modelSwitched,
  modelSwitchFailed,
  parseParkedLimit,
  readDriverInfo,
  readModelsInfo,
  readSentinelsTail,
  readVerifyState,
  removeCycleDir,
  verifierSpawned,
  verifyPassed,
  writeModelsInfo,
  writeDriverInfo,
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

// ---- Modo Driver: reviewTool persistido (artefacto de auditoría post-mortem) ----

test("writeDriverInfo/readDriverInfo: round-trip del reviewTool", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    writeDriverInfo(cycle, { reviewTool: "agent" });
    assert.deepEqual(readDriverInfo(cycle), { reviewTool: "agent" });
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("readDriverInfo: null si no existe o si el JSON está corrupto (nunca lanza)", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(readDriverInfo(cycle), null);
    writeFileSync(join(cycle, "driver.json"), "{no es json");
    assert.equal(readDriverInfo(cycle), null);
    writeFileSync(join(cycle, "driver.json"), JSON.stringify({ reviewTool: 42 }));
    assert.equal(readDriverInfo(cycle), null);
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("readDriverInfo: un dir inexistente devuelve null sin lanzar", () => {
  assert.equal(readDriverInfo("/tmp/no-existe-cowork-xyz"), null);
});

// ---- Modo Driver: detección del auto-parqueo por límite de uso ----
// Se lee de sentinels.log, NO del pane: el propio skill documenta que raspar el pane fue el
// modo de falla v6 (los sentinels largos se parten en un pane angosto del layout 2×2).

const PARKED = "===WORKER-PARKED-LIMIT:12:30am===";

test("parseParkedLimit: extrae la hora de reset del último sentinel", () => {
  const log = ["===PLAN-READY:/tmp/x/plan.md===", "===IMPL-READY===", PARKED].join("\n");
  assert.deepEqual(parseParkedLimit(log), { resetAt: "12:30am" });
});

test("parseParkedLimit: parqueo sin hora conocida sigue siendo un parqueo", () => {
  assert.deepEqual(parseParkedLimit("===WORKER-PARKED-LIMIT:unknown==="), { resetAt: "unknown" });
  assert.deepEqual(parseParkedLimit("===WORKER-PARKED-LIMIT:==="), {});
});

// Ésta es la razón de mirar sólo el ÚLTIMO sentinel: un RESUME posterior limpia el estado
// solo, sin necesitar un latch ni una ruta de "despark".
test("parseParkedLimit: null si tras el parqueo hay un sentinel posterior (RESUME)", () => {
  const log = [PARKED, "===IMPL-UPDATED==="].join("\n");
  assert.equal(parseParkedLimit(log), null);
});

test("parseParkedLimit: null para un log vacío o sin parqueos", () => {
  assert.equal(parseParkedLimit(""), null);
  assert.equal(parseParkedLimit("===PLAN-READY:/tmp/x/plan.md===\n"), null);
});

test("parseParkedLimit: tolera espacios y líneas en blanco alrededor", () => {
  assert.deepEqual(parseParkedLimit(`\n  ${PARKED}  \n\n`), { resetAt: "12:30am" });
});

test("readSentinelsTail: '' cuando no hay log, contenido cuando sí (nunca lanza)", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    assert.equal(readSentinelsTail(cycle), "");
    writeFileSync(join(cycle, "sentinels.log"), PARKED + "\n");
    assert.match(readSentinelsTail(cycle), /WORKER-PARKED-LIMIT/);
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("lastSentinelAt: mtime del sentinel de etapa más reciente, null si no hay ninguno", () => {
  const cycle = freshCycle();
  try {
    ensureCycleDir(cycle);
    const order = ["planning", "implementing", "done"];
    assert.equal(lastSentinelAt(cycle, order), null);
    writeFileSync(join(cycle, "planning"), "");
    const at = lastSentinelAt(cycle, order);
    assert.equal(typeof at, "number");
    // Sembrar lastProgressAt con esto (y no con Date.now()) es lo que evita que un reinicio
    // del server borre un atasco real de horas.
    assert.ok(at! <= Date.now() + 1000);
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});
