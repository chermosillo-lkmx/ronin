import { useEffect, useState } from "react";
import { getMainHealth, type MainHealthRow } from "../../api";

export interface MainHealthPollingTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MainHealthStripProps {
  initialRows?: MainHealthRow[];
  load?: () => Promise<MainHealthRow[]>;
  refreshMs?: number;
  timers?: MainHealthPollingTimers;
}

interface MainHealthPollingInput {
  load: () => Promise<MainHealthRow[]>;
  onRows: (rows: MainHealthRow[]) => void;
  refreshMs: number;
  timers: MainHealthPollingTimers;
}

const browserTimers: MainHealthPollingTimers = {
  setInterval: (callback, ms) => globalThis.setInterval(callback, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/** Polling aislado: un fallo conserva el último snapshot y el cleanup cerca respuestas tardías. */
export function startMainHealthPolling(input: MainHealthPollingInput): () => void {
  let active = true;
  let generation = 0;
  let inFlight = false;
  let retryQueued = false;
  const refresh = () => {
    if (!active) return;
    if (inFlight) {
      retryQueued = true;
      return;
    }
    inFlight = true;
    const runGeneration = generation;
    void Promise.resolve()
      .then(input.load)
      .then((rows) => {
        if (active && generation === runGeneration) input.onRows(rows);
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation !== runGeneration) return;
        inFlight = false;
        if (active && retryQueued) {
          retryQueued = false;
          refresh();
        }
      });
  };
  refresh();
  const handle = input.timers.setInterval(refresh, input.refreshMs);
  return () => {
    active = false;
    generation += 1;
    retryQueued = false;
    input.timers.clearInterval(handle);
  };
}

function metric(value: number): string {
  return `${value}%`;
}

function shortRemoteOwner(value: string): string {
  return value.length <= 24 ? value : `${value.slice(0, 24)}…`;
}

function MainHealthRepoRow({ row }: { row: MainHealthRow }) {
  const incidentOwner = row.incident?.owner?.session;
  const remoteOwner = !incidentOwner && row.incident?.remoteOwner
    ? shortRemoteOwner(row.incident.remoteOwner)
    : null;
  return <div className="ron-main-health-row" data-status={row.status}>
    <span className={`ron-main-health-state ${row.status}`}><i aria-hidden="true" />{row.status === "green" ? "Verde" : "Rojo"}</span>
    <strong>{row.repo}</strong>
    <code className="ron-main-health-sha">{row.sha.slice(0, 7)}</code>
    {row.total !== null && <span>{`Cobertura ${metric(row.total)}`}</span>}
    {row.floor !== null && <span>{`Piso ${metric(row.floor)}`}</span>}
    <span>{`${row.failedCount} ${row.failedCount === 1 ? "fallo" : "fallos"}`}</span>
    {row.incident && <span>Incidente <code>{row.incident.id}</code></span>}
    {incidentOwner && <span>Fixer <code>{incidentOwner}</code></span>}
    {remoteOwner && <span>Remoto <code>{remoteOwner}</code></span>}
  </div>;
}

export function MainHealthStrip({
  initialRows = [],
  load = getMainHealth,
  refreshMs = 30_000,
  timers = browserTimers,
}: MainHealthStripProps) {
  const [rows, setRows] = useState<MainHealthRow[]>(initialRows);
  useEffect(() => {
    if (typeof window === "undefined") return;
    return startMainHealthPolling({ load, onRows: setRows, refreshMs, timers });
  }, [load, refreshMs, timers]);

  return <section className="ron-main-health" aria-label="Salud de main">
    <header><strong>Salud de main</strong></header>
    {rows.length === 0
      ? <span className="ron-main-health-empty">Sin mediciones</span>
      : <div className="ron-main-health-rows">{rows.map((row) => <MainHealthRepoRow key={row.repo} row={row} />)}</div>}
  </section>;
}
