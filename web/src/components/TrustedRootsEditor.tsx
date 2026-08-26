import { useState } from "react";
import type { TrustedRoots } from "../types";

export function TrustedRootsEditor({ roots, source, onSave }: TrustedRoots & { onSave: (roots: string[]) => Promise<void> }) {
  const [draft, setDraft] = useState(roots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (source === "env") return <section className="repos-default"><h3>Raíces de confianza</h3>{roots.map((root) => <code key={root}>{root}</code>)}<p className="muted">definidas por COWORK_ALLOWED_ROOTS</p></section>;

  async function save() {
    setBusy(true);
    setError(null);
    try { await onSave(draft); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="repos-default">
    <h3>Raíces de confianza</h3>
    <p>Adoptar una sesión sólo se permite para repos bajo estas carpetas. Añadir un repo no lo autoriza; añadir su raíz sí.</p>
    {draft.map((root, index) => <div className="repos-row" key={`${index}-${root}`}>
      <input className="repos-path" placeholder="/ruta/de/confianza" value={root} onChange={(event) => setDraft(draft.map((item, i) => i === index ? event.target.value : item))} />
      <button className="btn stop" onClick={() => setDraft(draft.filter((_, i) => i !== index))} title="quitar raíz">✕</button>
    </div>)}
    <button className="btn add-stage" onClick={() => setDraft([...draft, ""])}>＋ añadir raíz</button>
    {error && <p className="wf-err">{error}</p>}
    <button className="btn copy" onClick={() => void save()} disabled={busy}>{busy ? "guardando…" : "Guardar raíces"}</button>
  </section>;
}
