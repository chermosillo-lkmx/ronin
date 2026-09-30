import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { RepoSkillLearningToggle } from "./RepoSkillLearning.js";

test("RepoSkillLearningToggle: encendido, apagado, apagado en el equipo y cargando", () => {
  const on = renderToString(createElement(RepoSkillLearningToggle, { repo: "acme-api", initial: { repo: "acme-api", enabled: true, globalEnabled: true } }));
  assert.match(on, /<input type="checkbox" checked=""\/>/);
  assert.match(on, /🧩 Aprender skills/);
  assert.match(on, /nada entra sin tu aprobación/);
  const off = renderToString(createElement(RepoSkillLearningToggle, { repo: "acme-api", initial: { repo: "acme-api", enabled: false, globalEnabled: true } }));
  assert.match(off, /<input type="checkbox"\/>/);
  const global = renderToString(createElement(RepoSkillLearningToggle, { repo: "acme-api", initial: { repo: "acme-api", enabled: true, globalEnabled: false } }));
  assert.match(global, /disabled=""/);
  assert.match(global, /COWORK_LEARNED_SKILLS=0/);
  const loading = renderToString(createElement(RepoSkillLearningToggle, { repo: "acme-api" }));
  assert.match(loading, /disabled=""/);
  const busy = renderToString(createElement(RepoSkillLearningToggle, { repo: "acme-api", initial: { repo: "acme-api", enabled: true, globalEnabled: true }, initialBusy: true }));
  assert.match(busy, /disabled=""/);
});
