import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseUsageLimit } from "./tmux.js";

test("parseUsageLimit: detecta el aviso próximo de Claude desde su chrome", () => {
  const pane = [
    "Claude Code",
    "Approaching usage limit. Consider waiting before continuing.",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  assert.deepEqual(parseUsageLimit(pane), { tool: "claude", state: "approaching" });
});

test("parseUsageLimit: detecta límite alcanzado de Claude y extrae su reinicio", () => {
  const pane = [
    "Claude Code",
    "Usage limit reached · resets at 3pm",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n");
  assert.deepEqual(parseUsageLimit(pane), { tool: "claude", state: "reached", resetAt: "3pm" });
});

test("parseUsageLimit: detecta rate limit de Codex y la hora de reintento", () => {
  const pane = [
    "OpenAI Codex",
    "Rate limit reached. Try again after 15:00.",
    "> ",
  ].join("\n");
  assert.deepEqual(parseUsageLimit(pane), { tool: "codex", state: "reached", resetAt: "15:00" });
});

test("parseUsageLimit: un pane normal de Claude no inventa cuota", () => {
  assert.equal(parseUsageLimit(["Claude Code", "Implementing the requested change…", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n")), null);
});

test("parseUsageLimit: una palabra limit aislada en la conversación es ambigua", () => {
  assert.equal(parseUsageLimit(["Claude Code", "Please limit this function to 20 lines.", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n")), null);
});

test("parseUsageLimit: no confunde rate limit dentro del transcript con un aviso de la TUI", () => {
  assert.equal(parseUsageLimit([
    "Claude Code",
    "Please explain how a rate limit works in this API.",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n")), null);
});

test("parseUsageLimit: no confunde una cita de Usage limit reached con un aviso", () => {
  assert.equal(parseUsageLimit([
    "Claude Code",
    'User asked: quote "Usage limit reached" in the documentation.',
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n")), null);
});

test("parseUsageLimit: requiere chrome como línea propia, no una mención dentro de shell", () => {
  assert.equal(parseUsageLimit("I am writing about OpenAI Codex\nUsage limit reached"), null);
});
