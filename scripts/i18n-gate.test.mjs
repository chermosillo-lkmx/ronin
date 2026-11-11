import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "i18n-gate.sh");

test("worktree sin repos de servicio ni catálogo termina SIN-GATE", (t) => {
  const root = mkdtempSync(join(tmpdir(), "i18n-sin-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = spawnSync("bash", [GATE, root], {
    encoding: "utf8",
    env: { ...process.env, I18N_GATE_MAIN_ROOT: root },
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /· no hay repos de servicio bajo .*: nada que gatear/);
  assert.match(result.stdout, /I18N-GATE: SIN-GATE\s*$/);
});
