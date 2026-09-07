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
