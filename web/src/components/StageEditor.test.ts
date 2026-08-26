import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StageEditor } from "./StageEditor.js";
import type { WfStage } from "../types.js";

const STAGES: WfStage[] = [
  { key: "impl", label: "Implementar", icon: "⌨️", instruction: "" },
  { key: "review", label: "Revisar", icon: "🔎", instruction: "", verifyCmd: "npm test" },
];

test("StageEditor pinta una fila por etapa, cada una con su key", () => {
  const html = renderToString(
    createElement(StageEditor, { stages: STAGES, verifyAfter: null, onStages: () => {}, onVerifyAfter: () => {} }),
  );
  assert.equal(html.split('class="wf-row"').length - 1, STAGES.length);
  assert.match(html, /value="impl"/);
  assert.match(html, /value="review"/);
});

test("StageEditor: allowVerifyCmd=false deja el campo verifyCmd deshabilitado y con su placeholder de sólo-lectura", () => {
  const html = renderToString(
    createElement(StageEditor, { stages: STAGES, verifyAfter: null, onStages: () => {}, onVerifyAfter: () => {}, allowVerifyCmd: false }),
  );
  assert.match(html, /placeholder="verifyCmd — sólo por-repo \(ejecuta shell\)"/);
  assert.doesNotMatch(html, /placeholder="verifyCmd \(exit 0 = pass;/);
  assert.match(html, /placeholder="verifyCmd — sólo por-repo \(ejecuta shell\)"[^>]*disabled=""/);
});

test("StageEditor: allowVerifyCmd=true habilita el campo verifyCmd", () => {
  const html = renderToString(
    createElement(StageEditor, { stages: STAGES, verifyAfter: null, onStages: () => {}, onVerifyAfter: () => {}, allowVerifyCmd: true }),
  );
  assert.match(html, /placeholder="verifyCmd \(exit 0 = pass; ⚠️ ejecuta shell\)"/);
  assert.doesNotMatch(html, /placeholder="verifyCmd \(exit 0 = pass; ⚠️ ejecuta shell\)"[^>]*disabled=""/);
});
