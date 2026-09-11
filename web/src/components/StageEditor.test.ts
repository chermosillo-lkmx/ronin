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
    createElement(StageEditor, { stages: STAGES, verifyAfter: [], onStages: () => {}, onVerifyAfter: () => {} }),
  );
  assert.equal(html.split('class="wf-row"').length - 1, STAGES.length);
  assert.match(html, /value="impl"/);
  assert.match(html, /value="review"/);
});

test("StageEditor: allowVerifyCmd=false deja el campo verifyCmd deshabilitado y con su placeholder de sólo-lectura", () => {
  const html = renderToString(
    createElement(StageEditor, { stages: STAGES, verifyAfter: [], onStages: () => {}, onVerifyAfter: () => {}, allowVerifyCmd: false }),
  );
  assert.match(html, /placeholder="verifyCmd — sólo por-repo \(ejecuta shell\)"/);
  assert.doesNotMatch(html, /placeholder="verifyCmd \(exit 0 = pass;/);
  assert.match(html, /placeholder="verifyCmd — sólo por-repo \(ejecuta shell\)"[^>]*disabled=""/);
});

test("StageEditor: allowVerifyCmd=true habilita el campo verifyCmd", () => {
  const html = renderToString(
    createElement(StageEditor, { stages: STAGES, verifyAfter: [], onStages: () => {}, onVerifyAfter: () => {}, allowVerifyCmd: true }),
  );
  assert.match(html, /placeholder="verifyCmd \(exit 0 = pass; ⚠️ ejecuta shell\)"/);
  assert.doesNotMatch(html, /placeholder="verifyCmd \(exit 0 = pass; ⚠️ ejecuta shell\)"[^>]*disabled=""/);
});

test("StageEditor muestra ejecutor y modelo, o la herencia del flujo", () => {
  const html = renderToString(
    createElement(StageEditor, {
      stages: [
        { key: "impl", label: "Implementar", icon: "⌨️", executor: "claude", model: "sonnet" },
        { key: "curl", label: "Curl", icon: "🌐" },
      ],
      verifyAfter: [],
      onStages: () => {},
      onVerifyAfter: () => {},
    }),
  );

  assert.match(html, /claude/);
  assert.match(html, /sonnet/);
  assert.match(html, /hereda/);
  assert.match(html, /— del flujo/);
});

test("B3 v2: StageEditor usa un checkbox por etapa y conserva selección plural", () => {
  const html = renderToString(createElement(StageEditor, {
    stages: STAGES,
    verifyAfter: ["impl", "review"],
    onStages: () => {},
    onVerifyAfter: () => {},
  }));
  const checks = [...html.matchAll(/<input[^>]*data-verify-after[^>]*>/g)].map(([tag]) => tag);
  assert.equal(checks.length, 2);
  assert.equal(checks.every((tag) => tag.includes('type="checkbox"') && tag.includes('checked=""')), true);
  assert.doesNotMatch(html, /<select[^>]*data-verify-after/);
});
