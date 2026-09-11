import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WorkflowWorkspace } from "./WorkflowWorkspace.js";
import type { WorkflowCatalogItem } from "../../types.js";

const only: WorkflowCatalogItem = { id: "default", name: "default", updatedAt: 0, config: { stages: [{ key: "plan", label: "Plan", icon: "📋" }], verifyAfter: [] } };
const harnessCatalog: WorkflowCatalogItem[] = [{ id: "harness", name: "harness", updatedAt: 0, config: { stages: [{ key: "plan", label: "Plan", icon: "📋", verifyCmd: "npm test", maxRetries: 2 }, { key: "impl", label: "Impl", icon: "⌨️", instruction: "escribe plan.md", executor: "codex" }], verifyAfter: ["impl"] } }];

function harnessHtml() {
  return renderToString(createElement(WorkflowWorkspace, { initialCatalog: harnessCatalog, initialView: "harness", onLaunch: () => {} }));
}

function controlButton(html: string, stageKey: string, control: string) {
  const button = [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`data-control="${control}"`) && tag.includes(`data-stage-key="${stageKey}"`));
  assert.ok(button, `falta ${stageKey}.${control}`);
  return button;
}

function bandButton(html: string, band: string) {
  const button = [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag).find((tag) => tag.includes(`data-band="${band}"`));
  assert.ok(button, `falta la banda ${band}`);
  return button;
}

test("WorkflowWorkspace exposes catalogue actions and protects its only loop", () => {
  const html = renderToString(createElement(WorkflowWorkspace, { initialCatalog: [only], onLaunch: () => {} }));
  assert.match(html, /＋ Nuevo/);
  assert.match(html, /Eliminar/);
  assert.match(html, /✦ Analizar flujo reciente/);
  assert.match(html, /disabled=""[^>]*>Eliminar/);
});

test("el segmento de vistas ofrece Harness como cuarta pestaña", () => {
  const html = renderToString(createElement(WorkflowWorkspace, { initialCatalog: [only], onLaunch: () => {} }));
  const segment = html.match(/<div class="ronin-segment">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(segment);
  assert.deepEqual([...segment.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]), ["Grafo", "Stepper", "JSON", "Harness"]);
});

test("initialView:'harness' marca activa esa pestaña", () => {
  const html = renderToString(createElement(WorkflowWorkspace, { initialCatalog: [only], initialView: "harness", onLaunch: () => {} }));
  const segment = html.match(/<div class="ronin-segment">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(segment);
  assert.match(segment, /<button class="active">Harness<\/button>/);
  assert.doesNotMatch(segment, /<button class="active">Grafo<\/button>/);
});

test("en vista Harness pinta una fila por etapa y los controles visibles", () => {
  const html = harnessHtml();
  assert.equal(html.split('class="wf-harness-row"').length - 1, 2);
  for (const stageKey of ["plan", "impl"]) for (const control of ["verifyCmd", "verifier"]) controlButton(html, stageKey, control);
  assert.match(controlButton(html, "impl", "verifier"), /aria-pressed="true"/);
  assert.match(html, /codex/);
  assert.doesNotMatch(html, /class="wf-graph"/);
});

test("en el catálogo verifyCmd y la banda Gates están habilitados", () => {
  const html = harnessHtml();
  for (const stageKey of ["plan", "impl"]) assert.doesNotMatch(controlButton(html, stageKey, "verifyCmd"), /disabled=""/);
  assert.doesNotMatch(bandButton(html, "gates"), /disabled=""/);
});

test("el medidor cuenta los gates configurados en el catálogo", () => {
  const html = harnessHtml();
  assert.match(html, /data-coverage="1\/2"/);
  assert.match(html, /Una sola etapa deja artefacto/);
});

test("el catálogo con inputs los conserva en el draft que se va a guardar", () => {
  const catalog: WorkflowCatalogItem[] = [{ id: "inputs", name: "inputs", updatedAt: 0, config: { stages: [{ key: "plan", label: "Plan", icon: "📋" }], verifyAfter: [], inputs: [{ key: "ticket", label: "Ticket" }] } }];
  const html = renderToString(createElement(WorkflowWorkspace, { initialCatalog: catalog, initialView: "json", onLaunch: () => {} }));
  const textarea = html.match(/<textarea\b[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
  assert.ok(textarea);
  assert.match(html, /inputs/);
  assert.match(html, /ticket/);
  assert.match(textarea, /inputs/);
  assert.match(textarea, /ticket/);
});

test("el guardado del catálogo declara el pin de cableado sin pérdida", () => {
  const source = readFileSync(new URL("./WorkflowWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /confirmWorkflowSave\(draft, null/);
  assert.match(source, /updateWorkflow\(id, \{ config: workflowPayload\(draft\) \}\)/);
});

test("B3 v2: el catálogo monta HarnessList y habilita gates en lista, Stepper y modal", () => {
  const source = readFileSync(new URL("./WorkflowWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ HarnessList \}/);
  assert.match(source, /<HarnessList/);
  assert.match(source, /const CATALOG_ALLOW_VERIFY_CMD = true/);
  assert.equal(source.match(/allowVerifyCmd=\{CATALOG_ALLOW_VERIFY_CMD\}/g)?.length, 3);
  for (const prop of ["openStage", "onOpenStage", "onToggle", "onEdit", "onBandToggle"]) {
    assert.match(source, new RegExp(`${prop}=`), `falta prop ${prop}`);
  }
});

test("B3 v2: la vista Harness del catálogo pinta filas y cobertura de gates", () => {
  const catalog: WorkflowCatalogItem[] = [{
    ...harnessCatalog[0],
    config: { ...harnessCatalog[0].config, stages: [
      harnessCatalog[0].config.stages[0],
      harnessCatalog[0].config.stages[1],
    ] },
  }];
  const html = renderToString(createElement(WorkflowWorkspace, { initialCatalog: catalog, initialView: "harness", onLaunch: () => {} }));
  assert.equal(html.split('class="wf-harness-row"').length - 1, 2);
  assert.match(html, /data-coverage="1\/2"/);
  assert.doesNotMatch(controlButton(html, "plan", "verifyCmd"), /disabled=""/);
});
