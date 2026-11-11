// Tipos del reporte de /api/perf (espejo de server/src/perf/aggregate.ts).
export type PerfBucket = "day" | "week" | "month";
export interface PerfBucketStats {
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
export interface PerfWorkflow {
  workflow: string;
  stageOrder: string[];
  total: PerfBucketStats;
  series: PerfBucketStats[];
  delta?: { totalPct: number; gatePct: number; from: string; to: string };
}
export interface PerfReport {
  bucket: PerfBucket;
  buckets: string[];
  workflows: PerfWorkflow[];
  inProgress: Array<{ session: string; workflow: string; elapsedMs: number; stage?: string; cpu?: number }>;
  machine: Array<{ t: number; load1: number; cores: number; swapPct?: number; freeMemMb: number }>;
}

export const DEGRADED_PCT = 20;

/** «1 h 05 min», «12 min», «45 s». */
export function fmtSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")} min`;
}

/** Etapas de planeación e implementación, sumadas para la tarjeta («plan + impl»). */
const BUILD_STAGES = /^(planning|plan|planeacion|implementing|implementation|impl|implementacion|codex|refactor)/;
export function buildMs(s: PerfBucketStats): number {
  return Object.entries(s.avgStageMs).reduce((sum, [k, v]) => (BUILD_STAGES.test(k) ? sum + v : sum), 0);
}

/** Etiqueta corta de un periodo: «11 nov», «sem 9 nov», «nov 2026». */
export function bucketLabel(key: string, bucket: PerfBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y!, m! - 1, d ?? 1);
  const mes = date.toLocaleString("es-MX", { month: "short" }).replace(".", "");
  if (bucket === "month") return `${mes} ${y}`;
  return `${bucket === "week" ? "sem " : ""}${d} ${mes}`;
}

const STAGE_COLORS = ["var(--color-accent)", "var(--accent-2)", "var(--status-warn)", "var(--status-run)", "var(--color-accent-300)", "var(--status-ok)", "var(--color-neutral-400)", "var(--status-fail)"];
export function stageColor(order: string[], key: string): string {
  const i = order.indexOf(key);
  return STAGE_COLORS[(i < 0 ? order.length : i) % STAGE_COLORS.length]!;
}

export interface BarSeg { key: string; y: number; h: number; ms: number }
export interface Bar { bucket: string; x: number; w: number; n: number; segs: BarSeg[]; totalMs: number }

/** Geometría de barras apiladas por etapa: una barra por periodo, alto proporcional al máximo. */
export function stackedBars(series: PerfBucketStats[], order: string[], width: number, height: number): Bar[] {
  const totals = series.map((s) => order.reduce((sum, k) => sum + (s.avgStageMs[k] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const slot = width / Math.max(1, series.length);
  const w = Math.max(2, slot * 0.7);
  return series.map((s, i) => {
    let y = height;
    const segs: BarSeg[] = [];
    for (const key of order) {
      const ms = s.avgStageMs[key] ?? 0;
      if (ms <= 0) continue;
      const h = (ms / max) * height;
      y -= h;
      segs.push({ key, y, h, ms });
    }
    return { bucket: s.bucket, x: i * slot + (slot - w) / 2, w, n: s.n, segs, totalMs: totals[i]! };
  });
}

/** Puntos «x,y» de una polilínea; los periodos sin dato (null) cortan la línea. */
export function linePaths(values: Array<number | null>, width: number, height: number, max?: number): string[] {
  const top = Math.max(1, max ?? Math.max(0, ...values.map((v) => v ?? 0)));
  const slot = width / Math.max(1, values.length);
  const paths: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) paths.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${Math.round((i * slot + slot / 2) * 10) / 10},${Math.round((height - (v / top) * height) * 10) / 10}`);
  });
  if (cur.length) paths.push(cur.join(" "));
  return paths;
}
