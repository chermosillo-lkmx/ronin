import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WorkflowGraph } from "./WorkflowGraph.js";
import type { WfStage } from "../types.js";

const STAGES: WfStage[] = [
  { key: "plan", label: "Plan", icon: "📋" },
  { key: "impl", label: "Implementar", icon: "⌨️" },
  { key: "tests", label: "Tests", icon: "🧪" },
];

test("WorkflowGraph sin callbacks se conserva de sólo lectura", () => {
  const html = renderToString(createElement(WorkflowGraph, { stages: STAGES, verifyAfter: "impl" }));

  assert.doesNotMatch(html, /wf-graph-add/);
  assert.doesNotMatch(html, /wf-graph-node-interactive/);
  assert.doesNotMatch(html, /role="button"/);
});

test("WorkflowGraph con callbacks muestra inserciones y expone etapas interactivas, no verify", () => {
  const html = renderToString(
    createElement(WorkflowGraph, {
      stages: STAGES,
      verifyAfter: "impl",
      onInsertStage: () => {},
      onStageClick: () => {},
    }),
  );

  assert.equal(html.split('aria-label="Insertar etapa después de').length - 1, STAGES.length - 1);
  assert.equal(html.split('aria-label="Agregar etapa al final"').length - 1, 1);
  for (const stage of STAGES) assert.match(html, new RegExp(`data-stage-key="${stage.key}"[^>]*wf-graph-node-interactive`));
  assert.match(html, /data-stage-key="verify"/);
  assert.doesNotMatch(html, /data-stage-key="verify"[^>]*wf-graph-node-interactive/);
});
