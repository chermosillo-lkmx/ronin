import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SessionWorkspace } from "../components/sessions/SessionWorkspace.js";
import { SessionsScreen } from "./SessionsScreen.js";
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

test("SessionWorkspace does not mount a pane fallback while resolving ttyd", () => {
  const loading = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, onRefresh: async () => {}, onNew: () => {},
  }));
  assert.match(loading, /conectando terminal/);
  assert.doesNotMatch(loading, /pane-view-fallback/);
});

function renderSessionsWithInspectorPreference(preference: string | null) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => preference, setItem: () => {} },
  });
  try {
    return renderToString(createElement(SessionsScreen));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("SessionsScreen muestra el inspector por defecto", () => {
  const output = renderSessionsWithInspectorPreference(null);
  assert.match(output, /<aside class="ronin-inspector"/);
});

test("SessionsScreen oculta el inspector guardado y conserva el control", () => {
  const output = renderSessionsWithInspectorPreference("collapsed");
  assert.doesNotMatch(output, /<aside class="ronin-inspector"/);
  const header = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {}, inspectorVisible: false, onToggleInspector: () => {},
  }));
  assert.match(header, /data-testid="inspector-toggle"/);
  assert.match(header, /aria-controls="ronin-inspector"/);
  assert.match(header, /aria-expanded="false"/);
  assert.match(header, /title="Mostrar inspector"/);
});

test("SessionsScreen anuncia que el inspector está expandido por defecto", () => {
  const header = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {}, inspectorVisible: true, onToggleInspector: () => {},
  }));
  assert.match(header, /data-testid="inspector-toggle"/);
  assert.match(header, /aria-controls="ronin-inspector"/);
  assert.match(header, /aria-expanded="true"/);
  assert.match(header, /title="Ocultar inspector"/);
});
