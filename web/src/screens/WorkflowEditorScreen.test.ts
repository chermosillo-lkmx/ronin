import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StageEditor } from "../components/StageEditor.js";
import { WorkflowGraph } from "../components/WorkflowGraph.js";
import { WorkflowJsonEditor } from "../components/WorkflowJsonEditor.js";
import { createWorkflowDraft, switchView } from "../components/workflow-draft.js";
import type { WorkflowConfig } from "../types.js";

const CFG: WorkflowConfig = {
  stages: [
    { key: "planning", label: "Plan", icon: "📋" },
    { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
    { key: "curl", label: "Curl", icon: "🌐" },
  ],
  verifyAfter: ["curl"],
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

test("25 WorkflowEditorScreen usa payloads sin pérdida al validar y guardar", () => {
  const source = readFileSync(new URL("./WorkflowEditorScreen.tsx", import.meta.url), "utf8");

  assert.match(source, /target\.kind === "global" \? globalWorkflowPayload\(draft\) : workflowPayload\(draft\)/);
  assert.match(source, /validateWorkflow\(cfg\)/);
  assert.match(source, /saveWorkflow\(globalWorkflowPayload\(draft!\)\)/);
  assert.match(source, /saveRepoConfig2\(target\.repo, repoPayload\(draft!, repoEntry, inheritWorkflow\)\)/);
});

test("19 WorkflowEditorScreen ofrece Harness como cuarta vista del mismo draft", () => {
  const source = readFileSync(new URL("./WorkflowEditorScreen.tsx", import.meta.url), "utf8");
  const draft = switchView(createWorkflowDraft(CFG), "harness");

  assert.equal(draft.view, "harness");
  assert.match(source, /\{ key: "harness", label: "Harness" \}/);
  assert.equal(source.match(/\{ key: "(?:stepper|graph|json|harness)", label:/g)?.length, 4);
});

test("WorkflowEditorScreen monta el contrato completo de la lista Harness y lee verifyGate", () => {
  const source = readFileSync(new URL("./WorkflowEditorScreen.tsx", import.meta.url), "utf8");

  assert.match(source, /getHealth\(\)\.then/);
  assert.match(source, /<HarnessList/);
  for (const prop of ["stages", "verifyAfter", "allowVerifyCmd", "arming", "verifyGate", "openStage", "onOpenStage", "onToggle", "onEdit", "onBandToggle"]) {
    assert.match(source, new RegExp(`${prop}=`), `falta prop ${prop}`);
  }
  assert.match(source, /setDraft\(\(prev\) => prev \? toggleHarnessControl/);
  assert.match(source, /setDraft\(\(prev\) => prev \? toggleHarnessSection/);
  assert.match(source, /setDraft\(\(prev\) => prev \? editControlValue/);
  assert.match(source, /confirmWorkflowSave\(draft!, repo, armDeps/);
});

test("M1a sólo la vista Harness quita el tope de ancho del editor", () => {
  const source = readFileSync(new URL("./WorkflowEditorScreen.tsx", import.meta.url), "utf8");

  assert.match(source, /draft\.view === "harness" \? " ron-wf-editor-wide" : ""/);
});

test("WorkflowEditorScreen muestra antes de Guardar los textos que el stash perderá", () => {
  const source = readFileSync(new URL("./WorkflowEditorScreen.tsx", import.meta.url), "utf8");

  assert.match(source, /pendingDiscards\(draft\.stages, draft\.stash\)/);
  assert.match(source, /controles apagados descartan su texto al guardar/);
});

test("B3 v2: WorkflowEditorScreen monta HarnessList con apertura controlada", () => {
  const source = readFileSync(new URL("./WorkflowEditorScreen.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ HarnessList \}/);
  assert.match(source, /<HarnessList/);
  for (const prop of ["openStage", "onOpenStage", "onToggle", "onEdit", "onBandToggle"]) {
    assert.match(source, new RegExp(`${prop}=`), `falta prop ${prop}`);
  }
});
