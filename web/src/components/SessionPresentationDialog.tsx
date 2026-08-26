import { useEffect, useState } from "react";
import { getRepos, getReposConfig, saveReposConfig, saveSessionPresentation } from "../api";
import type { TmuxSessionInfo } from "../types";

export interface SessionPresentationDialogProps {
  session: TmuxSessionInfo;
  onSaved: () => void;
  onCancel: () => void;
}

function AddRepositoryDialog({ onAdded, onCancel }: { onAdded: (repo: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!key.trim() || !path.trim()) return setError("El nombre y la ruta son obligatorios.");
    setBusy(true);
    setError(null);
    try {
      const current = await getReposConfig();
      if (!current) throw new Error("No se pudo cargar la configuración de repositorios.");
      const updated = await saveReposConfig({ ...current, repos: [...current.repos, { key: key.trim(), path: path.trim() }] });
      const saved = updated.repos.map((repo) => repo.key).find((repo) => repo === key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) ?? key.trim();
      onAdded(saved);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className="ronin-inline-modal" role="dialog" aria-modal="true" aria-label="Añadir repositorio">
    <div>
      <h2>Añadir repositorio</h2>
      <label>Nombre<input value={key} autoFocus spellCheck={false} onChange={(event) => setKey(event.target.value)} placeholder="api-facturas" /></label>
      <label>Ruta local<input value={path} spellCheck={false} onChange={(event) => setPath(event.target.value)} placeholder="/Users/tu-usuario/code/api-facturas" /></label>
      {error && <p className="ronin-form-error">{error}</p>}
      <footer><button className="n-btn n-btn-secondary" disabled={busy} onClick={onCancel}>Cancelar</button><button className="n-btn n-btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Añadir repo"}</button></footer>
    </div>
  </div>;
}

/** Editor de contexto humano. No renombra la sesión real de tmux. */
export function SessionPresentationDialog({ session, onSaved, onCancel }: SessionPresentationDialogProps) {
  const [title, setTitle] = useState(session.presentation?.title ?? "");
  const [repo, setRepo] = useState(session.presentation?.repo ?? "");
  const [repos, setRepos] = useState<string[]>(["monorepo"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);

  useEffect(() => { void getRepos().then(setRepos); }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await saveSessionPresentation(session.name, { title, repo: repo || null });
      onSaved();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <div className="ronin-inline-modal" role="dialog" aria-modal="true" aria-label={`Editar ${session.name}`}>
      <div>
        <h2>Contexto de la sesión</h2>
        <p className="ronin-form-note">El identificador tmux <code>{session.name}</code> no cambia; título y repo sólo mejoran la lectura y el control en Ronin.</p>
        <label>Título<input data-testid="session-presentation-title" value={title} autoFocus maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Ej. Corregir facturas SAT" /></label>
        <label>Repositorio<select data-testid="session-presentation-repo" value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">Sin repositorio asociado</option>{repos.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <button className="n-btn n-btn-ghost ronin-add-repo" type="button" onClick={() => setAddingRepo(true)}>+ Añadir repositorio</button>
        {error && <p className="ronin-form-error">{error}</p>}
        <footer><button data-testid="cancel-session-presentation" className="n-btn n-btn-secondary" disabled={busy} onClick={onCancel}>Cancelar</button><button className="n-btn n-btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Guardando…" : "Guardar contexto"}</button></footer>
      </div>
    </div>
    {addingRepo && <AddRepositoryDialog onCancel={() => setAddingRepo(false)} onAdded={(nextRepo) => { setRepos((items) => [...new Set([...items, nextRepo])]); setRepo(nextRepo); setAddingRepo(false); }} />}
  </>;
}
