import { strict as assert } from "node:assert";
import { test } from "node:test";

// These tests exercise getters + save round-trip against the real (gitignored)
// data/repo-config.json, using a throwaway repo key so real overrides are never touched.
// test.after() removes the scratch key so the file is left clean.

const { getRepoPlannerModel, getRepoSetupCommand, getRepoWorkerModel, saveRepoOverrides, readRepoConfigFull, sanitizeEntry } =
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

// ---- setupCommand: cómo se arma el entorno de dependencias de un worktree recién creado.
// Vive en el override por-repo (gitignorado) por el mismo motivo que startCommand y verifyCmd: es shell.
const SETUP_KEY = "ronin-scratch-setup";

test.after(() => {
  try {
    saveRepoOverrides(SETUP_KEY, { inheritWorkflow: true, vars: {}, startCommand: "", setupCommand: "", skills: [] });
  } catch {}
});

test("setupCommand se guarda recortado, se lee crudo y ausente hereda vacío", () => {
  const full = saveRepoOverrides(SETUP_KEY, { setupCommand: "  python3 -m venv .venv  " });
  assert.equal(full.setupCommand, "python3 -m venv .venv");
  assert.equal(readRepoConfigFull(SETUP_KEY).setupCommand, "python3 -m venv .venv");
  assert.equal(getRepoSetupCommand(SETUP_KEY), "python3 -m venv .venv");
});

test("un override que SÓLO trae setupCommand no se descarta al guardar", () => {
  saveRepoOverrides(SETUP_KEY, { inheritWorkflow: true, vars: {}, startCommand: "", setupCommand: "npm ci", skills: [] });
  assert.equal(getRepoSetupCommand(SETUP_KEY), "npm ci");
});

test("un setupCommand en blanco no se persiste y el repo queda sin provisión", () => {
  saveRepoOverrides(SETUP_KEY, { inheritWorkflow: true, vars: {}, startCommand: "", setupCommand: "   ", skills: [] });
  assert.equal(getRepoSetupCommand(SETUP_KEY), null);
  assert.equal(readRepoConfigFull(SETUP_KEY).setupCommand, "");
});
