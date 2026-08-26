import { useState } from "react";
import { closeTmuxSession } from "../api";
import type { TmuxSessionInfo } from "../types";

export interface CloseSessionDialogProps {
  session: TmuxSessionInfo;
  onClosed: () => void;
  onCancel: () => void;
}

/** Confirmación separada porque cerrar tmux destruye todos los panes de la sesión. */
export function CloseSessionDialog({ session, onClosed, onCancel }: CloseSessionDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function close() {
    setBusy(true);
    setError(null);
    const result = await closeTmuxSession(session.name);
    setBusy(false);
    if (result) {
      setError(`No se pudo cerrar: ${result.error}`);
      return;
    }
    onClosed();
  }

  return <div className="ronin-inline-modal" role="dialog" aria-modal="true" aria-label={`Cerrar ${session.name}`}>
    <div>
      <h2>Cerrar sesión tmux</h2>
      <p>Se cerrarán todos los panes de <code>{session.name}</code>. Los archivos, worktrees y evidencia no se borrarán.</p>
      {error && <p className="ronin-form-error">{error}</p>}
      <footer>
        <button className="n-btn n-btn-secondary" disabled={busy} onClick={onCancel}>Cancelar</button>
        <button className="n-btn n-btn-danger" data-testid="confirm-close-session" disabled={busy} onClick={() => void close()}>{busy ? "Cerrando…" : "Cerrar sesión"}</button>
      </footer>
    </div>
  </div>;
}
