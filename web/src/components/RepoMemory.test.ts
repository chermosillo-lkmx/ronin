import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryNote, memoryBudgetLabel, memoryCounts, removeMemoryItem, RepoMemoryDetails, RepoMemorySection } from "./RepoMemory.js";
import type { RepoMemoryView } from "../types.js";

const MEMORY_VIEW: RepoMemoryView = {
  repo: "acme-api",
  enabled: true,
  globalEnabled: true,
  entries: [
    { id: "m_1", text: "Tests: usar `make test-unit`", kind: "comando", source: "cowork-csv-retry", createdAt: 1, updatedAt: 1, status: "active", uses: 3 },
    { id: "m_2", text: "El puerto 5432 lo ocupa docker", kind: "trampa", source: "cowork-csv-retry", createdAt: 2, updatedAt: 2, status: "pending", uses: 0 },
  ],
  kbSuggestions: [{ id: "k_1", text: "El importador CSV vive en src/csv", source: "cowork-csv-retry", createdAt: 3 }],
  preview: { text: "Memoria del repo acme-api (aprendizajes aprobados por el usuario; verifícalos si algo no cuadra):\n- [comando] Tests: usar `make test-unit`", bytes: 1229, maxBytes: 2048, omitted: 0 },
};

const render = (props: Parameters<typeof RepoMemorySection>[0]) => renderToString(createElement(RepoMemorySection, props));

test("memoryBudgetLabel y memoryCounts resumen la vista", () => {
  assert.equal(memoryBudgetLabel(1229, 2048), "1.2 / 2 KB");
  assert.equal(memoryBudgetLabel(0, 2048), "0 / 2 KB");
  assert.deepEqual(memoryCounts(MEMORY_VIEW), { active: 1, pending: 1, kb: 1 });
});

test("la sección Memoria muestra el interruptor, la vista previa con su tamaño y las tres pestañas", () => {
  const html = render({ repo: "acme-api", initial: MEMORY_VIEW });
  assert.match(html, /type="checkbox"[^>]*checked=""/);
  assert.match(html, /Esto recibe cada sesión nueva \(1\.2 \/ 2 KB\)/);
  assert.match(html, /Activas · 1/);
  assert.match(html, /Pendientes · 1/);
  assert.match(html, /Para la KB · 1/);
  assert.match(html, /Agregar/);
});

test("Activas permite editar y borrar; Pendientes aprobar, editar y aprobar, descartar; Para la KB borrar", () => {
  const active = render({ repo: "acme-api", initial: MEMORY_VIEW });
  assert.match(active, /Tests: usar `make test-unit`/);
  assert.match(active, />Editar</);
  assert.match(active, />Borrar</);
  assert.doesNotMatch(active, /El puerto 5432/);

  const pending = render({ repo: "acme-api", initial: MEMORY_VIEW, initialTab: "pending" });
  assert.match(pending, /El puerto 5432 lo ocupa docker/);
  assert.match(pending, /✅ Aprobar/);
  assert.match(pending, /✏️ Editar y aprobar/);
  assert.match(pending, /❌ Descartar/);

  const kb = render({ repo: "acme-api", initial: MEMORY_VIEW, initialTab: "kb" });
  assert.match(kb, /El importador CSV vive en src\/csv/);
  assert.match(kb, />Borrar</);
});

test("con COWORK_MEMORY=0 el interruptor queda deshabilitado y se explica", () => {
  const html = render({ repo: "acme-api", initial: { ...MEMORY_VIEW, globalEnabled: false } });
  assert.match(html, /type="checkbox"[^>]*disabled=""/);
  assert.match(html, /COWORK_MEMORY=0/);
});

test("Borrar una activa la descarta con PATCH (conserva el historial para deduplicar); en Para la KB usa DELETE", async () => {
  const calls: string[] = [];
  const api = {
    resolveRepoMemory: async (repo: string, id: string, action: string) => { calls.push(`PATCH ${repo} ${id} ${action}`); return MEMORY_VIEW; },
    deleteRepoMemory: async (repo: string, id: string) => { calls.push(`DELETE ${repo} ${id}`); return MEMORY_VIEW; },
  };
  await removeMemoryItem("acme-api", "m_1", "entry", api);
  await removeMemoryItem("acme-api", "k_1", "kb", api);
  assert.deepEqual(calls, ["PATCH acme-api m_1 discard", "DELETE acme-api k_1"]);
});

test("con una petición en curso se deshabilitan el interruptor, Agregar y todas las acciones", () => {
  const buttons = (html: string) => [...html.matchAll(/<button(?![^>]*role="tab")[^>]*>/g)].map((match) => match[0]);
  for (const initialTab of ["active", "pending", "kb"] as const) {
    const html = render({ repo: "acme-api", initial: MEMORY_VIEW, initialTab, initialBusy: true });
    assert.match(html, /type="checkbox"[^>]*disabled=""/);
    const found = buttons(html);
    assert.ok(found.length >= 2, `${initialTab}: hay botones`);
    for (const button of found) assert.match(button, /disabled=""/, `${initialTab}: ${button}`);
  }
  const idle = render({ repo: "acme-api", initial: MEMORY_VIEW });
  assert.doesNotMatch(idle, /<button[^>]*disabled=""[^>]*>Borrar</);
});

test("si la carga de la memoria falla se avisa en vez de quedarse en Cargando", () => {
  const failed = renderToString(createElement(RepoMemoryDetails, { repo: "acme-api", view: null, onChange: () => {} }));
  assert.match(failed, /role="alert"[^>]*>No se pudo cargar la memoria de este repo\.</);
  assert.doesNotMatch(failed, /Cargando memoria/);
  const loading = renderToString(createElement(RepoMemoryDetails, { repo: "acme-api", onChange: () => {} }));
  assert.match(loading, /Cargando memoria…/);
});

test("las notas de error usan role=alert y las de éxito role=status", () => {
  assert.match(renderToString(createElement(MemoryNote, { note: { text: "no se pudo borrar", error: true } })), /role="alert"/);
  assert.match(renderToString(createElement(MemoryNote, { note: { text: "Aprendizaje borrado.", error: false } })), /role="status"/);
  assert.equal(renderToString(createElement(MemoryNote, { note: null })), "");
});

test("Pendientes explica qué pasa con lo que se aprueba", () => {
  const pending = render({ repo: "acme-api", initial: MEMORY_VIEW, initialTab: "pending" });
  assert.match(pending, /Lo que apruebes llega a cada sesión nueva de este repo como si lo hubieras escrito tú\./);
  assert.doesNotMatch(render({ repo: "acme-api", initial: MEMORY_VIEW }), /Lo que apruebes/);
});
