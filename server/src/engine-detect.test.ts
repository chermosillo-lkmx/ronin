import assert from "node:assert/strict";
import test from "node:test";
import { detectPaneEngine } from "./engine-detect.js";

test("detectPaneEngine: reconoce las tres capturas reales y extrae su modelo", () => {
  const claude = `  Claude Code v2.1.263
  Opus 5 (1M context) with high effort · Claude API`;
  const codex = `  │ >_ OpenAI Codex (v0.153.1)                       │
  │ model:     gpt-5.6-terra high   /model to change │
  gpt-5.6-terra high · /private/tmp/x · Context 100% left · Context 0% used · weekly 93% left`;
  const agy = `    ▄▀▀▄        Antigravity CLI 1.1.27
  ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (High)`;

  // La captura real trae "· Claude API" detrás: es el proveedor, no el modelo, y en la
  // lista de panes sólo roba ancho. Se recorta en el origen.
  assert.deepEqual(detectPaneEngine(claude), { tool: "claude", model: "Opus 5 (1M context) with high effort" });
  assert.deepEqual(detectPaneEngine(codex), { tool: "codex", model: "gpt-5.6-terra high" });
  assert.deepEqual(detectPaneEngine(agy), { tool: "agy", model: "Gemini 3.8 Flash (High)" });
});

test("detectPaneEngine: un shell normal no tiene motor", () => {
  assert.equal(detectPaneEngine("cesar@host ~ %\nls"), null);
});

test("detectPaneEngine: conserva la herramienta sin inventar un modelo", () => {
  assert.deepEqual(detectPaneEngine("│ OpenAI Codex (v0.153.1) │"), { tool: "codex" });
});

/**
 * El banner de arranque sólo está visible en un pane RECIÉN abierto: en una sesión que lleva
 * horas trabajando ya se fue del scroll, y `capture-pane` sólo devuelve lo visible. Medido en
 * vivo sobre las sesiones del operador: NINGÚN pane en marcha se detectaba con las marcas de
 * cabecera. Estas son las capturas reales de sus pies de página.
 */
const CLAUDE_TRABAJANDO = `❯
────────────────────────────────────────────────────────
  cowork-86e35cke1-remap_sat_codes  ⎇ ronin/cowork-86e35cke1  ▓░░░░ 32%
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents`;

const CODEX_TRABAJANDO = `• Implemented, reviewed, KB updated, and verified.
─ Worked for 13m 27s ────────────────────────────────────
› Implement {feature}
  gpt-5.6-terra high · /private/tmp/wt-api · Context 73% left · Context 27% used · weekly 93% left`;

test("detectPaneEngine reconoce un pane EN MARCHA por su pie, no sólo por el banner", () => {
  assert.deepEqual(detectPaneEngine(CLAUDE_TRABAJANDO), { tool: "claude" });
  assert.deepEqual(detectPaneEngine(CODEX_TRABAJANDO), { tool: "codex", model: "gpt-5.6-terra high" });
});

test("un pane de claude en marcha da la herramienta SIN modelo inventado", () => {
  const detectado = detectPaneEngine(CLAUDE_TRABAJANDO);
  assert.equal(detectado?.tool, "claude");
  assert.equal(detectado?.model, undefined); // su pie no lo dice; adivinarlo sería peor que omitirlo
});
