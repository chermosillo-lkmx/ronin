import { deriveGraph, type DraftGraphNode } from "./workflow-draft";
import type { WfStage } from "../types";

const NODE_W = 150;
const NODE_H = 48;
const GAP_X = 60;
const ROW_Y = 16;
const VERIFY_ROW_Y = ROW_Y + NODE_H + 40;

function nodeLabel(n: DraftGraphNode): string {
  return `${n.icon} ${n.label}`;
}

/**
 * T14: SVG rendering of the same three edge classes as the server's toGraph — the topological
 * order IS `stages`' array order, so layout is a single deterministic left-to-right row (the
 * synthetic "verify" node drops to a second row under its branch point). No drag/zoom; callers
 * opt into the small edit affordances through callbacks, while the default stays read-only.
 */
export function WorkflowGraph({
  stages,
  verifyAfter,
  onInsertStage,
  onStageClick,
}: {
  stages: WfStage[];
  verifyAfter: string | null;
  onInsertStage?: (index: number) => void;
  onStageClick?: (index: number) => void;
}) {
  const graph = deriveGraph(stages, verifyAfter);
  const mainKeys = stages.map((s) => s.key);
  const verifyIndex = stages.findIndex((stage) => stage.key === verifyAfter);
  const verifyX = verifyIndex >= 0 ? verifyIndex * (NODE_W + GAP_X) : 0;
  const width = Math.max(mainKeys.length * (NODE_W + GAP_X), NODE_W);
  const hasVerify = graph.nodes.some((n) => n.key === "verify");
  const height = hasVerify ? VERIFY_ROW_Y + NODE_H + 16 : ROW_Y + NODE_H + 16;

  return (
    <svg className="wf-graph" viewBox={`0 0 ${width + 16} ${height}`} role="img" aria-label="grafo del workflow">
      {graph.edges
        .filter((e) => e.kind === "sequence")
        .map((e, index) => {
          const x1 = index * (NODE_W + GAP_X) + NODE_W;
          const x2 = (index + 1) * (NODE_W + GAP_X);
          const y = ROW_Y + NODE_H / 2;
          return (
            <g key={`seq-${e.from}-${e.to}-${index}`}>
              <line className="wf-graph-edge" x1={x1} y1={y} x2={x2} y2={y} markerEnd="url(#wf-arrow)" />
              {onInsertStage && (
                <g className="wf-graph-add" role="button" tabIndex={0} aria-label={`Insertar etapa después de ${e.from}`} transform={`translate(${(x1 + x2) / 2}, ${y})`} onClick={() => onInsertStage(index + 1)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onInsertStage(index + 1); } }}>
                  <circle r={11} />
                  <text textAnchor="middle" y={5}>＋</text>
                </g>
              )}
            </g>
          );
        })}
      {graph.edges
        .filter((e) => e.kind === "verify")
        .map((e) => {
          const x = verifyX + NODE_W / 2;
          return (
            <line
              key={`verify-${e.from}-${e.to}`}
              className="wf-graph-edge wf-graph-edge-verify"
              x1={x}
              y1={ROW_Y + NODE_H}
              x2={x}
              y2={VERIFY_ROW_Y}
              markerEnd="url(#wf-arrow)"
            />
          );
        })}
      <defs>
        <marker id="wf-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" className="wf-graph-arrowhead" />
        </marker>
      </defs>
      {graph.nodes
        .filter((n) => n.key !== "verify")
        .map((n, index) => (
          <g key={`${n.key}-${index}`} data-stage-key={n.key} className={`wf-graph-node${n.role === "impl" ? " wf-graph-node-impl" : ""}${onStageClick ? " wf-graph-node-interactive" : ""}`} transform={`translate(${index * (NODE_W + GAP_X)}, ${ROW_Y})`} role={onStageClick ? "button" : undefined} tabIndex={onStageClick ? 0 : undefined} onClick={onStageClick ? () => onStageClick(index) : undefined} onKeyDown={onStageClick ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onStageClick(index); } } : undefined}>
            <rect width={NODE_W} height={NODE_H} rx={8} />
            <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle">
              {nodeLabel(n)}
            </text>
            {n.gate && (
              <title>etapa con verifyCmd (gate pass/fail)</title>
            )}
            {n.gate && <circle className="wf-graph-gate-dot" cx={NODE_W - 10} cy={10} r={4} />}
          </g>
        ))}
      {onInsertStage && (
        <g className="wf-graph-add wf-graph-add-final" role="button" tabIndex={0} aria-label="Agregar etapa al final" transform={`translate(${stages.length * (NODE_W + GAP_X) - GAP_X / 2}, ${ROW_Y + NODE_H / 2})`} onClick={() => onInsertStage(stages.length)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onInsertStage(stages.length); } }}>
          <circle r={11} />
          <text textAnchor="middle" y={5}>＋</text>
        </g>
      )}
      {graph.nodes
        .filter((n) => n.key === "verify")
        .map((n) => (
          <g key={n.key} data-stage-key={n.key} className="wf-graph-node wf-graph-node-verify" transform={`translate(${verifyX}, ${VERIFY_ROW_Y})`}>
            <rect width={NODE_W} height={NODE_H} rx={8} />
            <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle">
              {nodeLabel(n)}
            </text>
          </g>
        ))}
    </svg>
  );
}
