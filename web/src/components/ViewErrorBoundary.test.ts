import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ViewErrorBoundary, ViewErrorFallback } from "./ViewErrorBoundary.js";

test("ViewErrorBoundary: sin error pinta a sus hijos tal cual", () => {
  const html = renderToString(createElement(ViewErrorBoundary, { label: "workspace" }, createElement("p", null, "contenido vivo")));
  assert.match(html, /contenido vivo/);
  assert.doesNotMatch(html, /ronin-view-error/);
});

test("ViewErrorBoundary: un error de render deriva al estado de fallo y el fallback lo explica con un botón para reintentar", () => {
  const state = ViewErrorBoundary.getDerivedStateFromError(new TypeError("verifyAfter.join is not a function"));
  assert.deepEqual(state, { error: "TypeError: verifyAfter.join is not a function" });
  const html = renderToString(createElement(ViewErrorFallback, { label: "workspace", error: state.error, onRetry: () => {} }));
  assert.match(html, /class="ronin-view-error"/);
  assert.match(html, /workspace/);
  assert.match(html, /verifyAfter\.join is not a function/);
  assert.match(html, /<button[^>]*>Reintentar<\/button>/);
});

test("pin: el shell de escritorio y el web envuelven cada región de vista en ViewErrorBoundary (DesktopApp importa CSS: no se renderiza con tsx)", () => {
  const desktop = readFileSync(new URL("../DesktopApp.tsx", import.meta.url), "utf8");
  assert.match(desktop, /import \{ ViewErrorBoundary \} from "\.\/components\/ViewErrorBoundary"/);
  assert.match(desktop, /<main className="ronin-workspace"><ViewErrorBoundary key=\{view\} label="workspace">/);
  assert.match(desktop, /<aside className="ronin-inspector" id="ronin-inspector"><ViewErrorBoundary key=\{view\} label="inspector">/);
  assert.match(desktop, /<aside className="ronin-context-list"><ViewErrorBoundary key=\{view\} label="contexto">/);
  const web = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(web, /<ViewErrorBoundary key=\{view\} label="vista">\{content\}<\/ViewErrorBoundary>/);
});
