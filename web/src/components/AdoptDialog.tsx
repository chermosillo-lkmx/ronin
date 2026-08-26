import { useEffect, useState } from "react";
import { adoptSessionRequest, getRepos, getReposConfig, getTrustedRoots, saveTrustedRoots } from "../api";
import type { ReposConfig, TmuxSessionInfo } from "../types";

export interface AdoptDialogProps {
  session: TmuxSessionInfo;
  onAdopted: () => void;
  onCancel: () => void;
}

/**
 * F2: adopción explícita con confirmación real (B3) — nunca automática. `expectedSessionCreatedAt`
 * viaja con el `createdAt` YA CARGADO en pantalla: si el server lo rechaza (STALE_VIEW), la vista
 * estaba rancia y hay que refrescar antes de reintentar, en vez de adoptar algo distinto de lo
 * que el operador vio.
 */
export function AdoptDialog({ session, onAdopted, onCancel }: AdoptDialogProps) {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("monorepo");
  const [paneId, setPaneId] = useState<string>(session.panes.length === 1 ? session.panes[0]!.id : "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [roots, setRoots] = useState<string[]>([]);
  const [reposConfig, setReposConfig] = useState<ReposConfig | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([getRepos(), getTrustedRoots(), getReposConfig()]).then(([list, trusted, config]) => {
      if (!alive) return;
      setRepos(list);
      setRoots(trusted.roots);
      setReposConfig(config);
    });
    return () => { alive = false; };
  }, []);

  const ambiguousPane = session.panes.length > 1;

  async function submit() {
    if (!confirmed) {
      setError("Confirma que revisaste la sesión antes de adoptarla.");
      return;
    }
    if (ambiguousPane && !paneId) {
      setError("Esta sesión tiene varios panes: elige cuál adoptar.");
      return;
    }
    setBusy(true);
    setError(null);
    setErrorCode(null);
    const outcome = await adoptSessionRequest(session.name, {
      confirm: true,
      repo,
      ...(paneId ? { paneId } : {}),
      expectedSessionCreatedAt: session.createdAt,
    });
    setBusy(false);
    if (!outcome.ok) {
      setErrorCode(outcome.error.code);
      setError(
        outcome.error.code === "STALE_VIEW"
          ? "La sesión cambió desde que se cargó esta vista. Refresca e inténtalo de nuevo."
          : `No se pudo adoptar: ${outcome.error.error}`,
      );
      return;
    }
    onAdopted();
  }

  async function addRootAndRetry() {
    const folder = reposConfig?.repos.find((item) => item.key === repo)?.path;
    if (!folder) return;
    setBusy(true);
    try {
      const saved = await saveTrustedRoots([...roots, folder]);
      setRoots(saved.roots);
      await submit();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ron-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Adoptar ${session.name}`}>
      <div className="ron-modal">
        <h3>Adoptar sesión ajena</h3>
        <p className="ron-note">
          Ronin va a registrar <strong>{session.name}</strong> como gestionada. No se mueve, mata,
          renombra ni rediseña la sesión — sólo se crea su metadata y se habilita el terminal
          gestionado.
        </p>

        <label className="ron-field">
          Repo
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>

        {ambiguousPane && (
          <label className="ron-field">
            Pane candidato (%N)
            <select value={paneId} onChange={(e) => setPaneId(e.target.value)}>
              <option value="">— elige uno —</option>
              {session.panes.map((p) => (
                <option key={p.id} value={p.id}>{p.id} · {p.command || "—"}</option>
              ))}
            </select>
          </label>
        )}

        <label className="ron-field ron-field-check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          Revisé esta sesión y quiero adoptarla.
        </label>

        {error && <p className="ron-msg err">{error}</p>}

        <div className="ron-modal-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancelar</button>
          {errorCode === "REPO_NOT_ALLOWED" && <button type="button" onClick={() => void addRootAndRetry()} disabled={busy}>Añadir {reposConfig?.repos.find((item) => item.key === repo)?.path ?? "carpeta"} como raíz de confianza</button>}
          <button type="button" className="ron-btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Adoptando…" : "Adoptar"}
          </button>
        </div>
      </div>
    </div>
  );
}
