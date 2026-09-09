import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { HarnessView } from "./HarnessView.js";

const noop = () => {};
const STAGES = [{ key: "planning", label: "Plan", icon: "📋", instruction: "" }];

test("V1 HarnessView abre el editor de instruction armada con foco inicial", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: { stageKey: "planning", id: "instruction" },
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.match(html, /data-control="instruction"[^>]*aria-expanded="true"/);
  assert.match(html, /data-editor="instruction"/);
  assert.match(html, /<textarea[^>]*autofocus=""/);
});

test("V2 HarnessView abre verifyCmd con comando y maxRetries subordinado", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: { stageKey: "planning", id: "verifyCmd" },
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.match(html, /data-editor="verifyCmd"/);
  assert.match(html, /data-verify-command=""[^>]*autofocus=""/);
  assert.match(html, /type="number"[^>]*min="0"[^>]*max="10"/);
});

test("V3 HarnessView usa ExecutorPicker con un datalistId distinto por etapa", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [
      STAGES[0],
      { key: "implementing", label: "Impl", icon: "⌨️", executor: "codex" },
    ],
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: { stageKey: "planning", id: "executor" },
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.equal(html.split('data-editor="executor"').length - 1, 2);
  assert.match(html, /id="ronin-harness-model-planning"/);
  assert.match(html, /id="ronin-harness-model-implementing"/);
});

test("V4 HarnessView mantiene cerrados los cuatro controles off sin arming", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.doesNotMatch(html, /data-editor=/);
  assert.equal(html.split('aria-expanded="false"').length - 1, 4);
});

test("V5 HarnessView conserva maxRetries cero exacto en el input numérico", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [{ ...STAGES[0], verifyCmd: "npm test", maxRetries: 0 }],
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.match(html, /type="number"[^>]*value="0"/);
});

test("V6 HarnessView renderiza cuatro bandas y deja inerte Sensores deterministas", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));
  const source = readFileSync(new URL("./HarnessView.tsx", import.meta.url), "utf8");

  assert.equal(html.split("data-band=").length - 1, 4);
  assert.match(html, /data-band="deterministic-sensors"[^>]*disabled=""/);
  assert.match(html, /nada aquí es configuración[^<]*nadie lo comprueba/i);
  assert.match(source, /onBandToggle\(band\.id, band\.active === 0\)/);
});

test("14 HarnessView pinta cuatro controles togglables por etapa y maxRetries no es chip", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  for (const id of ["instruction", "executor", "verifyCmd", "verifier"]) {
    assert.match(html, new RegExp(`data-control="${id}"[^>]*data-stage-key="planning"[^>]*aria-pressed="false"`));
  }
  assert.doesNotMatch(html, /data-control="maxRetries"/);
});

test("B2a maxRetries nunca se renderiza como control con aria-pressed", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [STAGES[0], { ...STAGES[0], key: "tests", verifyCmd: "npm test", maxRetries: 3 }],
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.doesNotMatch(html, /data-control="maxRetries"[^>]*aria-pressed/);
  assert.equal(html.split('type="number"').length - 1, 1);
});

test("15 HarnessView deshabilita verifyCmd global y explica por qué", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: false,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.match(html, /data-control="verifyCmd"[^>]*disabled=""/);
  assert.match(html, /sólo en el override por-repo, que está en el gitignore/i);
});

test("16 HarnessView muestra cobertura y sólo dibuja la rama verify cuando está asignada", () => {
  const props = {
    stages: [STAGES[0], { ...STAGES[0], key: "tests", verifyCmd: "npm test" }],
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  };
  const withoutVerifier = renderToString(createElement(HarnessView, { ...props, verifyAfter: null }));
  const withVerifier = renderToString(createElement(HarnessView, { ...props, verifyAfter: "tests" }));

  assert.match(withoutVerifier, /data-coverage="1\/2"/);
  assert.doesNotMatch(withoutVerifier, /data-verify-branch/);
  assert.match(withVerifier, /data-verify-branch="tests"/);
});

test("22 HarnessView avisa sólo cuando sabe que verifyGate está apagado", () => {
  const props = {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  };
  const disabled = renderToString(createElement(HarnessView, { ...props, verifyGate: false }));
  const unknown = renderToString(createElement(HarnessView, { ...props, verifyGate: null }));

  assert.match(disabled, /El gate no está corriendo/);
  assert.match(disabled, /sensores declarados, no comprobaciones hechas/);
  assert.doesNotMatch(unknown, /El gate no está corriendo/);
});

test("18 HarnessView pinta chips de instrucción inertes sin aria-pressed", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [{ ...STAGES[0], instruction: "Genera junit y coverage" }],
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  for (const id of ["junit.xml", "coverage.xml"]) {
    assert.match(html, new RegExp(`data-instruction-control="${id.replace(".", "\\.")}"[^>]*aria-disabled="true"`));
    assert.doesNotMatch(html, new RegExp(`data-instruction-control="${id.replace(".", "\\.")}"[^>]*aria-pressed`));
  }
});

test("HarnessView hace visible la herencia de executor y su advertencia sin modelo", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [STAGES[0], { ...STAGES[0], key: "impl", executor: "claude" }],
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.match(html, /ron-exec-badge-inherit/);
  assert.match(html, /hereda del flujo/);
  assert.match(html, /igual que heredar: no cambia el prompt/);
});

test("HarnessView conserva las cinco filas literales de la leyenda", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.equal(html.split("data-legend=").length - 1, 5);
  for (const label of ["Guía", "Sensor", "Determinista", "Inferencial", "campo · instrucción"]) {
    assert.match(html, new RegExp(`>${label}<`));
  }
});

test("M1b Harness usa ancho disponible, riel con wrap y scroll horizontal propio", () => {
  const css = readFileSync(new URL("../screens.css", import.meta.url), "utf8");

  assert.match(css, /\.ron-wf-editor-wide\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.wf-harness\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.wf-harness-rail\s*\{[^}]*flex:\s*1 1 262px[^}]*max-width:\s*306px/s);
  assert.match(css, /\.wf-harness-loop\s*\{[^}]*flex:\s*1 1 620px[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s);
});

test("HarnessView conserva nodos de etapa, conectores ordenados y el nodo Verify", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [STAGES[0], { key: "tests", label: "Pruebas", icon: "🧪" }],
    verifyAfter: "tests",
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  assert.equal(html.split("data-harness-stage=").length - 1, 2);
  assert.match(html, /data-harness-stage="planning"[\s\S]*?>📋<[\s\S]*?>Plan<[\s\S]*?>planning</);
  assert.match(html, /data-harness-stage="tests"[\s\S]*?>🧪<[\s\S]*?>Pruebas<[\s\S]*?>tests</);
  assert.equal(html.split("data-harness-edge=").length - 1, 1);
  assert.match(html, /data-verify-branch="tests"[\s\S]*?>🔎<[\s\S]*?>Verify</);
});

test("HarnessView explica la función y la pérdida de cada control apagado", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: STAGES,
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));

  for (const copy of [
    "qué debe hacer esta etapa",
    "el paso queda anunciado y numerado, sin ninguna instrucción detrás",
    "qué herramienta ejecuta la etapa",
    "hereda del flujo",
    "exit code manda",
    "el avance vuelve a depender del autoreporte",
    "un modelo juzga después del hecho",
    "ningún verificador independiente revisa la etapa",
  ]) {
    assert.match(html, new RegExp(copy));
  }
});

test("20 las reglas del Harness usan tokens y nunca colores hex crudos", () => {
  const css = readFileSync(new URL("../screens.css", import.meta.url), "utf8");
  const rules = css.match(/\.wf-harness-[^{]+\{[^}]*\}/g) ?? [];

  assert.ok(rules.length > 0);
  assert.equal(rules.some((rule) => /#[0-9a-f]{3,8}\b/i.test(rule)), false);
});

test("Harness CSS distingue sensores deterministas, inferenciales y cobertura por rol", () => {
  const css = readFileSync(new URL("../screens.css", import.meta.url), "utf8");

  assert.match(css, /\.wf-harness-control-on\[data-kind="deterministic"\]\s*\{[^}]*var\(--status-ok\)/s);
  assert.match(css, /\.wf-harness-control-on\[data-kind="inferential"\]\s*\{[^}]*var\(--color-accent\)/s);
  assert.match(css, /\.wf-harness-control-off\s*\{[^}]*border[^;}]*dashed[^}]*var\(--color-neutral-700\)/s);
  assert.match(css, /\.wf-harness-coverage-0\s*\{[^}]*var\(--status-fail\)/s);
  assert.match(css, /\.wf-harness-coverage-1[^}]*\.wf-harness-coverage-2\s*\{[^}]*var\(--status-warn\)/s);
  assert.match(css, /\.wf-harness-coverage-3\s*\{[^}]*var\(--status-ok\)/s);
});

test("HarnessView pinta una celda de cobertura por etapa y ninguna para 0/0", () => {
  const props = {
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  };
  const populated = renderToString(createElement(HarnessView, {
    ...props,
    stages: [
      { ...STAGES[0], verifyCmd: "npm test" },
      { key: "impl", label: "Impl", icon: "⌨️" },
      { key: "tests", label: "Pruebas", icon: "🧪" },
    ],
  }));
  const empty = renderToString(createElement(HarnessView, { ...props, stages: [] }));

  assert.equal(populated.split("data-coverage-cell=").length - 1, 3);
  assert.equal(populated.split('data-coverage-cell="on"').length - 1, 1);
  assert.equal(empty.split("data-coverage-cell=").length - 1, 0);
});

test("HarnessView bloquea todos los controles de ambas etapas con key duplicada", () => {
  const html = renderToString(createElement(HarnessView, {
    stages: [
      { key: "same", label: "Una", icon: "1" },
      { key: "same", label: "Otra", icon: "2" },
    ],
    verifyAfter: null,
    allowVerifyCmd: true,
    arming: null,
    verifyGate: null,
    onToggle: noop,
    onEdit: noop,
    onBandToggle: noop,
  }));
  const controls = html.match(/<button[^>]*data-stage-key="same"[^>]*>/g) ?? [];

  assert.equal(controls.length, 8);
  assert.equal(controls.every((control) => control.includes('disabled=""')), true);
  assert.equal(controls.every((control) => control.includes('data-identity-reason="duplicate-key"')), true);
  assert.equal(html.split("Esta key identifica más de una etapa").length - 1, 5);
});
