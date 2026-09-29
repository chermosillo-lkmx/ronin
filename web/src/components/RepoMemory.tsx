import { useEffect, useRef, useState, type FormEvent } from "react";
import { addRepoMemory, deleteRepoMemory, getRepoMemory, resolveRepoMemory, setRepoMemoryEnabled } from "../api";
import type { MemoryAction, MemoryEntry, MemoryKind, RepoMemoryView } from "../types";
import { runExclusive } from "./in-flight";

export type MemoryTab = "active" | "pending" | "kb";

export const MEMORY_KIND_OPTIONS: MemoryKind[] = ["comando", "trampa", "preferencia", "decision", "arquitectura"];

const TABS: Array<{ key: MemoryTab; label: string }> = [
  { key: "active", label: "Activas" },
  { key: "pending", label: "Pendientes" },
  { key: "kb", label: "Para la KB" },
];

/** "1.2 / 2 KB": lo que ocupa el bloque que recibe cada sesión nueva frente a su tope. */
export function memoryBudgetLabel(bytes: number, maxBytes: number): string {
  const kb = (value: number) => {
    const size = value / 1024;
    return Number.isInteger(size) ? String(size) : size.toFixed(1);
  };
  return `${kb(bytes)} / ${kb(maxBytes)} KB`;
}

export function memoryCounts(view: RepoMemoryView): Record<MemoryTab, number> {
  return {
    active: view.entries.filter((entry) => entry.status === "active").length,
    pending: view.entries.filter((entry) => entry.status === "pending").length,
    kb: view.kbSuggestions.length,
  };
}

/**
 * Borrar desde Activas descarta (PATCH): la entrada sigue en el archivo para que la destilación no
 * la vuelva a proponer, y la vista ya oculta las descartadas. Una sugerencia para la KB sí se borra.
 */
export function removeMemoryItem(
  repo: string,
  id: string,
  from: "entry" | "kb",
  api: { resolveRepoMemory: typeof resolveRepoMemory; deleteRepoMemory: typeof deleteRepoMemory } = { resolveRepoMemory, deleteRepoMemory },
): Promise<RepoMemoryView> {
  return from === "entry" ? api.resolveRepoMemory(repo, id, "discard") : api.deleteRepoMemory(repo, id);
}

export type MemoryNoteState = { text: string; error: boolean } | null;

/** Aviso bajo la sección: los errores se anuncian con role="alert", los éxitos con role="status". */
export function MemoryNote({ note }: { note: MemoryNoteState }) {
  if (!note?.text) return null;
  return <p className={`ron-mem-note${note.error ? " error" : ""}`} role={note.error ? "alert" : "status"}>{note.text}</p>;
}

const LOAD_ERROR = "No se pudo cargar la memoria de este repo.";

/**
 * Memoria de un repo: interruptor, vista previa del bloque, pestañas Activas / Pendientes / Para la KB
 * y alta manual. `initial` undefined = la sección se carga sola; null = la carga quien la contiene.
 * Mientras hay una petición en curso (`busy`) todos los botones que cambian la memoria quedan
 * deshabilitados; `initialBusy` sólo existe para las pruebas SSR.
 */
export function RepoMemorySection({ repo, initial, initialTab = "active", initialBusy = false, onChange }: { repo: string; initial?: RepoMemoryView | null; initialTab?: MemoryTab; initialBusy?: boolean; onChange?: (view: RepoMemoryView) => void }) {
  const [view, setView] = useState<RepoMemoryView | null>(initial ?? null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(initialBusy);
  const lock = useRef(false);
  const [tab, setTab] = useState<MemoryTab>(initialTab);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState<{ text: string; kind: MemoryKind }>({ text: "", kind: "comando" });
  const [note, setNote] = useState<MemoryNoteState>(null);

  useEffect(() => { if (initial) setView(initial); }, [initial]);
  useEffect(() => {
    if (initial !== undefined) return;
    void getRepoMemory(repo).then(
      (loaded) => { if (loaded) setView(loaded); else setLoadFailed(true); },
      () => setLoadFailed(true),
    );
  }, [repo]);

  const apply = async (action: () => Promise<RepoMemoryView>, done: string): Promise<boolean> => {
    try {
      const next = await runExclusive(lock, setBusy, action);
      if (!next) return false;
      setView(next);
      onChange?.(next);
      setEditing(null);
      setNote({ text: done, error: false });
      return true;
    } catch (error) {
      setNote({ text: (error as Error).message, error: true });
      return false;
    }
  };

  if (!view) {
    return <section className="ron-mem" aria-label={`Memoria de ${repo}`}>
      {loadFailed ? <MemoryNote note={{ text: LOAD_ERROR, error: true }} /> : <p className="ron-mem-empty">Cargando memoria…</p>}
    </section>;
  }

  const counts = memoryCounts(view);
  const resolve = (id: string, action: MemoryAction, text?: string) =>
    void apply(() => resolveRepoMemory(repo, id, action, text), action === "discard" ? "Aprendizaje descartado." : "Aprendizaje guardado.");
  const remove = (id: string, from: "entry" | "kb") => void apply(() => removeMemoryItem(repo, id, from), "Aprendizaje borrado.");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.text.trim();
    if (!text) return;
    void apply(() => addRepoMemory(repo, { text, kind: draft.kind }), "Aprendizaje agregado.").then((ok) => { if (ok) setDraft({ text: "", kind: draft.kind }); });
  };
  const entries = view.entries.filter((entry) => entry.status === (tab === "pending" ? "pending" : "active"));

  const editor = (entry: MemoryEntry) => (
    <input aria-label="Texto del aprendizaje" maxLength={200} value={editing?.text ?? ""} onChange={(event) => setEditing({ id: entry.id, text: event.target.value })} />
  );

  return <section className="ron-mem" aria-label={`Memoria de ${repo}`}>
    <header className="ron-mem-head">
      <label className="ron-mem-toggle">
        <input type="checkbox" checked={view.enabled} disabled={!view.globalEnabled || busy} onChange={(event) => void apply(() => setRepoMemoryEnabled(repo, event.target.checked), event.target.checked ? "Memoria activada." : "Memoria desactivada.")} />
        <span>Memoria del repo</span>
      </label>
      {!view.globalEnabled && <small>Desactivada en este equipo (COWORK_MEMORY=0).</small>}
    </header>
    <div className="ron-mem-preview">
      <b>{`Esto recibe cada sesión nueva (${memoryBudgetLabel(view.preview.bytes, view.preview.maxBytes)})`}</b>
      {view.preview.text ? <pre>{view.preview.text}</pre> : <p>Todavía no hay aprendizajes activos.</p>}
    </div>
    <div className="ron-mem-tabs" role="tablist">
      {TABS.map(({ key, label }) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => { setTab(key); setEditing(null); }}>{`${label} · ${counts[key]}`}</button>)}
    </div>
    {tab === "pending" && <p className="ron-mem-hint">Lo que apruebes llega a cada sesión nueva de este repo como si lo hubieras escrito tú.</p>}
    <ul className="ron-mem-list">
      {tab !== "kb" && entries.map((entry) => {
        const isEditing = editing?.id === entry.id;
        return <li key={entry.id} className="ron-mem-item">
          <span className={`ron-mem-kind ${entry.kind}`}>{entry.kind}</span>
          {isEditing ? editor(entry) : <p>{entry.text}</p>}
          <small>{entry.status === "active" ? `usada ${entry.uses} ${entry.uses === 1 ? "vez" : "veces"}` : `de ${entry.source}`}</small>
          <div className="ron-mem-actions">
            {entry.status === "pending"
              ? isEditing
                ? <><button type="button" disabled={busy} className="n-btn n-btn-primary" onClick={() => resolve(entry.id, "edit", editing?.text)}>Guardar y aprobar</button><button type="button" disabled={busy} className="n-btn n-btn-secondary" onClick={() => setEditing(null)}>Cancelar</button></>
                : <><button type="button" disabled={busy} className="n-btn n-btn-primary" onClick={() => resolve(entry.id, "approve")}>✅ Aprobar</button><button type="button" disabled={busy} className="n-btn n-btn-secondary" onClick={() => setEditing({ id: entry.id, text: entry.text })}>✏️ Editar y aprobar</button><button type="button" disabled={busy} className="n-btn n-btn-danger" onClick={() => resolve(entry.id, "discard")}>❌ Descartar</button></>
              : isEditing
                ? <><button type="button" disabled={busy} className="n-btn n-btn-primary" onClick={() => resolve(entry.id, "edit", editing?.text)}>Guardar</button><button type="button" disabled={busy} className="n-btn n-btn-secondary" onClick={() => setEditing(null)}>Cancelar</button></>
                : <><button type="button" disabled={busy} className="n-btn n-btn-secondary" onClick={() => setEditing({ id: entry.id, text: entry.text })}>Editar</button><button type="button" disabled={busy} className="n-btn n-btn-danger" onClick={() => remove(entry.id, "entry")}>Borrar</button></>}
          </div>
        </li>;
      })}
      {tab === "kb" && view.kbSuggestions.map((suggestion) => <li key={suggestion.id} className="ron-mem-item">
        <span className="ron-mem-kind arquitectura">arquitectura</span>
        <p>{suggestion.text}</p>
        <small>{`de ${suggestion.source} · se usará en la próxima generación de la KB`}</small>
        <div className="ron-mem-actions"><button type="button" disabled={busy} className="n-btn n-btn-danger" onClick={() => remove(suggestion.id, "kb")}>Borrar</button></div>
      </li>)}
      {counts[tab] === 0 && <li className="ron-mem-empty">Nada por aquí.</li>}
    </ul>
    <form className="ron-mem-add" onSubmit={submit}>
      <select aria-label="Tipo de aprendizaje" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MemoryKind })}>
        {MEMORY_KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select>
      <input aria-label="Nuevo aprendizaje" maxLength={200} placeholder="Nuevo aprendizaje (máx. 200 caracteres)" value={draft.text} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
      <button type="submit" className="n-btn n-btn-primary" disabled={busy || !draft.text.trim()}>Agregar</button>
    </form>
    <MemoryNote note={note} />
  </section>;
}

/** Envoltorio plegable para la tarjeta de un repo en Configuración. */
/** `view` undefined = todavía cargando; null = la carga terminó sin memoria (falló). */
export function RepoMemoryDetails({ repo, view, onChange }: { repo: string; view?: RepoMemoryView | null; onChange: (view: RepoMemoryView) => void }) {
  const pending = view ? memoryCounts(view).pending : 0;
  return <details className="ron-cfg-memory">
    <summary>{`🧠 Memoria${pending ? ` · ${pending} ${pending === 1 ? "pendiente" : "pendientes"}` : ""}`}</summary>
    {view === null
      ? <section className="ron-mem" aria-label={`Memoria de ${repo}`}><MemoryNote note={{ text: LOAD_ERROR, error: true }} /></section>
      : <RepoMemorySection repo={repo} initial={view ?? null} onChange={onChange} />}
  </details>;
}
