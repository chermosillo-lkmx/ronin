import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HarnessList } from "./HarnessList.js";
import type { WfStage } from "../types.js";

const STAGES: WfStage[] = [
  { key: "planning", label: "Plan", icon: "📋", executor: "claude", model: "opus", instruction: "Escribe plan.md" },
  { key: "implementing", label: "Impl", icon: "⌨️", executor: "codex", model: "gpt-5.6-sol", instruction: "Implementa" },
  { key: "tests", label: "Pruebas", icon: "🧪", instruction: "Genera junit y coverage", verifyCmd: "npm test -w web", maxRetries: 2 },
  { key: "pr", label: "PR", icon: "🔀", executor: "claude", instruction: "Abre el PR" },
  { key: "curl", label: "DEV", icon: "🌐", verifyCmd: "true", maxRetries: 1 },
  { key: "done", label: "Cierre", icon: "✓", verifyCmd: "npm run build", maxRetries: 0 },
];

const noop = () => {};

function render(overrides: Partial<Parameters<typeof HarnessList>[0]> = {}): string {
  return renderToString(createElement(HarnessList, {
    stages: STAGES,
    verifyAfter: ["curl", "done"],
    allowVerifyCmd: true,
    verifyGate: true,
    arming: null,
    openStage: null,
    onOpenStage: noop,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
    ...overrides,
  }));
}

test("B2: pinta una fila por etapa, ejecutores y los dos estados especiales de modelo", () => {
  const html = render();
  for (const stage of STAGES) assert.match(html, new RegExp(`data-stage-key="${stage.key}"`));
  assert.equal(html.split('class="wf-harness-row"').length - 1, STAGES.length);
  assert.match(html, /codex · gpt-5\.6-sol/);
  assert.match(html, /sin modelo = hereda/);
  assert.match(html, /hereda del flujo/);
});

test("B2: pinta ambos verifiers, el gate con comando y reintentos", () => {
  const html = render();
  for (const key of ["curl", "done"]) {
    assert.match(html, new RegExp(`data-control="verifier" data-stage-key="${key}" aria-pressed="true"`));
  }
  assert.match(html, /data-control="verifyCmd" data-stage-key="tests" aria-pressed="true"/);
  assert.match(html, /npm test -w web/);
  assert.match(html, /2 reintentos/);
});

test("B2: deshabilita verifyCmd con motivo cuando el origen no lo permite", () => {
  const html = render({ allowVerifyCmd: false });
  assert.match(html, /data-control="verifyCmd" data-stage-key="tests"[^>]*disabled=""/);
  assert.match(html, /sólo en el override por-repo/);
});

test("B2: rail expone cobertura 3\/6 y exactamente cuatro bandas", () => {
  const html = render();
  assert.match(html, /data-coverage="3\/6"/);
  assert.equal(html.split("data-band=").length - 1, 4);
  for (const band of ["gates", "verifiers", "instruction", "executor"]) {
    assert.match(html, new RegExp(`data-band="${band}"`));
  }
});

test("B2: fila abierta pinta ExecutorPicker, textarea y stepper de reintentos", () => {
  const html = render({ openStage: "tests" });
  assert.match(html, /data-stage-detail="tests"/);
  assert.match(html, /Quién ejecuta esta etapa/);
  assert.match(html, /<textarea/);
  assert.match(html, /data-retries-stepper="tests"/);
  assert.match(html, />−<.*value="2".*>\+</s);
});

test("B2: verifyGate false muestra el aviso operativo", () => {
  assert.match(render({ verifyGate: false }), /El gate no está corriendo/);
  assert.doesNotMatch(render({ verifyGate: null }), /El gate no está corriendo/);
});
