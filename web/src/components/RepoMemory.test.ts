import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { memoryBudgetLabel, memoryCounts, RepoMemorySection } from "./RepoMemory.js";
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
