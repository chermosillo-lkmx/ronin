import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAllowedRoots, saveAllowedRoots } from "./settings.js";

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
