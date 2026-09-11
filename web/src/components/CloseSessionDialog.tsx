import { useState } from "react";
import { closeTmuxSession } from "../api";
import type { SessionCleanupReport, TmuxSessionInfo } from "../types";

export interface CloseSessionDialogProps {
  session: TmuxSessionInfo;
  onClosed: () => void;
  onCancel: () => void;
}

export function SessionCleanupSummary({ report, onDone }: { report: SessionCleanupReport; onDone: () => void }) {
  const worktree = report.worktree.status === "removed"
    ? "Worktree eliminado"
    : report.worktree.status === "kept"
      ? <>Worktree conservado: {report.worktree.reason ?? "no se pudo eliminar"}{report.worktree.path ? <> en <code>{report.worktree.path}</code></> : null}</>
      : "Worktree no aplicable";
  const cycleDir = report.cycleDir.status === "removed" ? "Cycle dir eliminado" : report.cycleDir.status === "kept" ? "Cycle dir conservado" : "Cycle dir inexistente";
  const removed = report.containers.removed.length;
  const failed = report.containers.failed.length;
  return <>
    <h2>Sesión cerrada</h2>
    <ul>
      <li>{worktree}</li>
      <li>{cycleDir}</li>
      <li>{removed} {removed === 1 ? "contenedor eliminado" : "contenedores eliminados"}</li>
      {failed > 0 && <li>{failed} {failed === 1 ? "contenedor no se pudo eliminar" : "contenedores no se pudieron eliminar"}</li>}
      {report.containers.skipped === "docker no disponible" && <li>Docker no disponible</li>}
    </ul>
    <footer><button className="n-btn n-btn-primary" onClick={onDone}>Listo</button></footer>
  </>;
}

/** Confirmación separada porque cerrar tmux destruye todos los panes de la sesión. */
export function CloseSessionDialog({ session, onClosed, onCancel }: CloseSessionDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<SessionCleanupReport | null>(null);

  async function close() {
    setBusy(true);
    setError(null);
    const result = await closeTmuxSession(session.name, { cleanup: true });
    setBusy(false);
    if ("error" in result) {
      setError(`No se pudo cerrar: ${result.error}`);
      return;
    }
    // El servidor nunca falla el cierre por la limpieza: si ésta reventó, llega {cleanup:{error}} sin reporte.
    if (!result.cleanup || !("worktree" in result.cleanup)) {
      setError(`Sesión cerrada, pero la limpieza falló: ${(result.cleanup as { error?: string } | undefined)?.error ?? "sin detalle"}`);
      return;
    }
    setReport(result.cleanup);
  }

  return <div className="ronin-inline-modal" role="dialog" aria-modal="true" aria-label={`Cerrar ${session.name}`}>
    <div>
      {report ? <SessionCleanupSummary report={report} onDone={onClosed} /> : <>
      <h2>Cerrar sesión tmux</h2>
      {session.kind === "managed"
        ? <p>Se cerrarán todos los panes de <code>{session.name}</code> y se limpiará lo que la sesión creó: su worktree y rama efímera (si no tienen trabajo sin integrar), su cycle dir en <code>/tmp</code> y los contenedores etiquetados con la sesión.</p>
        : <p>Se cerrarán todos los panes de <code>{session.name}</code>. Su repo no se toca; sólo se limpiará el cycle dir temporal de Ronin si existe.</p>}
      {error && <p className="ronin-form-error">{error}</p>}
      <footer>
        <button className="n-btn n-btn-secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
        <button className="n-btn n-btn-danger" data-testid="confirm-close-session" disabled={busy} onClick={() => void close()}>{busy ? "Cerrando…" : "Cerrar sesión"}</button>
      </footer>
      </>}
    </div>
  </div>;
}
