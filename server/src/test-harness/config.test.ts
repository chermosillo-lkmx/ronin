import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessStore } from "./config.js";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ronin-harness-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONFIG = {
  profiles: [{ name: "dev", variables: { TOKEN: "actual-secret" } }],
  suites: { unit: { command: { program: "pytest", args: ["-q"] }, junitPath: "junit.xml" } },
};

test("repository added to repos.json has an unconfigured virtual harness row", () => {
  withDir((dir) => {
    const store = createHarnessStore({ directory: dir, repos: () => ["api-new"] });
    assert.equal(store.readRepo("api-new").configured, false);
    assert.deepEqual(store.readRepo("api-new").config, { profiles: [], suites: {} });
    assert.deepEqual(store.readPublicConfig().map((r) => [r.repo, r.configured]), [["api-new", false]]);
  });
});

test("public config retains variable keys but never values", () => {
  withDir((dir) => {
    const store = createHarnessStore({ directory: dir, repos: () => ["api"] });
    store.saveRepo("api", CONFIG);
    assert.deepEqual(store.publicRepo("api").profiles[0].variables, ["TOKEN"]);
    assert.equal(JSON.stringify(store.publicRepo("api")).includes("actual-secret"), false);
    assert.equal(JSON.stringify(store.readPublicConfig()).includes("actual-secret"), false);
    assert.equal(store.readRepo("api").config.profiles[0].variables.TOKEN, "actual-secret");
  });
});

test("saved config survives a new store instance and a configured repo missing from repos.json is still listed", () => {
  withDir((dir) => {
    createHarnessStore({ directory: dir, repos: () => ["api"] }).saveRepo("api", CONFIG);
    const again = createHarnessStore({ directory: dir, repos: () => ["other"] });
    assert.equal(again.readRepo("api").configured, true);
    assert.deepEqual(again.readPublicConfig().map((r) => r.repo).sort(), ["api", "other"]);
    assert.ok(existsSync(join(dir, "test-harness.json")));
  });
});

test("saveRepo rejects an invalid config without touching the persisted file", () => {
  withDir((dir) => {
    const store = createHarnessStore({ directory: dir, repos: () => ["api"] });
    store.saveRepo("api", CONFIG);
    const before = readFileSync(join(dir, "test-harness.json"), "utf8");
    assert.throws(() => store.saveRepo("api", { suites: { unit: { command: "pytest -q" } } }), /command/);
    assert.equal(readFileSync(join(dir, "test-harness.json"), "utf8"), before);
  });
});

test("a malformed local file is tolerated as an empty store", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "test-harness.json"), "{not json");
    writeFileSync(join(dir, "test-runs.json"), "[]");
    const store = createHarnessStore({ directory: dir, repos: () => [] });
    assert.deepEqual(store.readPublicConfig(), []);
    assert.deepEqual(store.listRuns(), []);
  });
});

test("run journal persists runs and batches, and artifactsDir is created lazily", () => {
  withDir((dir) => {
    const store = createHarnessStore({ directory: dir, repos: () => ["api"] });
    store.upsertRun({ runId: "r1", repo: "api", suite: "unit", profile: "dev", status: "queued", createdAt: "2026-08-24T00:00:00.000Z" });
    store.upsertRun({ runId: "r1", repo: "api", suite: "unit", profile: "dev", status: "running", createdAt: "2026-08-24T00:00:00.000Z" });
    store.upsertBatch({ batchId: "b1", kind: "all", profile: "dev", createdAt: "2026-08-24T00:00:00.000Z", runIds: ["r1"] });
    const again = createHarnessStore({ directory: dir, repos: () => ["api"] });
    assert.equal(again.getRun("r1")?.status, "running");
    assert.equal(again.listRuns().length, 1);
    assert.deepEqual(again.getBatch("b1")?.runIds, ["r1"]);
    assert.equal(existsSync(join(dir, "test-artifacts", "r1")), false);
    const art = again.artifactsDir("r1");
    assert.equal(art, join(dir, "test-artifacts", "r1"));
    assert.ok(existsSync(art));
    // returned runs are copies: mutating them does not alter the journal
    again.getRun("r1")!.status = "passed";
    assert.equal(again.getRun("r1")?.status, "running");
  });
});
