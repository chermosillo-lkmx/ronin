import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { APP_VIEWS } from "./App.js";
import { DesktopStatusBar } from "./components/DesktopStatusBar.js";

test("App declares exactly the retained views", () => {
  assert.deepEqual(APP_VIEWS, ["sessions", "settings", "reports", "preflight", "workflow", "tests", "skills"]);
});

test("DesktopStatusBar: sin aviso de límite conserva el footer actual", () => {
  const html = renderToString(createElement(DesktopStatusBar, { current: null, diagnostic: null, decisions: 0, usageLimit: null }));
  assert.match(html, /sin sesión/);
  assert.match(html, /tmux listo/);
  assert.doesNotMatch(html, /límite/);
});

test("DesktopStatusBar: muestra el aviso de límite disponible", () => {
  const html = renderToString(createElement(DesktopStatusBar, {
    current: null,
    diagnostic: null,
    decisions: 0,
    usageLimit: { tool: "claude", state: "reached", resetAt: "15:00" },
  }));
  assert.match(html, /Claude: límite alcanzado · reinicia 15:00/);
});
