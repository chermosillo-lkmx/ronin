import assert from "node:assert/strict";
import test from "node:test";
import type { Signals } from "./signals.js";
import { buildPrompt, extractProposalsJson } from "./prompt.js";

const signals: Signals = {
  range: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-24T00:00:00.000Z" },
  tasks: [
    {
      key: "CU-1",
      title: "Arreglar login",
      source: "clickup",
      repo: "api",
      launches: 3,
      stops: 1,
      completes: 1,
      firstTs: 1,
      lastTs: 2,
      lastEvidence: "hecho",
      body: "revisar OAuth",
    },
  ],
  commits: {
    api: [{ hash: "abc123", subject: "fix: login", ts: 3 }],
  },
  evidence: [{ repo: "api", file: "EVIDENCIA-login.md", mtime: 4, excerpt: "notas" }],
};

test("buildPrompt lists the catalog, the stage schema and the signals, in Spanish", () => {
  const p = buildPrompt(signals, ["default", "hotfix"]);
  assert.match(p, /Workflows existentes: default, hotfix/);
  assert.match(p, /"role": "impl"/);
  assert.match(p, /CU-1/);
  assert.match(p, /<PROPOSALS>/);
  assert.doesNotMatch(p, /verifyCmd/); // nunca se ofrece ese campo
});

test("buildPrompt reports an empty catalog as (ninguno)", () => {
  const p = buildPrompt(signals, []);
  assert.match(p, /Workflows existentes: \(ninguno\)/);
});

test("extractProposalsJson parses the tagged block and rejects missing/invalid JSON", () => {
  assert.deepEqual(extractProposalsJson('bla <PROPOSALS>{"proposals":[]}</PROPOSALS> fin'), { proposals: [] });
  assert.throws(() => extractProposalsJson("sin bloque"), /JSON válido/);
  assert.throws(() => extractProposalsJson("<PROPOSALS>{no</PROPOSALS>"), /JSON válido/);
});
