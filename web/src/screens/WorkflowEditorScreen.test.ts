import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StageEditor } from "../components/StageEditor.js";
import { WorkflowGraph } from "../components/WorkflowGraph.js";
import { WorkflowJsonEditor } from "../components/WorkflowJsonEditor.js";
import { createWorkflowDraft } from "../components/workflow-draft.js";
import type { WorkflowConfig } from "../types.js";

const CFG: WorkflowConfig = {
  stages: [
    { key: "planning", label: "Plan", icon: "📋" },
    { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
    { key: "curl", label: "Curl", icon: "🌐" },
  ],
  verifyAfter: "curl",
};

test("T14.113 round-trip renderizado: las tres vistas del MISMO borrador contienen el mismo conjunto de keys de etapa", () => {
  const draft = createWorkflowDraft(CFG);
  const keys = draft.stages.map((s) => s.key);

  const stepperHtml = renderToString(
    createElement(StageEditor, { stages: draft.stages, verifyAfter: draft.verifyAfter, onStages: () => {}, onVerifyAfter: () => {} })
  );
  const graphHtml = renderToString(createElement(WorkflowGraph, { stages: draft.stages, verifyAfter: draft.verifyAfter }));
  const jsonHtml = renderToString(createElement(WorkflowJsonEditor, { jsonText: draft.jsonText, jsonError: null, onChange: () => {} }));

  for (const key of keys) {
    assert.match(stepperHtml, new RegExp(`value="${key}"`), `stepper debería mostrar la key "${key}"`);
    assert.match(graphHtml, new RegExp(`data-stage-key="${key}"`), `grafo debería mostrar la key "${key}"`);
    assert.match(jsonHtml, new RegExp(key), `json debería mostrar la key "${key}"`);
  }

  // el texto de la vista JSON parsea de vuelta al MISMO config del borrador
  assert.deepEqual(JSON.parse(draft.jsonText), { stages: draft.stages, verifyAfter: draft.verifyAfter });
});
