import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { FlowProgress, stageMeta, elapsed } from "./FlowProgress.js";
import type { SessionFlow } from "../../types.js";

const AHORA = 1_700_003_600_000;

const FLUJO: SessionFlow = {
  workflow: "Claude plan → Codex impl",
  done: 2,
  total: 4,
  stages: [
    { key: "planning", label: "Plan", icon: "📋", executor: "claude", status: "done", at: AHORA - 3_060_000 },
    { key: "implementing", label: "Impl", icon: "🤖", executor: "codex", status: "done", at: AHORA - 720_000 },
    { key: "tests", label: "Pruebas", icon: "✅", status: "current", at: AHORA - 480_000 },
    { key: "done", label: "Evidencia", icon: "✓", status: "pending" },
  ],
};

test("FlowProgress: pinta una fila por etapa con su estado", () => {
  const html = renderToString(createElement(FlowProgress, { flow: FLUJO, now: AHORA }));
  for (const etiqueta of ["Plan", "Impl", "Pruebas", "Evidencia"]) assert.match(html, new RegExp(etiqueta));
  assert.equal((html.match(/ron-flow-row/g) ?? []).length, 4);
  assert.match(html, /ron-flow-row done/);
  assert.match(html, /ron-flow-row current/);
  assert.match(html, /ron-flow-row pending/);
});

test("FlowProgress: el contador dice cuántas van de cuántas", () => {
  // renderToString mete `<!-- -->` entre nodos de texto contiguos; se quitan para leer el texto.
  const html = renderToString(createElement(FlowProgress, { flow: FLUJO, now: AHORA })).replace(/<!-- -->/g, "");
  assert.match(html, /2 \/ 4/);
  assert.match(html, /Claude plan/);
});

test("FlowProgress: la etapa en curso es la única con aria-current", () => {
  const html = renderToString(createElement(FlowProgress, { flow: FLUJO, now: AHORA }));
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
});

test("FlowProgress: un flujo terminado no deja ninguna etapa en curso", () => {
  const terminado: SessionFlow = {
    done: 2, total: 2,
    stages: [
      { key: "a", label: "A", status: "done", at: AHORA - 600_000 },
      { key: "b", label: "B", status: "done", at: AHORA - 120_000 },
    ],
  };
  const html = renderToString(createElement(FlowProgress, { flow: terminado, now: AHORA }));
  assert.doesNotMatch(html, /ron-flow-row current/);
  assert.match(html, /Terminado/);
});

test("FlowProgress: una verificación fallida dice en qué intento va", () => {
  const conFallo: SessionFlow = {
    done: 1, total: 2,
    stages: [
      { key: "a", label: "A", status: "done", at: AHORA - 600_000 },
      { key: "b", label: "B", status: "failed", attempts: 2, at: AHORA - 120_000 },
    ],
  };
  const html = renderToString(createElement(FlowProgress, { flow: conFallo, now: AHORA }));
  assert.match(html, /ron-flow-row failed/);
  assert.match(html, /intento 2/);
});

test("elapsed: minutos por debajo de la hora, horas y minutos por encima", () => {
  assert.equal(elapsed(0), "0m");
  assert.equal(elapsed(8 * 60_000), "8m");
  assert.equal(elapsed(59 * 60_000), "59m");
  assert.equal(elapsed(60 * 60_000), "1h");
  assert.equal(elapsed(131 * 60_000), "2h 11m");
});

test("elapsed: un reloj que va hacia atrás no produce un tiempo negativo", () => {
  // El mtime del centinela y el Date.now() del navegador son dos relojes distintos.
  assert.equal(elapsed(-5_000), "0m");
});

test("stageMeta: la cumplida dice motor y hace cuánto; la pendiente sólo el motor", () => {
  assert.equal(stageMeta(FLUJO.stages[0]!, AHORA), "claude · hace 51m");
  assert.equal(stageMeta({ key: "x", label: "X", executor: "claude", status: "pending" }, AHORA), "claude");
  assert.equal(stageMeta({ key: "x", label: "X", status: "pending" }, AHORA), "");
});

test("stageMeta: la etapa en curso muestra el tiempo que lleva", () => {
  assert.equal(stageMeta(FLUJO.stages[2]!, AHORA), "en curso · 8m");
});

test("stageMeta: una cumplida sin mtime no inventa un reloj", () => {
  assert.equal(stageMeta({ key: "x", label: "X", executor: "codex", status: "done" }, AHORA), "codex");
});
