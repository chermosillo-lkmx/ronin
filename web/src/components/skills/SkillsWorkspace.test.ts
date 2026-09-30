import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SkillListItem, skillMetaLabel, SkillsInspector, SkillsTabs, SkillsWorkspace } from "./SkillsWorkspace.js";

const learned = { ref: { root: "learned" as const, name: "migracion-reversible" }, name: "migracion-reversible", description: "Migra.", valid: true, integrity: "ok" as const, version: 2, uses: 4 };

test("la lista marca versión y usos de las learned y ⚠ Revisar en las modificadas fuera de Ronin", () => {
  assert.equal(skillMetaLabel(learned), "learned · v2 · 4 usos");
  assert.equal(skillMetaLabel({ ...learned, uses: 1 }), "learned · v2 · 1 uso");
  assert.equal(skillMetaLabel({ ref: { root: "global", name: "api-review" }, name: "api-review", description: "x", valid: true }), "global");
  const ok = renderToString(createElement(SkillListItem, { skill: learned, selected: false, onSelect: () => {} }));
  assert.doesNotMatch(ok, /Revisar/);
  const modified = renderToString(createElement(SkillListItem, { skill: { ...learned, integrity: "modified" }, selected: true, onSelect: () => {} }));
  assert.match(modified, /class="selected"/);
  assert.match(modified, /⚠ Revisar/);
});

test("las pestañas muestran Propuestas (N) y la vista abre la pestaña pedida", () => {
  const tabs = renderToString(createElement(SkillsTabs, { tab: "proposals", count: 3, onTab: () => {} }));
  assert.match(tabs, /aria-selected="true"[^>]*>Propuestas \(3\)</);
  const proposals = renderToString(createElement(SkillsWorkspace, {
    initialTab: "proposals",
    initialProposals: [{ id: "s_1", kind: "new", name: "migracion-reversible", repo: "acme-api", source: "cowork-mig", description: "Migra.", warnings: [], createdAt: 1 }],
  }));
  assert.match(proposals, /Propuestas \(1\)/);
  assert.match(proposals, /nueva · acme-api/);
  assert.doesNotMatch(proposals, /activación por repo/);
  const skills = renderToString(createElement(SkillsWorkspace, { initialProposals: [] }));
  assert.match(skills, /activación por repo/);
  assert.match(skills, /Propuestas \(0\)/);
});

test("SkillsInspector anuncia el índice en el lanzamiento en vez de 'Sin inyección de prompt'", () => {
  const html = renderToString(createElement(SkillsInspector));
  assert.match(html, /Índice en el lanzamiento \(1 KB\)/);
  assert.doesNotMatch(html, /Sin inyección de prompt/);
});
