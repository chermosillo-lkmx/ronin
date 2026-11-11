import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCycleSessions } from "./service.js";

test("listCycleSessions: sólo carpetas cowork-cycle-* con nombre válido", () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-s-"));
  for (const n of ["cowork-cycle-cowork-a", "cowork-cycle-cowork-b", "otra", "cowork-cycle-.."]) mkdirSync(join(dir, n));
  assert.deepEqual(listCycleSessions(dir).sort(), ["cowork-a", "cowork-b"]);
  assert.deepEqual(listCycleSessions(join(dir, "no-existe")), []);
});
