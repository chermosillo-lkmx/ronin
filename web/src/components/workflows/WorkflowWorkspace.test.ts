import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { WorkflowWorkspace } from "./WorkflowWorkspace.js";
import type { WorkflowCatalogItem } from "../../types.js";

const only: WorkflowCatalogItem = { id: "default", name: "default", updatedAt: 0, config: { stages: [{ key: "plan", label: "Plan", icon: "📋" }], verifyAfter: null } };

test("WorkflowWorkspace exposes catalogue actions and protects its only loop", () => {
  const html = renderToString(createElement(WorkflowWorkspace, { initialCatalog: [only], onLaunch: () => {} }));
  assert.match(html, /＋ Nuevo/);
  assert.match(html, /Eliminar/);
  assert.match(html, /✦ Analizar flujo reciente/);
  assert.match(html, /disabled=""[^>]*>Eliminar/);
});
