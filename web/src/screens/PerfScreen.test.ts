import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PerfScreen } from "./PerfScreen";
import type { PerfReport } from "../components/perf/model";

const M = 60_000;
const stats = (bucket: string, n: number, gate: number) => ({ bucket, n, avgTotalMs: 60 * M, avgStageMs: (n ? { planning: 5 * M, implementing: 5 * M, "pre-merge": gate } : {}) as Record<string, number>, avgGateMs: gate, avgGateRuns: 1, avgGateFails: 0.5, avgQueueMs: 2 * M, avgCpu: 80, peakRssMb: 2048 });

const report: PerfReport = {
  bucket: "day",
  buckets: ["2026-11-10", "2026-11-11"],
  workflows: [{
    workflow: "claude-plan-codex-impl",
    stageOrder: ["planning", "implementing", "pre-merge"],
    total: stats("total", 3, 40 * M),
    series: [stats("2026-11-10", 1, 20 * M), stats("2026-11-11", 2, 40 * M)],
    delta: { totalPct: 0, gatePct: 100, from: "2026-11-10", to: "2026-11-11" },
  }],
  inProgress: [{ session: "cowork-x", workflow: "pr-review-merge-dev", elapsedMs: 30 * 3600_000, stage: "pre-merge", cpu: 120 }],
  machine: [{ t: 0, load1: 16, cores: 14, swapPct: 97, freeMemMb: 512 }],
};

test("PerfScreen: tarjeta con KPIs del ejemplo, degradación marcada, máquina caliente y en curso", () => {
  const html = renderToString(createElement(PerfScreen, { initial: report }));
  assert.match(html, /claude-plan-codex-impl/);
  assert.match(html, /<dt>avg<\/dt><dd>1 h 00 min<\/dd>/);
  assert.match(html, /<dt>CPU<\/dt><dd>80 %<\/dd>/);
  assert.match(html, /<dt>test gates<\/dt><dd>40 min<\/dd>/);
  assert.match(html, /<dt>plan \+ impl<\/dt><dd>10 min<\/dd>/);
  assert.match(html, /ron-perf-card degraded/);
  assert.match(html, /▲ 100 % gates/);
  assert.match(html, /ron-perf-machine degraded/);
  assert.match(html, /swap 97 %/);
  assert.match(html, /cowork-x/);
  assert.match(html, /30 h 00 min/);
});

test("PerfScreen: sin ciclos terminados muestra el aviso de registro", () => {
  const html = renderToString(createElement(PerfScreen, { initial: { ...report, workflows: [], inProgress: [], machine: [] } }));
  assert.match(html, /Todavía no hay ciclos terminados/);
});
