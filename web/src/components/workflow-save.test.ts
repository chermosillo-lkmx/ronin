import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowDraft, editControlValue, setJsonText, setStages, switchView, toggleHarnessControl, toggleHarnessSection } from "./workflow-draft.js";
import * as workflowSave from "./workflow-save.js";
import { confirmWorkflowSave, repoPayload, workflowPayload } from "./workflow-save.js";
import type { RepoOverrideConfig, WorkflowConfig } from "../types.js";

test("B4b workflowPayload incluye inputs", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "plan", label: "Plan", icon: "📋" }],
    verifyAfter: [],
    inputs: [{ key: "ticket", label: "Ticket", required: true }],
  });

  assert.deepEqual(workflowPayload(draft), {
    stages: draft.stages,
    verifyAfter: [],
    inputs: [{ key: "ticket", label: "Ticket", required: true }],
  });
});

test("B4c repoPayload conserva inputs, setupCommand y kbPath", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "plan", label: "Plan", icon: "📋" }],
    verifyAfter: [],
    inputs: [{ key: "ticket", label: "Ticket" }],
  });
  const entry: RepoOverrideConfig = {
    workflow: null,
    vars: { SAFE: "value" },
    startCommand: "codex",
    setupCommand: "npm install",
    kbPath: "docs/kb",
    plannerModel: "planner",
    workerModel: "worker",
    usesDefaultWorkflow: false,
    skills: [],
  };

  const payload = repoPayload(draft, entry, false);

  assert.deepEqual(payload.workflow?.inputs, [{ key: "ticket", label: "Ticket" }]);
  assert.equal(payload.setupCommand, "npm install");
  assert.equal(payload.kbPath, "docs/kb");
});

test("SEC-1 Stepper, JSON y Harness atraviesan la misma confirmación al guardar verifyCmd", async (t) => {
  const base = createWorkflowDraft({
    stages: [{ key: "tests", label: "Pruebas", icon: "🧪" }],
    verifyAfter: [],
  });
  const drafts = {
    Stepper: setStages(base, [{ ...base.stages[0], verifyCmd: "npm test" }], []),
    JSON: setJsonText(
      switchView(base, "json"),
      JSON.stringify({ stages: [{ ...base.stages[0], verifyCmd: "npm test" }], verifyAfter: [] }),
    ),
    Harness: editControlValue(switchView(base, "harness"), "tests", {
      id: "verifyCmd",
      verifyCmd: "npm test",
      maxRetries: 2,
    }),
  };
  const confirmWorkflowSave = (workflowSave as {
    confirmWorkflowSave?: <T>(
      draft: typeof base,
      repo: string | null,
      deps: { getSessions: () => Promise<[]>; confirm: () => Promise<boolean> },
      save: () => Promise<T>,
    ) => Promise<T | null>;
  }).confirmWorkflowSave;

  for (const [view, draft] of Object.entries(drafts)) {
    await t.test(view, async () => {
      let confirmations = 0;
      let saves = 0;
      assert.equal(typeof confirmWorkflowSave, "function");
      const result = await confirmWorkflowSave?.(draft, "repo", {
        getSessions: async () => [],
        confirm: async () => { confirmations++; return false; },
      }, async () => { saves++; return "saved"; });

      assert.equal(result, null);
      assert.equal(confirmations, 1);
      assert.equal(saves, 0);
    });
  }
});

test("B1-1 dos ediciones rápidas confirman una vez al guardar el comando completo más reciente", async () => {
  const base = createWorkflowDraft({
    stages: [{ key: "tests", label: "Pruebas", icon: "🧪" }],
    verifyAfter: [],
  });
  const firstKey = editControlValue(base, "tests", { id: "verifyCmd", verifyCmd: "n" });
  const latest = editControlValue(firstKey, "tests", { id: "verifyCmd", verifyCmd: "npm test" });
  let resolveSessions!: (sessions: []) => void;
  const sessions = new Promise<[]>((resolve) => { resolveSessions = resolve; });
  let confirmations = 0;
  let warningTargets: Array<{ stageKey: string; cmd: string }> = [];
  let saves = 0;

  const pending = confirmWorkflowSave(latest, "repo", {
    getSessions: () => sessions,
    confirm: async (warning) => {
      confirmations++;
      warningTargets = warning.targets;
      return true;
    },
  }, async () => { saves++; return "saved"; });
  resolveSessions([]);
  const result = await pending;

  assert.equal(result, "saved");
  assert.equal(confirmations, 1);
  assert.deepEqual(warningTargets, [{ stageKey: "tests", cmd: "npm test" }]);
  assert.equal(saves, 1);
});

test("FP1-1 el payload global elimina verifyCmd y maxRetries aunque entren por JSON", () => {
  const draft = setJsonText(createWorkflowDraft({
    stages: [{ key: "tests", label: "Pruebas", icon: "🧪" }],
    verifyAfter: [],
  }), JSON.stringify({
    stages: [{ key: "tests", label: "Pruebas", icon: "🧪", verifyCmd: "npm test", maxRetries: 0 }],
    verifyAfter: [],
  }));
  const globalWorkflowPayload = (workflowSave as {
    globalWorkflowPayload?: (value: typeof draft) => WorkflowConfig;
  }).globalWorkflowPayload;

  assert.equal(typeof globalWorkflowPayload, "function");
  assert.deepEqual(globalWorkflowPayload?.(draft), {
    stages: [{ key: "tests", label: "Pruebas", icon: "🧪" }],
    verifyAfter: [],
  });
});

test("SEC-1 restaurar verifyCmd individual o masivamente sigue bloqueado por Guardar", async (t) => {
  const base = createWorkflowDraft({
    stages: [
      { key: "a", label: "A", icon: "A" },
      { key: "b", label: "B", icon: "B" },
    ],
    verifyAfter: [],
  });
  const stashed = {
    ...base,
    stash: {
      a: { verifyCmd: "npm test", maxRetries: 2 },
      b: { verifyCmd: "npm run lint", maxRetries: 0 },
    },
  };
  const drafts = {
    individual: toggleHarnessControl(stashed, "a", "verifyCmd", true, true),
    banda: toggleHarnessSection(stashed, "gates", true, true),
  };

  for (const [path, draft] of Object.entries(drafts)) {
    await t.test(path, async () => {
      let confirmations = 0;
      let saves = 0;
      const result = await confirmWorkflowSave(draft, "repo", {
        getSessions: async () => [],
        confirm: async () => { confirmations++; return false; },
      }, async () => { saves++; return "saved"; });

      assert.equal(result, null);
      assert.equal(confirmations, 1);
      assert.equal(saves, 0);
    });
  }
});

test("B1 v2: catálogo sin repo confirma verifyCmd nuevo y cancelar impide guardar", async () => {
  const base = createWorkflowDraft({
    stages: [{ key: "tests", label: "Pruebas", icon: "T" }],
    verifyAfter: [],
  } as any);
  const draft = setStages(base, [{ ...base.stages[0], verifyCmd: "npm test" }], [] as any);
  let warning: any;
  let saves = 0;

  const result = await confirmWorkflowSave(draft, null, {
    getSessions: async () => { throw new Error("repo null no debe consultar sesiones"); },
    confirm: async (value) => { warning = value; return false; },
  }, async () => { saves++; return "saved"; });

  assert.equal(result, null);
  assert.equal(saves, 0);
  assert.deepEqual(warning.targets, [{ stageKey: "tests", cmd: "npm test" }]);
  assert.deepEqual(warning.reached, []);
});

test("B1 v2: sin cambios de verifyCmd guarda directo aunque repo sea null", async () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "tests", label: "Pruebas", icon: "T", verifyCmd: "npm test" }],
    verifyAfter: [],
  } as any);
  let confirms = 0;

  const result = await confirmWorkflowSave(draft, null, {
    getSessions: async () => [],
    confirm: async () => { confirms++; return false; },
  }, async () => "saved");

  assert.equal(result, "saved");
  assert.equal(confirms, 0);
});
