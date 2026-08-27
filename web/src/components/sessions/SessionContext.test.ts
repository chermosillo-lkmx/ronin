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

test("SessionContext: pinta decisión primero, con badge, pregunta y contador", () => {
  const html = renderToString(createElement(SessionContext, {
    sessions: [idle, decision], selected: null, filter: "", diagnostic: null,
    onFilter: () => {}, onSelect: () => {}, onEditPresentation: () => {}, onNew: () => {},
  }));
  assert.match(html, /⚠ decisión/);
  assert.match(html, /Do you want to make this edit to sessions\.ts\?/);
  assert.match(html, /2 sesiones · 1 esperan decisión/);
  assert.ok(html.indexOf("cowork-decision") < html.indexOf("cowork-idle"));
  assert.match(html, /attn-decision/);
});
