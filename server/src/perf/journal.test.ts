import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal, journalFile } from "./journal.js";

test("journal: un archivo por mes y lectura por rango que cruza meses", () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-j-"));
  const j = createJournal(dir, () => new Date(2026, 11, 31).getTime());
  const oct = new Date(2026, 9, 30, 12).getTime();
  const nov = new Date(2026, 10, 2, 12).getTime();
  j.append({ t: oct, type: "stage", session: "s", stage: "planning", at: oct });
  j.append({ t: nov, type: "close", session: "s", at: nov });
  assert.equal(readdirSync(dir).length, 2);
  assert.deepEqual(j.read(oct, nov + 1).map((e) => e.type), ["stage", "close"]);
  assert.deepEqual(j.read(nov).map((e) => e.type), ["close"]);
  assert.deepEqual(j.read(0, nov).map((e) => e.type), ["stage"]);
});

test("journal: líneas corruptas se saltan y `t` por defecto es now()", () => {
  const dir = mkdtempSync(join(tmpdir(), "perf-j-"));
  const now = new Date(2026, 10, 11, 9).getTime();
  const j = createJournal(dir, () => now);
  j.append({ type: "close", session: "x", at: 1 });
  appendFileSync(journalFile(now, dir), "{roto\n");
  const evs = j.read(0);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.t, now);
});
