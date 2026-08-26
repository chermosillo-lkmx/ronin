import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSmokeResult } from "./smoke.js";

const BASE = { url: "app://ronin/", root: true, health: true, terminalWindow: true, terminalPane: true, roninShell: true, sessionOpen: true, interactiveTerminal: true, tmuxPaneGrid: true, sessionActions: true, sessionPresentation: true, normalTerminalLaunch: true };

test("evaluateSmokeResult: FALLA cuando el bridge de terminal no está presente, aunque el aislamiento sí lo esté", () => {
  // Rojo contra el smoke.ts de hoy, que exige justo lo contrario: hoy `roninDesktop` está en
  // la lista de globals PROHIBIDOS, así que un bridge que funciona de verdad hace fallar el
  // smoke, y un bridge roto lo hace pasar. Este test fija el criterio correcto.
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: false }), false);
});

test("evaluateSmokeResult: PASA con aislamiento intacto y el bridge de terminal presente", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true }), true);
});

test("evaluateSmokeResult: sigue exigiendo aislamiento — require/process/electron presentes es fallo, sin importar el bridge", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: false, terminalBridge: true }), false);
});

test("evaluateSmokeResult: url/root/health siguen siendo obligatorios", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, url: "app://ronin/recovery", isolated: true, terminalBridge: true }), false);
  assert.equal(evaluateSmokeResult({ ...BASE, root: false, isolated: true, terminalBridge: true }), false);
  assert.equal(evaluateSmokeResult({ ...BASE, health: false, isolated: true, terminalBridge: true }), false);
});

test("evaluateSmokeResult (T9): terminalWindow y terminalPane son obligatorios — un smoke que sólo prueba el bridge existe, sin ejercitar ninguna superficie de verdad, no basta", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, terminalWindow: false }), false);
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, terminalPane: false }), false);
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, terminalWindow: true, terminalPane: true }), true);
});

test("evaluateSmokeResult: exige la shell Nocturne y las cuatro medidas canónicas", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, roninShell: false }), false);
});

test("evaluateSmokeResult: exige que seleccionar una sesión renderice su pane tmux dentro de Electron", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, sessionOpen: false }), false);
});

test("evaluateSmokeResult: exige que Attach monte una terminal interactiva dentro de Electron", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, interactiveTerminal: false }), false);
});

test("evaluateSmokeResult: exige controles visibles para Attach y Cerrar sesión", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, sessionActions: false }), false);
});

test("evaluateSmokeResult: exige que una sesión permita editar su título y repo desde la lista", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, sessionPresentation: false }), false);
});

test("evaluateSmokeResult: exige que Nueva sesión permita crear una terminal normal sin workflow", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, normalTerminalLaunch: false }), false);
});

test("evaluateSmokeResult: exige que Terminales presente todos los panes de tmux, no un attach con espacio vacío", () => {
  assert.equal(evaluateSmokeResult({ ...BASE, isolated: true, terminalBridge: true, tmuxPaneGrid: false }), false);
});
