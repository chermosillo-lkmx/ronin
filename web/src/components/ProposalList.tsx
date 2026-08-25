import type { WorkflowAnalysis, WorkflowProposal } from "../types";

/** Panel de propuestas del inspector. Puro: el estado (polling, aceptar/descartar) vive en
 *  `useWorkflowInsights` dentro de `DesktopApp`. `running` y "sin propuestas" son estados
 *  distintos: mientras el modelo corre no se afirma que no hay nada, sólo que aún no llega. */
export function ProposalList({ proposals, analysis, busy, onAccept, onDismiss }: {
  proposals: WorkflowProposal[];
  analysis: WorkflowAnalysis | null;
  busy: boolean;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  const running = analysis?.status === "running";
  return <div className="ronin-proposals">
    {running && <p className="ronin-proposal-note">{`Analizando… (${analysis.id})`}</p>}
    {analysis?.status === "error" && <p className="ronin-proposal-error">{analysis.error || "el análisis falló"}</p>}
    {proposals.map((proposal) => <article className="ronin-proposal" key={proposal.id}>
      <strong>{proposal.name}</strong>
      <p>{proposal.rationale}</p>
      <div className="ronin-proposal-evidence">{proposal.evidence.map((item, index) => <code key={`${proposal.id}-${index}`}>{item}</code>)}</div>
      <div className="ronin-proposal-actions">
        <button className="n-btn n-btn-primary" disabled={busy} onClick={() => onAccept(proposal.id)}>Aceptar</button>
        <button className="n-btn n-btn-ghost" disabled={busy} onClick={() => onDismiss(proposal.id)}>Descartar</button>
      </div>
    </article>)}
    {!proposals.length && !running && analysis?.status !== "error" && <p className="ronin-proposal-note">Sin propuestas.</p>}
    {analysis?.discarded.map((item, index) => <p className="ronin-proposal-note" key={`discarded-${index}`}>{`descartadas: ${item.name ? `${item.name} — ` : ""}${item.reason}`}</p>)}
  </div>;
}
