import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ENGINE, engineInvocation, sanitizeEngine } from "./engine-config.js";

test("sanitizeEngine conserva una herramienta válida y sanea su modelo", () => {
  assert.deepEqual(sanitizeEngine({ tool: "codex", model: "  gpt-5.3-codex  " }), { tool: "codex", model: "gpt-5.3-codex" });
});

test("sanitizeEngine devuelve el motor predeterminado para una herramienta desconocida", () => {
  assert.deepEqual(sanitizeEngine({ tool: "otro", model: "opus" }), DEFAULT_ENGINE);
});

test("sanitizeEngine omite modelos inválidos y tolera entradas basura", () => {
  assert.deepEqual(sanitizeEngine({ tool: "agy", model: "opus; rm -rf /" }), { tool: "agy" });
  for (const raw of [null, 42, [], { tool: {} }]) assert.deepEqual(sanitizeEngine(raw), DEFAULT_ENGINE);
});

test("engineInvocation construye cada comando sin modelo", () => {
  assert.deepEqual(engineInvocation({ tool: "claude" }), { command: "claude", args: ["-p"] });
  assert.deepEqual(engineInvocation({ tool: "codex" }), { command: "codex", args: ["exec"] });
  assert.deepEqual(engineInvocation({ tool: "agy" }), { command: "agy", args: ["-p"] });
});

test("engineInvocation añade --model cuando el motor lo tiene", () => {
  assert.deepEqual(engineInvocation({ tool: "claude", model: "modelo-seguro" }), { command: "claude", args: ["-p", "--model", "modelo-seguro"] });
  assert.deepEqual(engineInvocation({ tool: "codex", model: "modelo-seguro" }), { command: "codex", args: ["exec", "--model", "modelo-seguro"] });
  assert.deepEqual(engineInvocation({ tool: "agy", model: "modelo-seguro" }), { command: "agy", args: ["-p", "--model", "modelo-seguro"] });
});
