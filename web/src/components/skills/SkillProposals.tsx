import { useEffect, useRef, useState } from "react";
import { getSkillProposal, listSkillProposals, resolveSkillProposal } from "../../api";
import type { SkillProposalDetail, SkillProposalSummary, SkillResolution, SkillWarning } from "../../types";
import { runExclusive } from "../in-flight";

const WARNING_LABELS: Record<SkillWarning, string> = {
  "menciona-repo": "Menciona el repo de origen",
  "url-externa": "Tiene una URL externa",
  "comentario-html": "Tiene un comentario HTML (no se vería renderizado)",
  "comando-destructivo": "Tiene un comando destructivo",
  "nombre-ajustado": "Ronin ajustó el nombre",
};

export function warningLabel(warning: SkillWarning): string {
  return WARNING_LABELS[warning] ?? warning;
}

/** Aprobar se habilita al llegar al final del texto (con 4 px de tolerancia por el redondeo). */
export function reachedEnd(box: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
}

export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/**
 * F1: estado inicial de "leído" al montar. Measurement-based, nunca hereda un `true` de otra
 * propuesta: el panel monta una `SkillProposalView` nueva por cada `detail.id` (key={detail.id}),
 * así que `box` siempre es el <pre> recién creado para ESTA propuesta (o `null` si aún no se pintó),
 * jamás uno reciclado que conserve el scrollTop de la propuesta anterior.
 */
export function initialReadOnMount(initialRead: boolean, box: { scrollTop: number; clientHeight: number; scrollHeight: number } | null): boolean {
  return initialRead || Boolean(box && reachedEnd(box));
}

/** Aprobar manda el hash del texto que se mostró: si la propuesta cambió, el servidor responde 409. */
export function proposalActions(detail: SkillProposalDetail, api: { resolveSkillProposal: typeof resolveSkillProposal } = { resolveSkillProposal }) {
  return {
    approve: () => api.resolveSkillProposal(detail.id, "approve", { contentHash: detail.contentHash }),
    edit: (content: string) => api.resolveSkillProposal(detail.id, "edit", { content }),
    discard: () => api.resolveSkillProposal(detail.id, "discard"),
  };
}

function diffLines(diff: string): string[] {
  return (diff.endsWith("\n") ? diff.slice(0, -1) : diff).split("\n").filter((line, index, all) => line !== "" || index < all.length - 1);
}

/**
 * Detalle de una propuesta: el SKILL.md en crudo (monoespaciado, sin renderizar markdown, para que un
 * comentario HTML no esconda nada), los avisos y, en una actualización, el diff. `initialRead`,
 * `initialBusy` e `initialError` sólo existen para las pruebas SSR.
 */
export function SkillProposalView({ detail, initialRead = false, initialBusy = false, initialError = null, onResolved, onReload }: {
  detail: SkillProposalDetail;
  initialRead?: boolean;
  initialBusy?: boolean;
  initialError?: { message: string; code?: string } | null;
  onResolved?: (result: SkillResolution) => void;
  /** F2: refresca la propuesta cuando el servidor responde 409 SKILL_STALE (el texto mostrado ya no coincide). */
  onReload?: () => void;
}) {
  const [read, setRead] = useState(initialRead);
  const [busy, setBusy] = useState(initialBusy);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(initialError);
  const lock = useRef(false);
  const raw = useRef<HTMLPreElement>(null);
  useEffect(() => {
    setEditing(null);
    setError(null);
    setRead(initialReadOnMount(initialRead, raw.current));
  }, [detail.id]);
  const actions = proposalActions(detail);
  const run = async (action: () => Promise<SkillResolution>) => {
    try {
      const result = await runExclusive(lock, setBusy, action);
      if (result) onResolved?.(result);
    } catch (failure) {
      const err = failure as { message?: string; code?: string };
      setError({ message: err.message || "no se pudo resolver la propuesta", code: err.code });
    }
  };
  return <article className="ron-skill-proposal" aria-label={`Propuesta ${detail.name}`}>
    <header>
      <span className="ronin-eyebrow">{detail.kind === "update" ? "actualización" : "skill nueva"}</span>
      <h2>{detail.name}</h2>
      <p>{`${detail.repo} · de ${detail.source}`}</p>
    </header>
    {detail.warnings.length > 0 && <ul className="ron-skill-warnings" aria-label="Avisos">
      {detail.warnings.map((warning) => <li key={warning} className={`ron-skill-warning ${warning}`}>{`⚠ ${warningLabel(warning)}`}</li>)}
    </ul>}
    {detail.kind === "update" && <section className="ron-skill-changes">
      <b>Cambios respecto de la versión actual</b>
      {detail.changes && <p>{detail.changes}</p>}
      <pre className="ron-skill-diff">{diffLines(detail.diff ?? "").map((line, index) => <span key={index} className={diffLineClass(line)}>{`${line}\n`}</span>)}</pre>
    </section>}
    {editing === null
      ? <pre ref={raw} className="ron-skill-raw" tabIndex={0} onScroll={(event) => { if (reachedEnd(event.currentTarget)) setRead(true); }}>{detail.content}</pre>
      : <textarea className="ron-skill-raw" aria-label="SKILL.md" value={editing} spellCheck={false} onChange={(event) => setEditing(event.target.value)} />}
    <footer>
      {editing === null
        ? <>
          <button type="button" className="n-btn n-btn-primary" disabled={busy || !read} onClick={() => void run(actions.approve)}>✅ Aprobar</button>
          <button type="button" className="n-btn n-btn-secondary" disabled={busy} onClick={() => setEditing(detail.content)}>✏️ Editar y aprobar</button>
          <button type="button" className="n-btn n-btn-danger" disabled={busy} onClick={() => void run(actions.discard)}>❌ Descartar</button>
          {!read && <small>Baja hasta el final del texto para habilitar Aprobar.</small>}
        </>
        : <>
          <button type="button" className="n-btn n-btn-primary" disabled={busy} onClick={() => void run(() => actions.edit(editing))}>Guardar y aprobar</button>
          <button type="button" className="n-btn n-btn-secondary" disabled={busy} onClick={() => setEditing(null)}>Cancelar</button>
        </>}
    </footer>
    {error && (error.code === "SKILL_STALE"
      ? <p className="ronin-form-error" role="alert">
          La propuesta cambió; recárgala para ver el texto actual.{" "}
          <button type="button" className="n-btn n-btn-secondary" onClick={() => { setError(null); onReload?.(); }}>Recargar</button>
        </p>
      : <p className="ronin-form-error" role="alert">{error.message}</p>)}
  </article>;
}

/** Pestaña Propuestas: lista de pendientes y detalle de la elegida. `initial` sólo lo usan las pruebas SSR. */
export function SkillProposalsPanel({ initial, initialDetail = null, onCount }: { initial?: SkillProposalSummary[]; initialDetail?: SkillProposalDetail | null; onCount?: (count: number) => void }) {
  const [proposals, setProposals] = useState<SkillProposalSummary[] | null>(initial ?? null);
  const [detail, setDetail] = useState<SkillProposalDetail | null>(initialDetail);
  const [note, setNote] = useState("");
  const reload = async () => {
    const next = await listSkillProposals();
    setProposals(next);
    onCount?.(next.length);
  };
  useEffect(() => { if (initial === undefined) void reload(); }, []);
  const open = async (id: string) => {
    try {
      setDetail(await getSkillProposal(id));
      setNote("");
    } catch (failure) {
      setNote((failure as Error).message);
    }
  };
  const resolved = async (result: SkillResolution) => {
    setDetail(null);
    setNote(result.proposal.status === "discarded"
      ? `Propuesta ${result.proposal.name} descartada.`
      : `Skill ${result.proposal.name} aprobada (versión ${result.skill?.version ?? 1}).`);
    await reload();
  };
  if (proposals === null) return <p className="ron-skill-empty">Cargando propuestas…</p>;
  return <div className="ron-skill-proposals">
    <aside className="ronin-skill-list">
      {proposals.length === 0 && <p className="ron-skill-empty">No hay propuestas pendientes.</p>}
      {proposals.map((proposal) => <button key={proposal.id} className={detail?.id === proposal.id ? "selected" : ""} onClick={() => void open(proposal.id)}>
        <strong>{proposal.name}</strong>
        <span>{`${proposal.kind === "update" ? "actualización" : "nueva"} · ${proposal.repo}`}</span>
        <small className={proposal.warnings.length ? "bad" : "ok"}>{proposal.warnings.length ? `${proposal.warnings.length} ${proposal.warnings.length === 1 ? "aviso" : "avisos"}` : proposal.description}</small>
      </button>)}
    </aside>
    <section className="ronin-skill-editor">
      {detail
        // F1: key={detail.id} fuerza un remonte por propuesta, para que el <pre> (y su scrollTop) de
        // una propuesta anterior nunca se reutilice al elegir otra.
        ? <SkillProposalView key={detail.id} detail={detail} onResolved={(result) => void resolved(result)} onReload={() => void open(detail.id)} />
        : <div className="ronin-empty-workspace"><span>propuestas</span><h1>Selecciona una propuesta</h1></div>}
      {note && <p className="ron-skill-note" role="status">{note}</p>}
    </section>
  </div>;
}
