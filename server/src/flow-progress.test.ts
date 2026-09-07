import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFlowProgress } from "./flow-progress.js";
import type { WorkflowConfig } from "./workflow.js";

const FLUJO: WorkflowConfig = {
  stages: [
    { key: "planning", label: "Plan", icon: "📋", instruction: "…", executor: "claude" },
    { key: "implementing", label: "Impl", icon: "🤖", instruction: "…", executor: "codex" },
    { key: "tests", label: "Pruebas", icon: "✅", instruction: "…" },
    { key: "done", label: "Evidencia", icon: "✓", instruction: "…" },
  ],
};

function cicloTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-progress-"));
  writeFileSync(join(dir, "flow.json"), JSON.stringify(FLUJO));
  return dir;
}

/** Toca un centinela con un mtime concreto, como haría el agente al cerrar la etapa. */
function centinela(dir: string, key: string, at: number): void {
  writeFileSync(join(dir, key), "");
  utimesSync(join(dir, key), at / 1000, at / 1000);
}

test("readFlowProgress: cumplidas por centinela, en curso la primera sin él", () => {
  const dir = cicloTemporal();
  try {
    centinela(dir, "planning", 1_700_000_000_000);
    centinela(dir, "implementing", 1_700_000_600_000);

    const flujo = readFlowProgress(dir)!;
    assert.deepEqual(flujo.stages.map((s) => s.status), ["done", "done", "current", "pending"]);
    assert.equal(flujo.done, 2);
    assert.equal(flujo.total, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: la etapa cumplida lleva el mtime de su centinela", () => {
  const dir = cicloTemporal();
  try {
    centinela(dir, "planning", 1_700_000_000_000);
    const flujo = readFlowProgress(dir)!;
    assert.equal(flujo.stages[0]!.at, 1_700_000_000_000);
    // La que está en curso empezó cuando terminó la anterior: ese es el reloj honesto.
    assert.equal(flujo.stages[1]!.at, 1_700_000_000_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: sin ningún centinela, la primera etapa es la que está en curso", () => {
  const dir = cicloTemporal();
  try {
    const flujo = readFlowProgress(dir)!;
    assert.deepEqual(flujo.stages.map((s) => s.status), ["current", "pending", "pending", "pending"]);
    assert.equal(flujo.done, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: con todas cumplidas no queda ninguna en curso", () => {
  const dir = cicloTemporal();
  try {
    for (const [i, k] of ["planning", "implementing", "tests", "done"].entries())
      centinela(dir, k, 1_700_000_000_000 + i * 60_000);

    const flujo = readFlowProgress(dir)!;
    assert.deepEqual(flujo.stages.map((s) => s.status), ["done", "done", "done", "done"]);
    assert.equal(flujo.done, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: una verificación fallida marca la etapa en curso, no la tumba entera", () => {
  const dir = cicloTemporal();
  try {
    centinela(dir, "planning", 1_700_000_000_000);
    centinela(dir, "implementing", 1_700_000_600_000);
    writeFileSync(join(dir, "verify-tests.json"), JSON.stringify({ attempts: 2, status: "failed" }));

    const flujo = readFlowProgress(dir)!;
    assert.equal(flujo.stages[2]!.status, "failed");
    assert.equal(flujo.stages[2]!.attempts, 2);
    assert.equal(flujo.stages[3]!.status, "pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: una etapa saltada se queda gris, no se pinta como cumplida", () => {
  // El agente toca los centinelas en orden, pero puede saltarse uno. Pintarlo verde afirmaría
  // que corrió; dejarlo gris encima de una verde se ve raro y es la verdad.
  const dir = cicloTemporal();
  try {
    centinela(dir, "planning", 1_700_000_000_000);
    centinela(dir, "tests", 1_700_000_600_000); // implementing nunca dejó constancia

    const flujo = readFlowProgress(dir)!;
    assert.deepEqual(flujo.stages.map((s) => s.status), ["done", "pending", "done", "current"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: el subdirectorio evidence/ no se confunde con un centinela", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-progress-"));
  try {
    writeFileSync(join(dir, "flow.json"), JSON.stringify({
      stages: [{ key: "evidence", label: "Evidencia", instruction: "…" }],
    }));
    mkdirSync(join(dir, "evidence"));
    assert.equal(readFlowProgress(dir)!.stages[0]!.status, "current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: sin flow.json no hay flujo que enseñar", () => {
  const dir = mkdtempSync(join(tmpdir(), "flow-progress-"));
  try {
    assert.equal(readFlowProgress(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFlowProgress: un ciclo inexistente no lanza", () => {
  assert.equal(readFlowProgress(join(tmpdir(), "no-existe-jamas-flow-progress")), null);
});

test("readFlowProgress: toma el nombre del workflow del registro de lanzamiento", () => {
  const dir = cicloTemporal();
  try {
    writeFileSync(join(dir, "launch.json"), JSON.stringify({ workflowName: "Claude plan → Codex impl" }));
    assert.equal(readFlowProgress(dir)!.workflow, "Claude plan → Codex impl");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
