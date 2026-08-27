import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SessionContext } from "./SessionContext.js";
import type { TmuxSessionInfo } from "../../types.js";

const idle: TmuxSessionInfo = {
  name: "cowork-idle", kind: "managed", windows: 1, panes: [], createdAt: 0, attached: false, adopted: false,
};
const decision: TmuxSessionInfo = {
  name: "cowork-decision", kind: "managed", windows: 1, panes: [], createdAt: 0, attached: false, adopted: false,
  attention: { level: "decision", paneId: "%2", question: "Do you want to make this edit to sessions.ts?", since: 0 },
};
const working: TmuxSessionInfo = {
  ...idle, name: "cowork-working", attention: { level: "working", paneId: "%3", since: 0 },
};

test("SessionContext: pinta decisión primero, con badge, pregunta y contador", () => {
  const html = renderToString(createElement(SessionContext, {
    sessions: [idle, decision], selected: null, filter: "", diagnostic: null,
    onFilter: () => {}, onSelect: () => {}, onEditPresentation: () => {}, onNew: () => {},
  }));
  assert.match(html, /⚠ decisión/);
  assert.match(html, /Do you want to make this edit to sessions\.ts\?/);
  assert.match(html, /2 sesiones · 1 espera decisión/);
  assert.ok(html.indexOf("cowork-decision") < html.indexOf("cowork-idle"));
  assert.match(html, /attn-decision/);
});

test("SessionContext: usa plural cuando varias sesiones esperan decisión", () => {
  const html = renderToString(createElement(SessionContext, {
    sessions: [idle, decision, { ...decision, name: "cowork-second-decision" }], selected: null, filter: "", diagnostic: null,
    onFilter: () => {}, onSelect: () => {}, onEditPresentation: () => {}, onNew: () => {},
  }));
  assert.match(html, /3 sesiones · 2 esperan decisión/);
});

test("SessionContext: reserva el badge ámbar para sesiones que esperan decisión", () => {
  const html = renderToString(createElement(SessionContext, {
    sessions: [idle, working, decision], selected: null, filter: "", diagnostic: null,
    onFilter: () => {}, onSelect: () => {}, onEditPresentation: () => {}, onNew: () => {},
  }));
  assert.match(html, /<b class="ronin-attention-badge">⚠ decisión<\/b>/);
  assert.doesNotMatch(html, /cowork-idle<\/code><b class="ronin-attention-badge">/);
  assert.doesNotMatch(html, /cowork-working<\/code><b class="ronin-attention-badge">/);
});
