import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    store.upsertProposal({ id: "prop-1", analysisId: "an-1", name: "fix-rapido", rationale: "r", evidence: ["CU-1"], config: { stages: [{ key: "planning", label: "Plan", icon: "📋" }], verifyAfter: [] }, status: "proposed", createdAt: "c" });
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
    store.upsertProposal({ id: "prop-1", analysisId: "an-1", name: "fix-rapido", rationale: "r", evidence: ["CU-1"], config: { stages: [{ key: "planning", label: "Plan", icon: "📋" }], verifyAfter: [] }, status: "proposed", createdAt: "c" });
    store.transition("prop-1", "accepted", "wf-9");
    assert.equal(store.getProposal("prop-1")?.catalogId, "wf-9");
    assert.throws(() => store.transition("prop-1", "dismissed"), (e: InsightsError) => e.status === 409);
    assert.throws(() => store.transition("nope", "dismissed"), (e: InsightsError) => e.status === 404);
    assert.deepEqual(store.listProposals("proposed"), []);
  });
});

test("store: un journal legado con verifyAfter string o null en las propuestas se sirve como lista", () => {
  withDir((dir) => {
    const proposal = (id: string, verifyAfter: unknown) => ({
      id, name: id, status: "proposed", createdAt: "c", analysisId: "an-1", rationale: "r", sources: [],
      config: { stages: [{ key: "curl", label: "Curl", icon: "🌐", instruction: "" }], verifyAfter },
    });
    writeFileSync(join(dir, "workflow-proposals.json"), JSON.stringify({ analyses: [], proposals: [proposal("p-str", "curl"), proposal("p-null", null), proposal("p-arr", ["curl"])] }));
    const store = createProposalStore(dir);
    const byId = Object.fromEntries(store.listProposals().map((p) => [p.id, p.config.verifyAfter]));
    assert.deepEqual(byId, { "p-str": ["curl"], "p-null": [], "p-arr": ["curl"] });
    assert.deepEqual(store.getProposal("p-str")?.config.verifyAfter, ["curl"]);
  });
});
