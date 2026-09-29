import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DistillPanel, distillLabel } from "./DistillPanel.js";
import { runExclusive } from "../in-flight.js";

test("distillLabel describe cada estado de la destilación", () => {
  assert.equal(distillLabel(null), "Sin destilar");
  assert.equal(distillLabel({ status: "running", repo: "acme-api", at: 1 }), "Destilando aprendizajes…");
  assert.equal(distillLabel({ status: "done", repo: "acme-api", at: 1, proposed: 2 }), "2 propuestas para revisar");
  assert.equal(distillLabel({ status: "done", repo: "acme-api", at: 1, proposed: 1 }), "1 propuesta para revisar");
  assert.equal(distillLabel({ status: "done", repo: "acme-api", at: 1, proposed: 0 }), "Sin aprendizajes nuevos");
  assert.equal(distillLabel({ status: "failed", repo: "acme-api", at: 1, error: "sin cuota" }), "Falló: sin cuota");
  assert.equal(distillLabel({ status: "skipped", repo: "acme-api", at: 1, reason: "la sesión no dejó evidencia" }), "Omitida: la sesión no dejó evidencia");
});

test("DistillPanel ofrece Destilar, Reintentar tras un fallo y se deshabilita en curso", () => {
  const idle = renderToString(createElement(DistillPanel, { session: "cowork-csv", memory: { repo: "acme-api", pending: 0, distill: null } }));
  assert.match(idle, /Destilar aprendizajes/);
  const failed = renderToString(createElement(DistillPanel, { session: "cowork-csv", memory: { repo: "acme-api", pending: 0, distill: { status: "failed", repo: "acme-api", at: 1, error: "sin cuota" } } }));
  assert.match(failed, /Reintentar/);
  assert.match(failed, /Falló: sin cuota/);
  const running = renderToString(createElement(DistillPanel, { session: "cowork-csv", memory: { repo: "acme-api", pending: 2, distill: { status: "running", repo: "acme-api", at: 1 } } }));
  assert.match(running, /<button[^>]*disabled=""[^>]*>Destilar aprendizajes<\/button>/);
  assert.match(running, /2 pendientes en acme-api/);
});

test("DistillPanel deshabilita el botón mientras su POST está en curso", () => {
  const busy = renderToString(createElement(DistillPanel, { session: "cowork-csv", memory: { repo: "acme-api", pending: 0, distill: null }, initialBusy: true }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Destilar aprendizajes<\/button>/);
  const idle = renderToString(createElement(DistillPanel, { session: "cowork-csv", memory: { repo: "acme-api", pending: 0, distill: null } }));
  assert.doesNotMatch(idle, /disabled=""/);
});

test("runExclusive ignora un segundo clic mientras la primera petición sigue en curso y libera al terminar o fallar", async () => {
  const lock = { current: false };
  const states: boolean[] = [];
  let release!: () => void;
  let calls = 0;
  const first = runExclusive(lock, (busy) => states.push(busy), () => { calls++; return new Promise<string>((resolve) => { release = () => resolve("ok"); }); });
  assert.equal(await runExclusive(lock, (busy) => states.push(busy), async () => { calls++; return "otra"; }), undefined);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, "ok");
  assert.deepEqual(states, [true, false]);
  assert.equal(lock.current, false);
  await assert.rejects(runExclusive(lock, (busy) => states.push(busy), async () => { throw new Error("falló"); }), /falló/);
  assert.equal(lock.current, false);
  assert.deepEqual(states, [true, false, true, false]);
});
