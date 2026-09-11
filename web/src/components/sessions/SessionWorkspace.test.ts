import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("SessionWorkspace: una gestionada sin nada anotado ofrece adoptarla", () => {
  // Es gestionada sólo porque su cycle dir existe. Sin este botón no hay forma de darle un flujo.
  const session: TmuxSessionInfo = { ...sessionFixture(), unrecorded: true };
  const html = renderToString(createElement(SessionWorkspace, {
    session, diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {},
  }));
  assert.match(html, /Adoptar/);
});

test("SessionWorkspace: una gestionada normal sigue sin ofrecer adopción", () => {
  const html = renderToString(createElement(SessionWorkspace, {
    session: sessionFixture(), diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {},
  }));
  assert.doesNotMatch(html, /Adoptar/);
});

test("SessionInspector: la sesión sin registrar dice por qué no tiene etapas", () => {
  const html = renderToString(createElement(SessionInspector, {
    session: { ...sessionFixture(), unrecorded: true }, diagnostic: null,
  }));
  assert.match(html, /Sin flujo registrado/);
});

test("SessionWorkspace: el reporte de limpieza se monta en el propio workspace para sobrevivir a que la sesión salga del inventario (pin)", () => {
  const source = readFileSync(new URL("./SessionWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /setClosedReport\(\{ session: session\.name, report \}\)/);
  // Aparece también en la rama SIN sesión: tras cerrar, el inventario (5 s) deja `session` en null.
  assert.match(source, /Nueva sesión<\/button>\{cleanupModal\}<\/div>/);
});

test("nextSelectedPane: al entrar a una sesión (o si el elegido se fue) elige el pane ACTIVO de tmux, no el primero", () => {
  const panes = [{ id: "%214", active: false }, { id: "%215", active: true }, { id: "%216", active: false }];
  assert.equal(nextSelectedPane(null, panes), "%215");
  assert.equal(nextSelectedPane("%999", panes), "%215");
  // la elección del operador dentro de la sesión se respeta aunque no sea el activo
  assert.equal(nextSelectedPane("%216", panes), "%216");
  // sin bandera de activo, el primero sigue siendo la reserva
  assert.equal(nextSelectedPane(null, [{ id: "%214" }, { id: "%215" }]), "%214");
});

test("SessionWorkspace SSR: la lista marca el pane activo de tmux y lo abre por defecto", () => {
  const session: TmuxSessionInfo = {
    name: "s", kind: "managed", attached: false, adopted: false, windows: 2, createdAt: 0,
    panes: [
      { id: "%1", windowIndex: 0, command: "zsh", title: "", role: null, active: false },
      { id: "%2", windowIndex: 1, command: "claude", title: "", role: "impl", active: true },
    ],
  };
  const html = renderToString(createElement(SessionWorkspace, { session, diagnostic: null, terminalUrl: null, onRefresh: async () => {}, onNew: () => {} }));
  const buttons = [...html.matchAll(/<button[^>]*data-pane-id="(%\d+)"[^>]*>/g)].map(([tag, id]) => ({ id, tag }));
  assert.deepEqual(buttons.map((b) => b.id), ["%1", "%2"]);
  assert.match(buttons[1].tag, /data-active="true"/);
  assert.doesNotMatch(buttons[0].tag, /data-active="true"/);
  assert.match(buttons[1].tag, /class="chosen"/, "el activo es el seleccionado al entrar");
  assert.doesNotMatch(buttons[0].tag, /class="chosen"/);
  assert.match(html, /activo/);
});
