import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketKey, bucketRange, buildCycles, buildReport, machineSeries, reportFrom } from "./aggregate.js";
import type { PerfEvent } from "./journal.js";

const H = 3600_000;
const M = 60_000;
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();

function cycle(session: string, workflow: string, day: number, opts: { gateMin?: number; fail?: boolean; done?: boolean } = {}): PerfEvent[] {
  const t0 = at(day, 9);
  const evs: PerfEvent[] = [
    { t: t0, type: "launch", session, repo: "monorepo", workflowName: workflow, createdAt: t0 },
    { t: t0, type: "stage", session, stage: "planning", at: t0 },
    { t: t0, type: "stage", session, stage: "implementing", at: t0 + 10 * M },
    { t: t0, type: "stage", session, stage: "pre-merge", at: t0 + 30 * M },
    { t: t0, type: "gate", session, stage: "pre-merge", status: opts.fail ? "failed" : "passed", attempts: 1, ran: true, armedAt: t0 + 30 * M, startedAt: t0 + 35 * M, endedAt: t0 + (35 + (opts.gateMin ?? 20)) * M },
    { t: t0, type: "sample", load1: 4, cores: 14, freeMemMb: 500, swapUsedMb: 50, swapTotalMb: 100, sessions: { [session]: { cpu: 80, rssMb: 900 } } },
  ];
  if (opts.done !== false) evs.push({ t: t0, type: "stage", session, stage: "done", at: t0 + H });
  return evs;
}

test("bucketKey / bucketRange: semana empieza en lunes, mes y día locales", () => {
  assert.equal(bucketKey(at(11, 10), "day"), "2026-11-11");
  assert.equal(bucketKey(at(11, 10), "week"), "2026-11-09"); // miércoles → lunes 9
  assert.equal(bucketKey(at(9, 0, 1), "week"), "2026-11-09");
  assert.equal(bucketKey(at(8, 23), "week"), "2026-11-02"); // domingo → lunes anterior
  assert.equal(bucketKey(at(11, 10), "month"), "2026-11");
  assert.deepEqual(bucketRange(at(11, 10), "day", 3), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  assert.deepEqual(bucketRange(at(11, 10), "month", 3), ["2026-09", "2026-10", "2026-11"]);
  assert.ok(reportFrom(at(11, 10), "day", 3) < at(9, 0));
});

test("buildCycles: tiempo por etapa, gate, cola, cpu; visitas repetidas se suman", () => {
  const evs = cycle("s1", "wf", 10);
  evs.push({ t: 0, type: "stage", session: "s1", stage: "implementing", at: at(10, 9, 50) }); // volvió a implementar 10 min
  const [c] = buildCycles(evs, at(11, 0));
  assert.equal(c!.completed, true);
  assert.equal(c!.endAt! - c!.launchAt, H);
  assert.deepEqual(c!.stageMs, { planning: 10 * M, implementing: 30 * M, "pre-merge": 20 * M });
  assert.deepEqual(c!.stageOrder, ["planning", "implementing", "pre-merge"]);
  assert.equal(c!.gateMs, 20 * M);
  assert.equal(c!.queueMs, 5 * M);
  assert.equal(c!.cpuAvg, 80);
  assert.equal(c!.rssPeakMb, 900);
});

test("buildCycles: abierto sin done → sin endAt y con etapa actual; cerrado sin done → termina en el cierre", () => {
  const open = cycle("s1", "wf", 10, { done: false });
  const closed = [...cycle("s2", "wf", 10, { done: false }), { t: 0, type: "close", session: "s2", at: at(10, 12) } as PerfEvent];
  const [a, b] = buildCycles([...open, ...closed], at(10, 11));
  assert.equal(a!.endAt, undefined);
  assert.equal(a!.currentStage, "pre-merge");
  assert.equal(b!.endAt, at(10, 12));
  assert.equal(b!.completed, false);
});

test("buildReport: series por día, delta contra el periodo anterior con datos, en curso y máquina", () => {
  const evs = [
    ...cycle("a", "claude-plan-codex-impl", 9, { gateMin: 20 }),
    ...cycle("b", "claude-plan-codex-impl", 11, { gateMin: 40 }),
    ...cycle("c", "claude-plan-codex-impl", 11, { gateMin: 40, fail: true }),
    ...cycle("d", "pr-review-merge-dev", 11),
    ...cycle("e", "pr-review-merge-dev", 11, { done: false }),
  ];
  const r = buildReport(evs, "day", at(11, 18), 3);
  assert.deepEqual(r.buckets, ["2026-11-09", "2026-11-10", "2026-11-11"]);
  const cp = r.workflows.find((w) => w.workflow === "claude-plan-codex-impl")!;
  assert.equal(cp.total.n, 3);
  assert.deepEqual(cp.series.map((s) => s.n), [1, 0, 2]);
  assert.equal(cp.series[2]!.avgGateMs, 40 * M);
  assert.equal(cp.series[2]!.avgGateFails, 0.5);
  assert.deepEqual(cp.delta, { totalPct: 0, gatePct: 100, from: "2026-11-09", to: "2026-11-11" });
  assert.equal(r.workflows[0]!.workflow, "claude-plan-codex-impl"); // más ciclos primero
  assert.deepEqual(r.inProgress.map((p) => p.session), ["e"]);
  assert.equal(r.inProgress[0]!.cpu, 80);
  assert.equal(r.machine.length >= 1, true);
});

test("machineSeries: promedia por intervalo y calcula swap %", () => {
  const s = (t: number, load1: number): PerfEvent => ({ t, type: "sample", load1, cores: 14, freeMemMb: 100, swapUsedMb: 75, swapTotalMb: 100, sessions: {} });
  const series = machineSeries([s(0, 2), s(60_000, 4), s(15 * M, 10)] as any, 15 * M);
  assert.deepEqual(series.map((p) => [p.t, p.load1, p.swapPct]), [[0, 3, 75], [15 * M, 10, 75]]);
});
