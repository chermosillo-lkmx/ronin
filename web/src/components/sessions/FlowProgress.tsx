import type { FlowStageProgress, SessionFlow } from "../../types";

/**
 * El avance del flujo en el inspector: un riel vertical con una marca por etapa — verde las
 * cumplidas, azul la que corre, gris las pendientes, roja la que falló su verificación.
 *
 * Todo lo que pinta viene ya resuelto del servidor (flow-progress.ts, que lo lee del cycle dir).
 * Aquí no se deduce estado: sólo se le pone forma y reloj.
 */
export function FlowProgress({ flow, now = Date.now() }: { flow: SessionFlow; now?: number }) {
  const terminado = flow.done === flow.total;
  const desde = flow.stages.find((s) => s.status === "done")?.at;
  const hasta = [...flow.stages].reverse().find((s) => s.status === "done")?.at;

  return <section className="ron-flow">
    <div className="ron-flow-head">
      <span className="ronin-eyebrow">flujo</span>
      <span className="ron-flow-rule" />
      <code>{flow.done} / {flow.total}</code>
    </div>
    {flow.workflow && <span className="ron-flow-name">{flow.workflow}</span>}
    <ol className="ron-flow-list">
      {flow.stages.map((stage, i) => <StageRow
        key={stage.key}
        stage={stage}
        now={now}
        last={i === flow.stages.length - 1}
        // El conector hereda el verde sólo cuando la etapa de ARRIBA está cumplida: así el riel
        // se llena exactamente hasta donde llegó el flujo.
        link={stage.status === "done" ? (flow.stages[i + 1]?.status === "failed" ? "failed" : "done") : "pending"}
      />)}
    </ol>
    {terminado && <p className="ron-flow-done">
      Terminado{desde !== undefined && hasta !== undefined && hasta > desde ? ` · ${elapsed(hasta - desde)} en total` : ""}
    </p>}
  </section>;
}

function StageRow({ stage, now, last, link }: { stage: FlowStageProgress; now: number; last: boolean; link: string }) {
  const meta = stageMeta(stage, now);
  return <li className={`ron-flow-row ${stage.status}`} aria-current={stage.status === "current" || stage.status === "failed" ? "step" : undefined}>
    <span className="ron-flow-rail">
      <Marker status={stage.status} />
      {!last && <i className={`ron-flow-link ${link}`} />}
    </span>
    <span className="ron-flow-body">
      <span className="ron-flow-label">
        {stage.icon && <i aria-hidden="true">{stage.icon}</i>}
        <b>{stage.label}</b>
      </span>
      {meta && <small>{meta}</small>}
    </span>
  </li>;
}

/** Las cuatro marcas, dibujadas: a 12 px un glifo de texto no se lee y no se puede recolorear. */
function Marker({ status }: { status: FlowStageProgress["status"] }) {
  if (status === "done") return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="5.5" fill="currentColor" />
    <path d="M3.4 6.2 L5.2 8 L8.6 4.2" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
  if (status === "failed") return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" overflow="visible">
    <circle cx="6" cy="6" r="5.5" fill="currentColor" />
    <path d="M4.2 4.2 L7.8 7.8 M7.8 4.2 L4.2 7.8" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="6" cy="6" r="8.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.28" />
  </svg>;
  if (status === "current") return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" overflow="visible">
    <circle cx="6" cy="6" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="6" cy="6" r="2.6" fill="currentColor" />
    <circle cx="6" cy="6" r="8.5" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.28" />
  </svg>;
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>;
}

/** Línea de meta de una etapa. Sin dato que dar, cadena vacía: la fila se queda sin segundo renglón. */
export function stageMeta(stage: FlowStageProgress, now: number): string {
  if (stage.status === "failed")
    return `falló la verificación${stage.attempts ? ` · intento ${stage.attempts}` : ""}`;
  if (stage.status === "current")
    return stage.at === undefined ? "en curso" : `en curso · ${elapsed(now - stage.at)}`;
  if (stage.status === "done")
    return [stage.executor, stage.at === undefined ? null : `hace ${elapsed(now - stage.at)}`].filter(Boolean).join(" · ");
  return stage.executor ?? "";
}

/** Duración en palabras cortas. Un delta negativo (dos relojes distintos) se lee como 0m, no "-3m". */
export function elapsed(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const resto = min % 60;
  return resto ? `${h}h ${resto}m` : `${h}h`;
}
