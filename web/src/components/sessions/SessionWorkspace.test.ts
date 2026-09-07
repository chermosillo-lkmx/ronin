import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { nextSelectedPane, SessionInspector, SessionWorkspace } from "./SessionWorkspace.js";
import type { TmuxSessionInfo } from "../../types.js";

/**
 * El inventario se resondea cada 5s y trae un array de panes NUEVO aunque nada haya cambiado.
 * Reseteando a `panes[0]` en cada llegada, el pane que el operador eligió duraba un segundo.
 */
test("nextSelectedPane conserva el pane elegido mientras siga existiendo", () => {
  const panes = [{ id: "%214" }, { id: "%215" }];
  assert.equal(nextSelectedPane("%215", panes), "%215");
  assert.equal(nextSelectedPane("%214", panes), "%214");
});

test("nextSelectedPane cae al primero cuando el elegido ya no está", () => {
  assert.equal(nextSelectedPane("%999", [{ id: "%214" }, { id: "%215" }]), "%214");
  assert.equal(nextSelectedPane(null, [{ id: "%214" }]), "%214");
});

test("nextSelectedPane devuelve null sin panes", () => {
  assert.equal(nextSelectedPane("%214", []), null);
  assert.equal(nextSelectedPane(null, []), null);
});

test("SessionWorkspace SSR muestra motor, rol y el comando sólo como reserva", () => {
  const session: TmuxSessionInfo = {
    name: "s", kind: "managed", attached: false, adopted: false, windows: 1, createdAt: 0,
    panes: [
      { id: "%1", windowIndex: 0, command: "zsh", title: "", role: null, active: true, engine: { tool: "claude", model: "Opus 5" } },
      { id: "%2", windowIndex: 0, command: "zsh", title: "", role: "review", active: false },
      { id: "%3", windowIndex: 0, command: "nvim", title: "", role: null, active: false },
    ],
  };

  const html = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {},
  }));

  assert.match(html, /claude/);
  assert.match(html, /Opus 5/);
  assert.match(html, /review/);
  assert.match(html, /nvim/);
});

/** Una gestionada mínima, para los tests del inspector. */
function sessionFixture(): TmuxSessionInfo {
  return {
    name: "cowork-x", kind: "managed", attached: false, adopted: false, windows: 1, createdAt: 0,
    panes: [{ id: "%1", windowIndex: 0, command: "zsh", title: "", role: "conductor", active: true }],
  };
}

test("SessionInspector: una sesión con flujo enseña el riel de etapas", () => {
  const sesion = {
    ...sessionFixture(),
    flow: {
      workflow: "Claude plan → Codex impl", done: 1, total: 2,
      stages: [
        { key: "planning", label: "Plan", icon: "📋", status: "done" as const, at: Date.now() - 600_000 },
        { key: "tests", label: "Pruebas", icon: "✅", status: "current" as const, at: Date.now() - 60_000 },
      ],
    },
  };
  const html = renderToString(createElement(SessionInspector, { session: sesion, diagnostic: null }));
  assert.match(html, /ron-flow-list/);
  assert.match(html, /Pruebas/);
  assert.match(html, /Claude plan/);
});

test("SessionInspector: sin flujo el inspector queda como estaba, sin cascarón vacío", () => {
  const html = renderToString(createElement(SessionInspector, { session: sessionFixture(), diagnostic: null }));
  assert.doesNotMatch(html, /ron-flow/);
});

test("SessionInspector: un diagnóstico de tmux manda sobre el flujo", () => {
  // Si tmux no responde, lo que hay que leer es el error, no un avance que ya no se puede confiar.
  const sesion = { ...sessionFixture(), flow: { done: 0, total: 1, stages: [{ key: "a", label: "A", status: "current" as const }] } };
  const html = renderToString(createElement(SessionInspector, {
    session: sesion,
    diagnostic: { code: "TMUX_NOT_FOUND", detail: "no se encontró tmux en el PATH" },
  }));
  assert.doesNotMatch(html, /ron-flow/);
});
