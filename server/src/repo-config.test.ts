import { strict as assert } from "node:assert";
import { test } from "node:test";

// These tests exercise getters + save round-trip against the real (gitignored)
// data/repo-config.json, using a throwaway repo key so real overrides are never touched.
// test.after() removes the scratch key so the file is left clean.

const { getRepoPlannerModel, getRepoWorkerModel, saveRepoOverrides, readRepoConfigFull, sanitizeEntry } =
  await import("./repo-config.js");
const { PLANNER_MODEL, WORKER_MODEL } = await import("./config.js");

test("T11.90 sanitizeEntry: un override con workflow inválido cae al default (no lo setea) sin lanzar", () => {
  const entry = sanitizeEntry({
    workflow: {
      stages: [{ key: "", label: "", icon: "" }], // sin key válida → cero etapas sobreviven
      verifyAfter: null,
    },
  });
  assert.equal(entry.workflow, undefined); // sin override → getRepoWorkflow hereda el default global
});

test("T11.90 sanitizeEntry: un workflow válido (incl. verifyCmd, gitignored) sí se conserva", () => {
  const entry = sanitizeEntry({
    workflow: {
      stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test" }],
      verifyAfter: null,
    },
  });
  assert.equal(entry.workflow?.stages[0].key, "curl");
  assert.equal(entry.workflow?.stages[0].verifyCmd, "npm test"); // per-repo override honra verifyCmd
});

const KEY = "zz-test-repo-config-models";

test.after(() => {
  // remove our scratch override so we leave repo-config.json clean
  try {
    saveRepoOverrides(KEY, { inheritWorkflow: true, vars: {}, startCommand: "", skills: [] });
  } catch {}
});

test("getRepo{Planner,Worker}Model: fall back to global defaults when unset", () => {
  assert.equal(getRepoPlannerModel(KEY), PLANNER_MODEL);
  assert.equal(getRepoWorkerModel(KEY), WORKER_MODEL);
});

test("saveRepoOverrides: persists planner/worker model overrides", () => {
  const full = saveRepoOverrides(KEY, {
    inheritWorkflow: true,
    plannerModel: "claude-opus-4-8",
    workerModel: "sonnet",
  });
  assert.equal(full.plannerModel, "claude-opus-4-8");
  assert.equal(full.workerModel, "sonnet");
  assert.equal(getRepoPlannerModel(KEY), "claude-opus-4-8");
  assert.equal(getRepoWorkerModel(KEY), "sonnet");
});

test("saveRepoOverrides: a repo overriding ONLY the model is not dropped (drop-empty predicate)", () => {
  saveRepoOverrides(KEY, { inheritWorkflow: true, workerModel: "haiku" });
  const full = readRepoConfigFull(KEY);
  assert.equal(full.workerModel, "haiku"); // survived the write despite no workflow/vars/startCommand
});

test("saveRepoOverrides: charset rejects injection in model fields (blank stored)", () => {
  const full = saveRepoOverrides(KEY, {
    inheritWorkflow: true,
    plannerModel: "opus; rm -rf ~",
    workerModel: "sonnet\n/model",
  });
  assert.equal(full.plannerModel, ""); // sanitized away → inherit
  assert.equal(full.workerModel, "");
  assert.equal(getRepoPlannerModel(KEY), PLANNER_MODEL); // falls back
});

test("readRepoConfigFull: raw empty string means inherit", () => {
  saveRepoOverrides(KEY, { inheritWorkflow: true, vars: {}, startCommand: "" });
  const full = readRepoConfigFull(KEY);
  assert.equal(full.plannerModel, "");
  assert.equal(full.workerModel, "");
});

test("saveRepoOverrides: persists unique qualified SkillRef values without changing the workflow", () => {
  const full = saveRepoOverrides(KEY, {
    inheritWorkflow: true,
    skills: [
      { root: "global", name: "api-review" },
      { root: "global", name: "api-review" },
    ],
  });
  assert.deepEqual(full.skills, [{ root: "global", name: "api-review" }]);
  assert.equal(full.workflow, null);
});
