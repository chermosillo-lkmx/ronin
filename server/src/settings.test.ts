import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAllowedRoots, readEngine, readGateSettings, saveAllowedRoots, saveEngine } from "./settings.js";
import { DEFAULT_ENGINE } from "./engine-config.js";

test("saveAllowedRoots valida absolutas/existentes, resuelve symlinks y elimina duplicados", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-settings-")));
  const target = join(base, "target");
  const link = join(base, "link");
  const settingsFile = join(base, "settings.json");
  try {
    mkdirSync(target);
    symlinkSync(target, link);
    const roots = saveAllowedRoots([target, link, target], settingsFile);
    assert.deepEqual(roots, [realpathSync(target)]);
    assert.deepEqual(readAllowedRoots(settingsFile), [realpathSync(target)]);
    assert.throws(() => saveAllowedRoots(["relative"], settingsFile), /raíz inválida: relative \(debe existir y ser absoluta\)/);
    assert.throws(() => saveAllowedRoots([join(base, "missing")], settingsFile), /raíz inválida:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("engine se conserva en settings y su ausencia devuelve el predeterminado", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-settings-engine-")));
  const settingsFile = join(base, "settings.json");
  try {
    writeFileSync(settingsFile, "{}\n");
    assert.deepEqual(readEngine(settingsFile), DEFAULT_ENGINE);
    saveAllowedRoots([base], settingsFile);
    assert.deepEqual(saveEngine({ tool: "codex", model: "gpt-5.3-codex" }, settingsFile), { tool: "codex", model: "gpt-5.3-codex" });
    assert.deepEqual(readEngine(settingsFile), { tool: "codex", model: "gpt-5.3-codex" });
    assert.deepEqual(readAllowedRoots(settingsFile), [base]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function conSettings(contenido: string | null, fn: (file: string) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-settings-gate-")));
  const file = join(base, "settings.json");
  try {
    if (contenido !== null) writeFileSync(file, contenido);
    fn(file);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("readGateSettings sin gate devuelve {45, 2}", () => {
  conSettings(null, (file) => assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2 }));
  conSettings("{}", (file) => assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2 }));
});

test("readGateSettings respeta valores válidos", () => {
  conSettings(JSON.stringify({ gate: { timeoutMin: 90, maxConcurrent: 4 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 90, maxConcurrent: 4 }));
});

test("readGateSettings descarta timeoutMin 1 y maxConcurrent \"3\"", () => {
  conSettings(JSON.stringify({ gate: { timeoutMin: 1, maxConcurrent: "3" } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2 }));
  conSettings(JSON.stringify({ gate: { timeoutMin: 241, maxConcurrent: 9 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2 }));
  conSettings(JSON.stringify({ gate: { timeoutMin: 10.5, maxConcurrent: 1 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 1 }));
});

test("saveEngine conserva el gate escrito a mano", () => {
  conSettings(JSON.stringify({ gate: { timeoutMin: 90, maxConcurrent: 4 } }), (file) => {
    saveEngine(DEFAULT_ENGINE, file);
    assert.deepEqual(readGateSettings(file), { timeoutMin: 90, maxConcurrent: 4 });
  });
});
