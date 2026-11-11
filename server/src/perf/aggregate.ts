import type { GateEvent, PerfEvent, SampleEvent } from "./journal.js";

export type Bucket = "day" | "week" | "month";

/** Un ciclo reconstruido desde el diario. */
export interface Cycle {
  session: string;
  workflow: string;
  repo: string;
  launchAt: number;
  /** Fin: el sentinela `done` o, si no llegó, el cierre de la sesión. */
  endAt?: number;
  completed: boolean;
  stageMs: Record<string, number>;
  stageOrder: string[];
  currentStage?: string;
  gateMs: number;
  gateRuns: number;
  gateFails: number;
  queueMs: number;
  cpuAvg?: number;
  rssPeakMb?: number;
}

export interface BucketStats {
  bucket: string;
  n: number;
  avgTotalMs: number;
  avgStageMs: Record<string, number>;
  avgGateMs: number;
  avgGateRuns: number;
  avgGateFails: number;
  avgQueueMs: number;
  avgCpu?: number;
  peakRssMb?: number;
}

export interface WorkflowPerf {
  workflow: string;
  stageOrder: string[];
  total: BucketStats;
  series: BucketStats[];
  /** Cambio % del último periodo con datos contra el anterior con datos; positivo = más lento. */
  delta?: { totalPct: number; gatePct: number; from: string; to: string };
}

export interface PerfReport {
  bucket: Bucket;
  buckets: string[];
  workflows: WorkflowPerf[];
  inProgress: Array<{ session: string; workflow: string; elapsedMs: number; stage?: string; cpu?: number }>;
  machine: Array<{ t: number; load1: number; cores: number; swapPct?: number; freeMemMb: number }>;
}

/** Umbral a partir del cual la UI marca un periodo como degradado. */
export const DEGRADED_PCT = 20;
const END_STAGE = "done";
const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Clave local del periodo: día, lunes de la semana o mes. */
export function bucketKey(ms: number, bucket: Bucket): string {
  const d = new Date(ms);
  if (bucket === "month") return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (bucket === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey(d);
}

/** Las últimas `count` claves de periodo hasta `now`, de la más vieja a la más nueva. */
export function bucketRange(now: number, bucket: Bucket, count: number): string[] {
  const keys: string[] = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    keys.unshift(bucketKey(d.getTime(), bucket));
    if (bucket === "day") d.setDate(d.getDate() - 1);
    else if (bucket === "week") d.setDate(d.getDate() - 7);
    else d.setMonth(d.getMonth() - 1, 1);
  }
  return keys;
}

export const BUCKET_COUNT: Record<Bucket, number> = { day: 14, week: 8, month: 6 };

export function buildCycles(events: PerfEvent[], now: number): Cycle[] {
  const launches = new Map<string, Extract<PerfEvent, { type: "launch" }>>();
  const stages = new Map<string, Array<{ stage: string; at: number }>>();
  const gates = new Map<string, GateEvent[]>();
  const closes = new Map<string, number>();
  const cpu = new Map<string, number[]>();
  const rss = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === "launch") launches.set(ev.session, ev);
    else if (ev.type === "stage") stages.set(ev.session, [...(stages.get(ev.session) ?? []), { stage: ev.stage, at: ev.at }]);
    else if (ev.type === "gate") gates.set(ev.session, [...(gates.get(ev.session) ?? []), ev]);
    else if (ev.type === "close") closes.set(ev.session, ev.at);
    else if (ev.type === "sample")
      for (const [s, v] of Object.entries(ev.sessions)) {
        cpu.set(s, [...(cpu.get(s) ?? []), v.cpu]);
        rss.set(s, Math.max(rss.get(s) ?? 0, v.rssMb));
      }
  }

  const cycles: Cycle[] = [];
  for (const [session, launch] of launches) {
    const visits = (stages.get(session) ?? []).filter((v) => v.at >= launch.createdAt - 60_000).sort((a, b) => a.at - b.at);
    const doneAt = visits.find((v) => v.stage === END_STAGE)?.at;
    const endAt = doneAt ?? closes.get(session);
    const stageMs: Record<string, number> = {};
    const stageOrder: string[] = [];
    let currentStage: string | undefined;
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i]!;
      if (v.stage === END_STAGE) break;
      const until = visits[i + 1]?.at ?? endAt ?? now;
      stageMs[v.stage] = (stageMs[v.stage] ?? 0) + Math.max(0, until - v.at);
      if (!stageOrder.includes(v.stage)) stageOrder.push(v.stage);
      currentStage = v.stage;
    }
    const gs = gates.get(session) ?? [];
    const ran = gs.filter((g) => g.ran && typeof g.startedAt === "number");
    const samples = cpu.get(session) ?? [];
    cycles.push({
      session,
      workflow: launch.workflowName ?? launch.workflowId ?? "sin workflow",
      repo: launch.repo,
      launchAt: launch.createdAt,
      ...(endAt !== undefined ? { endAt } : {}),
      completed: doneAt !== undefined,
      stageMs,
      stageOrder,
      ...(endAt === undefined && currentStage ? { currentStage } : {}),
      gateMs: ran.reduce((s, g) => s + (g.endedAt - g.startedAt!), 0),
      gateRuns: ran.length,
      gateFails: gs.filter((g) => g.status === "failed").length,
      queueMs: ran.reduce((s, g) => s + (typeof g.armedAt === "number" ? Math.max(0, g.startedAt! - g.armedAt) : 0), 0),
      ...(samples.length ? { cpuAvg: Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10 } : {}),
      ...(rss.has(session) ? { rssPeakMb: rss.get(session) } : {}),
    });
  }
  return cycles;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function stats(bucket: string, cycles: Cycle[]): BucketStats {
  const keys = [...new Set(cycles.flatMap((c) => Object.keys(c.stageMs)))];
  const cpus = cycles.flatMap((c) => (c.cpuAvg !== undefined ? [c.cpuAvg] : []));
  const rssPeaks = cycles.flatMap((c) => (c.rssPeakMb !== undefined ? [c.rssPeakMb] : []));
  return {
    bucket,
    n: cycles.length,
    avgTotalMs: Math.round(mean(cycles.map((c) => c.endAt! - c.launchAt))),
    avgStageMs: Object.fromEntries(keys.map((k) => [k, Math.round(mean(cycles.map((c) => c.stageMs[k] ?? 0)))])),
    avgGateMs: Math.round(mean(cycles.map((c) => c.gateMs))),
    avgGateRuns: Math.round(mean(cycles.map((c) => c.gateRuns)) * 10) / 10,
    avgGateFails: Math.round(mean(cycles.map((c) => c.gateFails)) * 10) / 10,
    avgQueueMs: Math.round(mean(cycles.map((c) => c.queueMs))),
    ...(cpus.length ? { avgCpu: Math.round(mean(cpus)) } : {}),
    ...(rssPeaks.length ? { peakRssMb: Math.max(...rssPeaks) } : {}),
  };
}

const pct = (to: number, from: number) => (from > 0 ? Math.round(((to - from) / from) * 100) : 0);

/** Muestras de máquina reducidas a un punto (promedio) por intervalo de `stepMs`. */
export function machineSeries(samples: SampleEvent[], stepMs: number): PerfReport["machine"] {
  const groups = new Map<number, SampleEvent[]>();
  for (const s of samples) {
    const k = Math.floor(s.t / stepMs) * stepMs;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, ss]) => {
      const swaps = ss.filter((s) => s.swapTotalMb).map((s) => (s.swapUsedMb! / s.swapTotalMb!) * 100);
      return {
        t,
        load1: Math.round(mean(ss.map((s) => s.load1)) * 10) / 10,
        cores: ss[ss.length - 1]!.cores,
        ...(swaps.length ? { swapPct: Math.round(mean(swaps)) } : {}),
        freeMemMb: Math.round(mean(ss.map((s) => s.freeMemMb))),
      };
    });
}

/**
 * Reporte por tipo de ciclo. Un ciclo cuenta en el periodo en que TERMINÓ (sentinela `done` o
 * cierre de la sesión); los que siguen abiertos van en `inProgress`. Un ciclo cerrado sin `done`
 * (abandonado) cuenta igual: también consumió el tiempo.
 */
export function buildReport(events: PerfEvent[], bucket: Bucket, now: number, count = BUCKET_COUNT[bucket]): PerfReport {
  const buckets = bucketRange(now, bucket, count);
  const cycles = buildCycles(events, now);
  const ended = cycles.filter((c) => c.endAt !== undefined && buckets.includes(bucketKey(c.endAt, bucket)));
  const byWorkflow = new Map<string, Cycle[]>();
  for (const c of ended) byWorkflow.set(c.workflow, [...(byWorkflow.get(c.workflow) ?? []), c]);

  const workflows: WorkflowPerf[] = [...byWorkflow.entries()].map(([workflow, cs]) => {
    const series = buckets.map((b) => stats(b, cs.filter((c) => bucketKey(c.endAt!, bucket) === b)));
    const withData = series.filter((s) => s.n > 0);
    const [prev, last] = withData.slice(-2);
    const stageOrder: string[] = [];
    for (const c of cs) for (const k of c.stageOrder) if (!stageOrder.includes(k)) stageOrder.push(k);
    return {
      workflow,
      stageOrder,
      total: stats("total", cs),
      series,
      ...(prev && last ? { delta: { totalPct: pct(last.avgTotalMs, prev.avgTotalMs), gatePct: pct(last.avgGateMs, prev.avgGateMs), from: prev.bucket, to: last.bucket } } : {}),
    };
  });
  workflows.sort((a, b) => b.total.n - a.total.n);

  const lastCpu = new Map<string, number>();
  const samples = events.filter((e): e is SampleEvent => e.type === "sample");
  for (const s of samples) for (const [name, v] of Object.entries(s.sessions)) lastCpu.set(name, v.cpu);

  return {
    bucket,
    buckets,
    workflows,
    inProgress: cycles
      .filter((c) => c.endAt === undefined)
      .map((c) => ({ session: c.session, workflow: c.workflow, elapsedMs: now - c.launchAt, ...(c.currentStage ? { stage: c.currentStage } : {}), ...(lastCpu.has(c.session) ? { cpu: lastCpu.get(c.session) } : {}) }))
      .sort((a, b) => b.elapsedMs - a.elapsedMs),
    machine: machineSeries(samples.filter((s) => s.t >= now - 24 * 3600_000), 15 * 60_000),
  };
}

/** Desde cuándo hay que leer el diario para cubrir el reporte (con margen para ciclos largos). */
export function reportFrom(now: number, bucket: Bucket, count = BUCKET_COUNT[bucket]): number {
  const first = bucketRange(now, bucket, count)[0]!;
  const [y, m, d] = first.split("-").map(Number);
  return new Date(y!, m! - 1, d ?? 1).getTime() - 14 * 24 * 3600_000;
}
