import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SessionWorkspace } from "../components/sessions/SessionWorkspace.js";
import type { TmuxSessionInfo } from "../types.js";

const session: TmuxSessionInfo = {
  name: "ronin-demo", kind: "managed", attached: false, adopted: false, windows: 1,
  createdAt: 0, panes: [{ id: "%1", windowIndex: 0, command: "zsh", title: "", role: null, active: true }],
};

test("SessionWorkspace renders ttyd, its fallback and Attach", () => {
  const iframe = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, terminalUrl: "http://localhost:7681", onRefresh: async () => {}, onNew: () => {},
  }));
  assert.match(iframe, /<iframe/);
  assert.match(iframe, /data-testid="attach-session"/);

  const fallback = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {},
  }));
  assert.match(fallback, /respaldo de sólo lectura/);
});
