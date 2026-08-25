import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ProposalList } from "./ProposalList.js";
import type { WorkflowAnalysis, WorkflowProposal } from "../types.js";

const P: WorkflowProposal = {
  id: "prop-1",
  analysisId: "an-1",
  name: "hotfix-rapido",
  rationale: "Tres tickets de hotfix cerraron sin etapa de plan.",
  evidence: ["CU-1", "9f3ac21"],
  config: { stages: [{ key: "impl", label: "Impl", icon: "⌨️", role: "impl" }], verifyAfter: null },
  status: "proposed",
  createdAt: "2026-08-24T10:00:00.000Z",
};

const A: WorkflowAnalysis = {
  id: "an-1",
  from: "2026-08-10T00:00:00.000Z",
  to: "2026-08-24T00:00:00.000Z",
  status: "done",
  createdAt: "2026-08-24T10:00:00.000Z",
  proposalIds: ["prop-1"],
  discarded: [],
  signals: { tasks: 4, commits: 12, evidenceFiles: 2 },
};

test("ProposalList renders name, rationale, evidence and both actions; empty state and running state are distinct", () => {
  const html = renderToString(createElement(ProposalList, { proposals: [P], analysis: null, busy: false, onAccept: () => {}, onDismiss: () => {} }));
  assert.match(html, /hotfix-rapido/);
  assert.match(html, /CU-1/);
  assert.match(html, /Aceptar/);
  assert.match(html, /Descartar/);
  assert.match(renderToString(createElement(ProposalList, { proposals: [], analysis: null, busy: false, onAccept: () => {}, onDismiss: () => {} })), /Sin propuestas/);
  assert.match(renderToString(createElement(ProposalList, { proposals: [], analysis: { ...A, status: "running" }, busy: false, onAccept: () => {}, onDismiss: () => {} })), /Analizando/);
  assert.match(renderToString(createElement(ProposalList, { proposals: [], analysis: { ...A, status: "error", error: "claude no está" }, busy: false, onAccept: () => {}, onDismiss: () => {} })), /claude no está/);
});

test("ProposalList shows the rationale, the analysis id while running and the discarded notes", () => {
  const html = renderToString(createElement(ProposalList, { proposals: [P], analysis: A, busy: false, onAccept: () => {}, onDismiss: () => {} }));
  assert.match(html, /cerraron sin etapa de plan/);
  assert.match(html, /9f3ac21/);

  const running = renderToString(createElement(ProposalList, { proposals: [], analysis: { ...A, status: "running" }, busy: false, onAccept: () => {}, onDismiss: () => {} }));
  assert.match(running, /Analizando… \(an-1\)/);
  assert.doesNotMatch(running, /Sin propuestas/);

  const discarded = renderToString(createElement(ProposalList, { proposals: [P], analysis: { ...A, discarded: [{ name: "repetido", reason: "nombre duplicado" }, { reason: "etapas inválidas" }] }, busy: false, onAccept: () => {}, onDismiss: () => {} }));
  assert.match(discarded, /repetido — nombre duplicado/);
  assert.match(discarded, /etapas inválidas/);
});

test("ProposalList disables both actions while busy", () => {
  const html = renderToString(createElement(ProposalList, { proposals: [P], analysis: A, busy: true, onAccept: () => {}, onDismiss: () => {} }));
  assert.equal(html.split("disabled=\"\"").length - 1, 2);
});

test("ProposalList renders the stage chain with instructions, in order", () => {
  const proposal: WorkflowProposal = {
    ...P,
    config: {
      stages: [
        { key: "plan", label: "Plan", icon: "📝" },
        { key: "impl", label: "Impl", icon: "⌨️", role: "impl", instruction: "Ejecuta pytest antes de abrir PR" },
      ],
      verifyAfter: "impl",
    },
  };
  const html = renderToString(createElement(ProposalList, { proposals: [proposal], analysis: null, busy: false, onAccept: () => {}, onDismiss: () => {} }));
  assert.match(html, /Ejecuta pytest antes de abrir PR/);
  const planIndex = html.indexOf(">plan<");
  const implIndex = html.indexOf(">impl<");
  const instructionIndex = html.indexOf("Ejecuta pytest antes de abrir PR");
  assert.ok(planIndex >= 0 && implIndex >= 0 && instructionIndex >= 0);
  assert.ok(planIndex < implIndex);
  assert.ok(implIndex < instructionIndex);
  assert.match(html, /verifyAfter: impl/);
});
