import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketLabel, buildMs, fmtSpan, linePaths, stackedBars, type PerfBucketStats } from "./model";

const s = (bucket: string, stages: Record<string, number>, n = 1): PerfBucketStats => ({ bucket, n, avgTotalMs: 0, avgStageMs: stages, avgGateMs: 0, avgGateRuns: 0, avgGateFails: 0, avgQueueMs: 0 });

test("fmtSpan y bucketLabel", () => {
  assert.equal(fmtSpan(0), "0 min");
  assert.equal(fmtSpan(45_000), "45 s");
  assert.equal(fmtSpan(12 * 60_000), "12 min");
  assert.equal(fmtSpan(65 * 60_000), "1 h 05 min");
  assert.match(bucketLabel("2026-11-09", "week"), /^sem 9 /);
  assert.match(bucketLabel("2026-11", "month"), /2026$/);
});

test("buildMs suma planeación + implementación y nada más", () => {
  assert.equal(buildMs(s("x", { planning: 5, implementing: 10, "pre-merge": 40 })), 15);
});

test("stackedBars: apila en orden, escala al máximo y deja barras vacías en 0", () => {
  const bars = stackedBars([s("a", { planning: 10, tests: 10 }), s("b", {}, 0)], ["planning", "tests"], 100, 50);
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0]!.segs.map((g) => [g.key, g.y, g.h]), [["planning", 25, 25], ["tests", 0, 25]]);
  assert.equal(bars[1]!.segs.length, 0);
  assert.equal(bars[0]!.x, 7.5);
});

test("linePaths corta en periodos sin dato", () => {
  assert.deepEqual(linePaths([10, null, 5, 10], 40, 10), ["5,0", "25,5 35,0"]);
});
