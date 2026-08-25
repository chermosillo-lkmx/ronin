import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InsightsError, parseRange } from "./model.js";
import { createProposalStore } from "./store.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ronin-workflow-insights-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("parseRange defaults to the last 14 days and rejects inverted ranges", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const r = parseRange({}, now);
  assert.equal(r.to.toISOString(), now.toISOString());
  assert.equal(r.from.toISOString(), "2026-08-10T12:00:00.000Z");
  assert.throws(() => parseRange({ from: "2026-08-20", to: "2026-08-10" }), /rango/);
  assert.throws(() => parseRange({ from: "nope" }), /from/);
});

test("store persists analyses and proposals atomically and returns copies", () => {
  withDir((dir) => {
    const store = createProposalStore(dir);
    store.upsertAnalysis({ id: "an-1", from: "a", to: "b", status: "running", createdAt: "c", proposalIds: [], discarded: [], signals: { tasks: 0, commits: 0, evidenceFiles: 0 } });
    store.upsertProposal({ id: "prop-1", analysisId: "an-1", name: "fix-rapido", rationale: "r", evidence: ["CU-1"], config: { stages: [{ key: "planning", label: "Plan", icon: "📋" }], verifyAfter: null }, status: "proposed", createdAt: "c" });
    const again = createProposalStore(dir);
    assert.equal(again.getAnalysis("an-1")?.status, "running");
    assert.equal(again.listProposals("proposed").length, 1);
    again.getProposal("prop-1")!.name = "mutado";
    assert.equal(again.getProposal("prop-1")!.name, "fix-rapido");
  });
});

test("transition accepts once, then refuses with 409; unknown id is 404", () => {
  withDir((dir) => {
    const store = createProposalStore(dir);
    store.upsertProposal({ id: "prop-1", analysisId: "an-1", name: "fix-rapido", rationale: "r", evidence: ["CU-1"], config: { stages: [{ key: "planning", label: "Plan", icon: "📋" }], verifyAfter: null }, status: "proposed", createdAt: "c" });
    store.transition("prop-1", "accepted", "wf-9");
    assert.equal(store.getProposal("prop-1")?.catalogId, "wf-9");
    assert.throws(() => store.transition("prop-1", "dismissed"), (e: InsightsError) => e.status === 409);
    assert.throws(() => store.transition("nope", "dismissed"), (e: InsightsError) => e.status === 404);
    assert.deepEqual(store.listProposals("proposed"), []);
  });
});
