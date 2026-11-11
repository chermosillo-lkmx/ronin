import { useEffect, useState } from "react";
import { getPerf } from "../api";
import {
  bucketLabel,
  buildMs,
  DEGRADED_PCT,
  fmtSpan,
  linePaths,
  stackedBars,
  stageColor,
  type PerfBucket,
  type PerfReport,
  type PerfWorkflow,
} from "../components/perf/model";

const BUCKETS: Array<{ key: PerfBucket; label: string }> = [
  { key: "day", label: "Día" },
  { key: "week", label: "Semana" },
  { key: "month", label: "Mes" },
];
const W = 560;
const H = 120;

interface PerfScreenProps {
  /** Reporte inicial (pruebas): sin fetch ni poll. */
  initial?: PerfReport;
}

export function PerfScreen({ initial }: PerfScreenProps) {
  const [bucket, setBucket] = useState<PerfBucket>(initial?.bucket ?? "week");
  const [report, setReport] = useState<PerfReport | null>(initial ?? null);
  const [down, setDown] = useState(false);

  const load = async (b: PerfBucket) => {
    const r = await getPerf(b);
    setDown(r === null);
    if (r) setReport(r);
  };

  useEffect(() => {
    if (initial) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      await load(bucket);
      if (alive) timer = window.setTimeout(tick, 60_000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket]);

  return (
    <div className="nocturne ron-tests ron-perf">
      <header className="ron-tests-head">
        <div>
          <h2 className="ron-pf-title">Performance</h2>
          <p className="ron-pf-sub">Ciclos por tipo de workflow · tiempos reales registrados por Ronin</p>
        </div>
        <span className="ron-pf-spacer" />
        <div className="ron-perf-seg" role="group" aria-label="Periodo">
          {BUCKETS.map((b) => (
            <button key={b.key} className={bucket === b.key ? "active" : ""} onClick={() => setBucket(b.key)}>{b.label}</button>
          ))}
        </div>
        <button className="n-btn n-btn-ghost" onClick={() => void load(bucket)}>Refrescar</button>
      </header>

      {down && <p className="ron-msg err">No se pudo consultar /api/perf. ¿Está el server arriba?</p>}
      {report && <MachineCard machine={report.machine} />}

      {report && report.workflows.length === 0 && (
        <p className="ron-note">Todavía no hay ciclos terminados en este rango. Ronin registra cada ciclo desde que se instaló esta versión; los que siguen abiertos aparecen abajo.</p>
      )}
      <div className="ron-perf-grid">
        {report?.workflows.map((w) => <WorkflowCard key={w.workflow} w={w} report={report} />)}
      </div>

      {report && report.inProgress.length > 0 && (
        <section className="card elev-sm ron-perf-open">
          <div className="ron-tests-section-head"><strong>{`En curso · ${report.inProgress.length}`}</strong></div>
          <table className="table">
            <thead><tr><th>Sesión</th><th>Workflow</th><th>Etapa</th><th>Abierta</th><th>CPU</th></tr></thead>
            <tbody>
              {report.inProgress.map((p) => (
                <tr key={p.session}>
                  <td>{p.session}</td>
                  <td>{p.workflow}</td>
                  <td>{p.stage ?? "—"}</td>
                  <td className={p.elapsedMs > 24 * 3600_000 ? "ron-perf-bad" : ""}>{fmtSpan(p.elapsedMs)}</td>
                  <td>{p.cpu !== undefined ? `${Math.round(p.cpu)} %` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Delta({ pct, label }: { pct: number; label: string }) {
  const tone = pct >= DEGRADED_PCT ? "bad" : pct <= -DEGRADED_PCT ? "good" : "flat";
  return <span className={`ron-perf-delta ${tone}`} title={`${label} contra el periodo anterior con datos`}>{`${pct > 0 ? "▲" : pct < 0 ? "▼" : "="} ${Math.abs(pct)} % ${label}`}</span>;
}

function WorkflowCard({ w, report }: { w: PerfWorkflow; report: PerfReport }) {
  const t = w.total;
  const bars = stackedBars(w.series, w.stageOrder, W, H);
  const gate = linePaths(w.series.map((s) => (s.n ? s.avgGateMs : null)), W, H, Math.max(1, ...bars.map((b) => b.totalMs)));
  const degraded = (w.delta?.totalPct ?? 0) >= DEGRADED_PCT || (w.delta?.gatePct ?? 0) >= DEGRADED_PCT;
  return (
    <section className={`card elev-sm ron-perf-card ${degraded ? "degraded" : ""}`}>
      <div className="ron-perf-card-head">
        <strong>{w.workflow}</strong>
        <small>{`${t.n} ${t.n === 1 ? "ciclo" : "ciclos"}`}</small>
        <span className="ron-pf-spacer" />
        {w.delta && <Delta pct={w.delta.totalPct} label="total" />}
        {w.delta && <Delta pct={w.delta.gatePct} label="gates" />}
      </div>
      <dl className="ron-perf-kpis">
        <div><dt>avg</dt><dd>{fmtSpan(t.avgTotalMs)}</dd></div>
        <div><dt>CPU</dt><dd>{t.avgCpu !== undefined ? `${t.avgCpu} %` : "—"}</dd></div>
        <div><dt>test gates</dt><dd>{fmtSpan(t.avgGateMs)}</dd></div>
        <div><dt>plan + impl</dt><dd>{fmtSpan(buildMs(t))}</dd></div>
        <div><dt>cola de gate</dt><dd>{fmtSpan(t.avgQueueMs)}</dd></div>
        <div><dt>corridas / fallos</dt><dd>{`${t.avgGateRuns} / ${t.avgGateFails}`}</dd></div>
        <div><dt>RSS pico</dt><dd>{t.peakRssMb !== undefined ? `${(t.peakRssMb / 1024).toFixed(1)} GB` : "—"}</dd></div>
      </dl>
      <svg className="ron-perf-chart" viewBox={`0 0 ${W} ${H + 16}`} preserveAspectRatio="none" role="img" aria-label={`Tiempo por etapa de ${w.workflow}`}>
        {bars.map((b) => (
          <g key={b.bucket}>
            <title>{`${bucketLabel(b.bucket, report.bucket)} · ${b.n} ciclos · ${fmtSpan(b.totalMs)}`}</title>
            {b.segs.map((s) => <rect key={s.key} x={b.x} y={s.y} width={b.w} height={s.h} fill={stageColor(w.stageOrder, s.key)}><title>{`${s.key}: ${fmtSpan(s.ms)}`}</title></rect>)}
            {b.n === 0 && <rect x={b.x} y={H - 1} width={b.w} height={1} className="ron-perf-empty" />}
          </g>
        ))}
        {gate.map((p) => <polyline key={p} points={p} className="ron-perf-gate-line" />)}
        {bars.map((b, i) => (i % Math.ceil(bars.length / 7) === 0 ? <text key={b.bucket} x={b.x + b.w / 2} y={H + 12} className="ron-perf-axis">{bucketLabel(b.bucket, report.bucket)}</text> : null))}
      </svg>
      <ul className="ron-perf-legend">
        {w.stageOrder.map((k) => <li key={k}><i style={{ background: stageColor(w.stageOrder, k) }} />{k} {fmtSpan(t.avgStageMs[k] ?? 0)}</li>)}
        <li><i className="ron-perf-gate-key" />duración de gates</li>
      </ul>
    </section>
  );
}

function MachineCard({ machine }: { machine: PerfReport["machine"] }) {
  if (machine.length === 0) return null;
  const last = machine[machine.length - 1]!;
  const loadPct = (m: PerfReport["machine"][number]) => Math.round((m.load1 / Math.max(1, m.cores)) * 100);
  const load = linePaths(machine.map(loadPct), W, 48, 200);
  const swap = linePaths(machine.map((m) => m.swapPct ?? null), W, 48, 100);
  const hot = loadPct(last) >= 100 || (last.swapPct ?? 0) >= 80;
  return (
    <section className={`card elev-sm ron-perf-machine ${hot ? "degraded" : ""}`}>
      <div className="ron-perf-card-head">
        <strong>Máquina · últimas 24 h</strong>
        <span className="ron-pf-spacer" />
        <span className={loadPct(last) >= 100 ? "ron-perf-bad" : ""}>{`load ${last.load1} / ${last.cores} núcleos`}</span>
        {last.swapPct !== undefined && <span className={last.swapPct >= 80 ? "ron-perf-bad" : ""}>{`swap ${last.swapPct} %`}</span>}
        <span>{`libre ${(last.freeMemMb / 1024).toFixed(1)} GB`}</span>
      </div>
      <svg className="ron-perf-chart small" viewBox={`0 0 ${W} 48`} preserveAspectRatio="none" role="img" aria-label="Carga y swap">
        {load.map((p) => <polyline key={`l${p}`} points={p} className="ron-perf-load-line" />)}
        {swap.map((p) => <polyline key={`s${p}`} points={p} className="ron-perf-swap-line" />)}
      </svg>
      <ul className="ron-perf-legend"><li><i className="ron-perf-load-key" />load / núcleos (tope 200 %)</li><li><i className="ron-perf-swap-key" />swap usado</li></ul>
    </section>
  );
}
