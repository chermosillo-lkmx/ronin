import assert from "node:assert/strict";
import test from "node:test";
import { buildHeatmap, monthSpans } from "./heatmap.js";
import type { TestRun } from "../../types.js";

const run = (overrides: Partial<TestRun> = {}): TestRun => ({
  runId: "run-1",
  repo: "api",
  suite: "unit",
  profile: "dev",
  status: "passed",
  createdAt: "2026-09-04T12:00:00.000Z",
  ...overrides,
});

const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

test("buildHeatmap preserves repository order and renders empty days for repositories without runs", () => {
  const rows = buildHeatmap([], [
    { repo: "api", configured: true },
    { repo: "sin-corridas", configured: false },
  ], { days: 3, today: new Date(2026, 8, 4, 15) });

  assert.deepEqual(rows.map((row) => row.repo), ["api", "sin-corridas"]);
  assert.deepEqual(rows.map((row) => row.configured), [true, false]);
  assert.deepEqual(rows.map((row) => row.total), [0, 0]);
  for (const row of rows) {
    assert.equal(row.cells.length, 3);
    assert.deepEqual(row.cells.map((cell) => cell.date), ["2026-09-02", "2026-09-03", "2026-09-04"]);
    assert.deepEqual(row.cells.map((cell) => [cell.count, cell.status]), [[0, "none"], [0, "none"], [0, "none"]]);
  }
});

test("buildHeatmap groups runs by the local createdAt date and takes the worst verdict", () => {
  const instant = new Date("2026-09-04T00:30:00.000Z");
  const today = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate(), 12);
  const rows = buildHeatmap([
    run({ runId: "passed", createdAt: instant.toISOString(), status: "passed" }),
    run({ runId: "failed", createdAt: instant.toISOString(), status: "failed" }),
    run({ runId: "error", createdAt: instant.toISOString(), status: "error" }),
    run({ runId: "queued", createdAt: instant.toISOString(), status: "queued" }),
    run({ runId: "running", createdAt: instant.toISOString(), status: "running" }),
    run({ runId: "blocked", createdAt: instant.toISOString(), status: "blocked" }),
    run({ runId: "cancelled", createdAt: instant.toISOString(), status: "cancelled" }),
  ], [{ repo: "api", configured: true }], { days: 1, today });

  assert.deepEqual(rows[0].cells, [{ date: localDate(instant), count: 3, status: "error" }]);
  assert.equal(rows[0].total, 3);
});

test("buildHeatmap treats a timeout as a failed terminal run", () => {
  const rows = buildHeatmap([
    run({ status: "timeout" }),
  ], [{ repo: "api", configured: true }], { days: 1, today: new Date(2026, 8, 4, 12) });

  assert.deepEqual(rows[0].cells[0], { date: "2026-09-04", count: 1, status: "failed" });
  assert.equal(rows[0].total, 1);
});

test("buildHeatmap ignores verdicts outside the date window", () => {
  const today = new Date(2026, 8, 4, 12);
  const before = new Date(2026, 8, 1, 12);
  const after = new Date(2026, 8, 5, 12);
  const rows = buildHeatmap([
    run({ createdAt: before.toISOString(), status: "passed" }),
    run({ createdAt: after.toISOString(), status: "failed" }),
  ], [{ repo: "api", configured: true }], { days: 2, today });

  assert.equal(rows[0].total, 0);
  assert.deepEqual(rows[0].cells.map((cell) => cell.status), ["none", "none"]);
});

test("monthSpans partitions a window from its final day into chronological month spans", () => {
  const spans = monthSpans(40, new Date(2026, 8, 4, 12));

  assert.deepEqual(spans.map((span) => span.days), [5, 31, 4]);
  assert.equal(spans.reduce((sum, span) => sum + span.days, 0), 40);
  assert.equal(monthSpans(1, new Date(2026, 8, 4, 12)).reduce((sum, span) => sum + span.days, 0), 1);
});
