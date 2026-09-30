import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SkillPanel, skillStateLabel } from "./SkillPanel.js";

test("skillStateLabel describe cada estado de la parte de skill", () => {
  assert.equal(skillStateLabel(null), "Sin proponer");
  assert.equal(skillStateLabel({ status: "running", at: 1 }), "Redactando la skill…");
  assert.equal(skillStateLabel({ status: "done", at: 1, proposalId: "s_4k9z1p" }), "Propuesta s_4k9z1p lista para revisar en Skills → Propuestas");
  assert.equal(skillStateLabel({ status: "skipped", at: 1, reason: "sin gate determinista aprobado" }), "Omitida: sin gate determinista aprobado");
  assert.equal(skillStateLabel({ status: "failed", at: 1, error: "sin cuota" }), "Falló: sin cuota");
});

test("SkillPanel ofrece Proponer skill, Reintentar tras un fallo y se deshabilita mientras su POST está en curso", () => {
  const idle = renderToString(createElement(SkillPanel, { session: "cowork-mig", skills: { repo: "acme-api", state: null } }));
  assert.match(idle, /<button[^>]*>Proponer skill<\/button>/);
  assert.doesNotMatch(idle, /disabled=""/);
  const failed = renderToString(createElement(SkillPanel, { session: "cowork-mig", skills: { repo: "acme-api", state: { status: "failed", at: 1, error: "sin cuota" } } }));
  assert.match(failed, />Reintentar</);
  const busy = renderToString(createElement(SkillPanel, { session: "cowork-mig", skills: { repo: "acme-api", state: null }, initialBusy: true }));
  assert.match(busy, /disabled=""/);
});

test("final F3: Proponer skill sólo aparece sin estado, omitida o fallida (no en curso ni hecha)", () => {
  const render = (state: Parameters<typeof skillStateLabel>[0]) => renderToString(createElement(SkillPanel, { session: "cowork-mig", skills: { repo: "acme-api", state } }));
  assert.match(render(null), />Proponer skill</);
  assert.match(render({ status: "skipped", at: 1, reason: "sin gate determinista aprobado" }), />Proponer skill</);
  assert.match(render({ status: "failed", at: 1, error: "sin cuota" }), />Reintentar</);
  for (const state of [{ status: "running" as const, at: 1 }, { status: "done" as const, at: 1, proposalId: "s_1" }]) {
    const html = render(state);
    assert.doesNotMatch(html, /<button/, state.status);
    assert.match(html, /ron-distill-status/);
  }
});
