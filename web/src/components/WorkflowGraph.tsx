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
 * synthetic "verify" node drops to a second row under its branch point). No drag/zoom — this
 * is a read of the structure, not a diagramming tool.
 */
export function WorkflowGraph({ stages, verifyAfter }: { stages: WfStage[]; verifyAfter: string | null }) {
  const graph = deriveGraph(stages, verifyAfter);
  const mainKeys = stages.map((s) => s.key);
  const xOf = (key: string): number => {
    const i = mainKeys.indexOf(key);
    return i >= 0 ? i * (NODE_W + GAP_X) : 0;
  };
  const verifyX = verifyAfter ? xOf(verifyAfter) : 0;
  const width = Math.max(mainKeys.length * (NODE_W + GAP_X), NODE_W) - GAP_X;
  const hasVerify = graph.nodes.some((n) => n.key === "verify");
  const height = hasVerify ? VERIFY_ROW_Y + NODE_H + 16 : ROW_Y + NODE_H + 16;

  return (
    <svg className="wf-graph" viewBox={`0 0 ${width + 16} ${height}`} role="img" aria-label="grafo del workflow">
      {graph.edges
        .filter((e) => e.kind === "sequence")
        .map((e) => {
          const x1 = xOf(e.from) + NODE_W;
          const x2 = xOf(e.to);
          const y = ROW_Y + NODE_H / 2;
          return <line key={`seq-${e.from}-${e.to}`} className="wf-graph-edge" x1={x1} y1={y} x2={x2} y2={y} markerEnd="url(#wf-arrow)" />;
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
        .map((n) => (
          <g key={n.key} data-stage-key={n.key} className={`wf-graph-node${n.role === "impl" ? " wf-graph-node-impl" : ""}`} transform={`translate(${xOf(n.key)}, ${ROW_Y})`}>
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
