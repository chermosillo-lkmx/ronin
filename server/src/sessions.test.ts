import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifySession, isSafeSessionName, parsePaneList, parseSessionList } from "./sessions.js";

// Salidas de `tmux list-sessions -F` y `tmux list-panes -a -F` con los formatos de sessions.ts.
const SESSIONS = [
  "cowork-CU-42-driver\t1\t1753747200\t1",
  "dev-scratch\t2\t1753574400\t0",
  "0\t1\t1753660800\t0",
].join("\n");

test("parseSessionList: nombre, ventanas, creación en ms y attached", () => {
  const out = parseSessionList(SESSIONS);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    name: "cowork-CU-42-driver",
    windows: 1,
    createdAt: 1753747200_000, // tmux da SEGUNDOS; el resto del repo trabaja en ms
    attached: true,
  });
  assert.equal(out[1].attached, false);
});

test("parseSessionList: una sesión llamada '0' no se pierde", () => {
  // tmux nombra con enteros las sesiones sin nombre: en esta máquina hay 12 así
  // (`2`, `10`, `14`, `83`, …). Un `if (!name)` las tiraría todas.
  const out = parseSessionList(SESSIONS);
  assert.ok(out.some((s) => s.name === "0"));
});

test("parseSessionList: ignora líneas vacías y basura sin reventar", () => {
  // El fixture lleva basura DE VERDAD, no sólo líneas vacías: una línea sin TABs. Sin ella el
  // test seguiría verde aunque alguien rompiera el manejo de una línea con menos de 4 campos.
  const out = parseSessionList("\n\ncowork-x\t1\t1753747200\t0\nbasura-sin-tabs\n\n");
  assert.equal(out.length, 2); // la basura produce una entrada degradada, no una excepción
  assert.equal(out[0].name, "cowork-x");
  assert.deepEqual(out[1], { name: "basura-sin-tabs", windows: 0, createdAt: 0, attached: false });
});

const PANES = [
  "cowork-CU-42-driver\t0\t%20\t2.1.220\tMAIN\tdriver\t1",
  "cowork-CU-42-driver\t0\t%21\t2.1.220\tIMPL\tworker\t0",
  "dev-scratch\t0\t%7\tnvim\t\t\t0",
  "dev-scratch\t1\t%9\tpnpm\t\t\t1",
].join("\n");

test("parsePaneList: agrupa por sesión conservando el orden", () => {
  const m = parsePaneList(PANES);
  assert.deepEqual([...m.keys()].sort(), ["cowork-CU-42-driver", "dev-scratch"]);
  assert.equal(m.get("cowork-CU-42-driver")!.length, 2);
  assert.equal(m.get("dev-scratch")![0].id, "%7");
});

test("parsePaneList: un @cowork-role ausente es null, no cadena vacía", () => {
  // tmux sustituye una opción no seteada por "". El consumidor distingue "sin rol" de "rol
  // vacío": un "" se colaría como clave en un Record<PaneRole,…> y el pane aparecería con rol.
  const m = parsePaneList(PANES);
  assert.equal(m.get("cowork-CU-42-driver")![0].role, "driver");
  assert.equal(m.get("dev-scratch")![0].role, null);
});

test("parsePaneList: windowIndex y active se tipan, no se dejan como string", () => {
  const m = parsePaneList(PANES);
  const p = m.get("dev-scratch")![1];
  assert.equal(p.windowIndex, 1);
  assert.equal(p.active, true);
  assert.equal(p.command, "pnpm");
});

test("parsePaneList: un pane_title con espacios sobrevive al split por TAB", () => {
  // Los títulos reales son frases enteras. Separar por espacio partiría el título y correría
  // todas las columnas siguientes: el rol se leería de un trozo del título.
  const m = parsePaneList("s\t0\t%1\t2.1.220\t✳ Implementar algo largo\tdriver\t1");
  assert.equal(m.get("s")![0].title, "✳ Implementar algo largo");
  assert.equal(m.get("s")![0].role, "driver");
});

test("parsePaneList: descarta una línea sin %N en vez de inventar un target", () => {
  const m = parsePaneList("s\t0\tNO-ES-UN-PANE\tzsh\t\t\t1");
  assert.equal(m.size, 0);
});

test("classifySession: gestionada exige prefijo cowork- Y cycle dir", () => {
  // El prefijo solo no basta: una sesión que el operador llamó `cowork-pruebas` a mano no tiene
  // sentinels, y anunciarla como gestionada congelaría su stepper para siempre. En esta máquina
  // hay 4 sesiones `cowork-*` sin cycle dir.
  assert.equal(classifySession("cowork-CU-42-driver", true), "managed");
  assert.equal(classifySession("cowork-CU-42-driver", false), "foreign");
  assert.equal(classifySession("dev-scratch", true), "foreign");
  assert.equal(classifySession("dev-scratch", false), "foreign");
});

test("isSafeSessionName: rechaza lo que no puede ir en una ruta", () => {
  // El nombre alimenta `cycleDirForSession`, que es concatenación de strings (stages.ts:15) y
  // lo comparten `ensureCycleDir` y `removeCycleDir` (rmSync). tmux HOY sanitiza `.` y `:` en
  // los nombres, así que esto es defensa en profundidad — pero F1 es la primera vez que un
  // nombre AJENO llega a ese helper, y F2 (adopción) lo llevará a un camino de escritura.
  assert.equal(isSafeSessionName("cowork-adhoc-mrz96md7"), true);
  assert.equal(isSafeSessionName("113"), true);
  assert.equal(isSafeSessionName("../../etc"), false);
  assert.equal(isSafeSessionName("a/b"), false);
  assert.equal(isSafeSessionName(""), false);
});
