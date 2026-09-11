import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import test from "node:test";
import type { SessionCleanupReport, TmuxSessionInfo } from "../types.js";
import { CloseSessionDialog, SessionCleanupSummary } from "./CloseSessionDialog.js";

function session(kind: "managed" | "foreign"): TmuxSessionInfo {
  return { name: "cowork-clean", kind, windows: 1, panes: [], createdAt: 1, attached: false, adopted: false };
}

test("CloseSessionDialog explica la limpieza de una sesión gestionada", () => {
  const html = renderToString(createElement(CloseSessionDialog, { session: session("managed"), onClosed: () => {}, onCancel: () => {} }));
  assert.match(html, /Se cerrarán todos los panes/);
  assert.match(html, /worktree/);
  assert.match(html, /su worktree y rama efímera \(si no tienen trabajo sin integrar\)/);
  assert.match(html, /cycle dir/);
  assert.match(html, /contenedores etiquetados/);
  assert.match(html, /data-testid="confirm-close-session"/);
});

test("CloseSessionDialog avisa que no toca el repo de una sesión ajena", () => {
  const html = renderToString(createElement(CloseSessionDialog, { session: session("foreign"), onClosed: () => {}, onCancel: () => {} }));
  assert.match(html, /repo(?:sitorio)? no se toca/i);
  assert.doesNotMatch(html, /cowork\/cowork-clean/);
});

test("SessionCleanupSummary muestra recursos eliminados, fallidos y Docker ausente", () => {
  const report: SessionCleanupReport = {
    kind: "managed",
    worktree: { status: "removed", path: "/worktree", branch: "ronin/cowork-clean" },
    cycleDir: { status: "removed", path: "/tmp/cycle" },
    containers: { removed: ["a", "b"], failed: ["c"], skipped: "docker no disponible" },
  };
  const html = renderToString(createElement(SessionCleanupSummary, { report, onDone: () => {} })).replace(/<!-- -->/g, "");
  assert.match(html, /Worktree eliminado/);
  assert.match(html, /Cycle dir eliminado/);
  assert.match(html, /2 contenedores eliminados/);
  assert.match(html, /1 contenedor no se pudo eliminar/);
  assert.match(html, /Docker no disponible/);
  assert.match(html, />Listo</);
});

test("SessionCleanupSummary muestra el worktree y cycle dir conservados", () => {
  const report: SessionCleanupReport = {
    kind: "managed",
    worktree: { status: "kept", path: "/worktree", branch: "ronin/cowork-clean", reason: "tiene trabajo sin integrar" },
    cycleDir: { status: "kept", path: "/tmp/cycle" },
    containers: { removed: [], failed: [] },
  };
  const html = renderToString(createElement(SessionCleanupSummary, { report, onDone: () => {} })).replace(/<!-- -->/g, "");
  assert.match(html, /Worktree conservado: tiene trabajo sin integrar en .*\/worktree/);
  assert.match(html, /Cycle dir conservado/);
  assert.match(html, /0 contenedores eliminados/);
});

test("SessionCleanupSummary muestra estados none para una sesión ajena", () => {
  const report: SessionCleanupReport = {
    kind: "foreign",
    worktree: { status: "none" },
    cycleDir: { status: "none" },
    containers: { removed: [], failed: [] },
  };
  const html = renderToString(createElement(SessionCleanupSummary, { report, onDone: () => {} }));
  assert.match(html, /Worktree no aplicable/);
  assert.match(html, /Cycle dir inexistente/);
});
