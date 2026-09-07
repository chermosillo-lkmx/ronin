import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { nextSelectedPane, SessionWorkspace } from "./SessionWorkspace.js";
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
