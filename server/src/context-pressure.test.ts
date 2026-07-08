import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseContextPressure } from "./tmux.js";

test("parseContextPressure: detects the '/clear to save NNNk tokens' warning + extracts tokens", () => {
  const pane = [
    "  ⎿ Read 40 lines",
    "",
    "Context low · Run /clear to save 45k tokens",
    "› ",
  ].join("\n");
  const r = parseContextPressure(pane);
  assert.ok(r);
  assert.equal(r!.tokens, 45);
});

test("parseContextPressure: width-truncated warning still fires (note, tokens best-effort)", () => {
  // narrow pane truncates the line — 'tokens' is cut off but the number survives
  const pane = ["something", "Run /clear to save 45k tok", "› "].join("\n");
  const r = parseContextPressure(pane);
  assert.ok(r, "should still detect pressure when truncated");
  assert.equal(r!.tokens, 45);
});

test("parseContextPressure: 'Compacting conversation' fires", () => {
  const r = parseContextPressure(["working…", "Compacting conversation…", ""].join("\n"));
  assert.ok(r);
  assert.match(r!.note, /compact/i);
});

test("parseContextPressure: low 'context left' percentage fires (< 20%)", () => {
  const r = parseContextPressure(["Context left until auto-compact: 12%", "› "].join("\n"));
  assert.ok(r);
  assert.equal(r!.tokens, undefined);
  assert.match(r!.note, /12/);
});

test("parseContextPressure: HIGH 'context left' percentage (the ever-present footer) does NOT fire (P4a)", () => {
  assert.equal(parseContextPressure(["Context left until auto-compact: 45%", "› "].join("\n")), null);
  assert.equal(parseContextPressure(["Context left until auto-compact: 88%"].join("\n")), null);
});

test("parseContextPressure: the /clear SLASH-MENU item does NOT fire (P4a)", () => {
  const menu = [
    "  /compact   Compact conversation",
    "  /clear     Clear conversation history & free up context",
    "  /config    Open config",
    "› /mo",
  ].join("\n");
  assert.equal(parseContextPressure(menu), null);
});

test("parseContextPressure: no signal → null", () => {
  assert.equal(parseContextPressure(["just working", "⎿ done", "› "].join("\n")), null);
  assert.equal(parseContextPressure(""), null);
});

test("parseContextPressure: only looks at RECENT lines (old scrollback ignored)", () => {
  const old = ["Run /clear to save 90k tokens"]; // a stale warning from long ago
  const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  assert.equal(parseContextPressure([...old, ...filler].join("\n")), null);
});
