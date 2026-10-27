import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowCatalogItem, deleteWorkflowCatalogItem, loadWorkflowCatalog, updateWorkflowCatalogItem } from "./workflow-catalog.js";

const valid = { stages: [{ key: "plan", label: "Plan", icon: "•" }], verifyAfter: [] };

test("workflow catalog migrates the legacy workflow and persists immutable ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    const catalog = loadWorkflowCatalog(dir);
    assert.equal(catalog.items[0]?.name, "refactor-v3");
    assert.match(catalog.items[0]?.id ?? "", /^wf-[a-z0-9]+$/);
    assert.match(readFileSync(join(dir, "workflows.json"), "utf8"), /refactor-v3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow catalog rejects invalid configs and duplicate names", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    assert.throws(() => createWorkflowCatalogItem("broken", { stages: [], verifyAfter: [] }, dir), /necesita al menos una etapa/);
    createWorkflowCatalogItem("release", valid, dir);
    assert.throws(() => createWorkflowCatalogItem("release", valid, dir), /WORKFLOW_NAME_EXISTS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow catalog rename preserves its identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    const created = createWorkflowCatalogItem("release", valid, dir);
    const updated = updateWorkflowCatalogItem(created.id, { name: "release-v2" }, dir);
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "release-v2");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow catalog conserva inputs declarados al volver a leer", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    const created = createWorkflowCatalogItem("review-pr", {
      ...valid,
      inputs: [{ key: "ticket", label: "Ticket", required: true }],
    }, dir);
    assert.deepEqual(loadWorkflowCatalog(dir).items.find((item) => item.id === created.id)?.config.inputs, [
      { key: "ticket", label: "Ticket", required: true },
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A2: el catálogo normaliza verifyAfter legado al cargar de disco", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    writeFileSync(join(dir, "workflows.json"), JSON.stringify({
      version: 1,
      items: [{
        id: "wf-legacy",
        name: "legacy",
        updatedAt: 1,
        config: {
          stages: [{ key: "curl", label: "Curl", icon: "🌐" }],
          verifyAfter: "curl",
        },
      }],
    }));
    assert.deepEqual(loadWorkflowCatalog(dir).items[0]?.config.verifyAfter, ["curl"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("A3: el catálogo conserva verifyCmd y maxRetries al guardar y recargar", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    const created = createWorkflowCatalogItem("gated", {
      stages: [
        { key: "tests", label: "Tests", icon: "✅", verifyCmd: "npm test", maxRetries: 2 },
        { key: "deploy", label: "Deploy", icon: "🚀", verifyCmd: "true", maxRetries: 7 },
      ],
      verifyAfter: [],
    }, dir);
    assert.deepEqual(created.config.stages.map((stage) => [stage.verifyCmd, stage.maxRetries]), [
      ["npm test", 2],
      ["true", 7],
    ]);
    assert.deepEqual(loadWorkflowCatalog(dir).items.find((item) => item.id === created.id)?.config.stages.map((stage) => [stage.verifyCmd, stage.maxRetries]), [
      ["npm test", 2],
      ["true", 7],
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow catalog deletes a named item while preserving the other workflows", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    const initial = loadWorkflowCatalog(dir).items[0]!;
    const extra = createWorkflowCatalogItem("release", valid, dir);
    deleteWorkflowCatalogItem(extra.id, dir);
    assert.deepEqual(loadWorkflowCatalog(dir).items.map((item) => item.id), [initial.id]);
    assert.throws(() => deleteWorkflowCatalogItem(extra.id, dir), /WORKFLOW_NOT_FOUND/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow catalog refuses to delete its last item", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-workflows-"));
  try {
    const only = loadWorkflowCatalog(dir).items[0]!;
    assert.throws(() => deleteWorkflowCatalogItem(only.id, dir), /WORKFLOW_LAST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("el catálogo empaquetado no contiene frases de re-corrida y tiene pre-merge antes de pr/merge", () => {
  const raw = readFileSync(new URL("../data/workflows.json", import.meta.url), "utf8");
  for (const frase of ["córrelo tú también", "vuelve a correr el gate", "con su unit-gate"]) {
    assert.ok(!raw.includes(frase), `el catálogo empaquetado aún dice: ${frase}`);
  }
  const catalog = JSON.parse(raw) as { items: Array<{ name: string; config: { stages: Array<{ key: string; verifyCmd?: string; mergeGate?: boolean; instruction: string }> } }> };
  for (const name of ["tmux-worker-loop", "claude-plan-codex-impl", "hotfix-verificado", "pr-review-merge-dev"]) {
    const stages = catalog.items.find((w) => w.name === name)!.config.stages;
    const keys = stages.map((s) => s.key);
    const i = keys.indexOf("pre-merge");
    assert.ok(i >= 0, `${name} sin pre-merge`);
    assert.ok(["pr", "merge"].includes(keys[i + 1]!), `${name}: tras pre-merge viene ${keys[i + 1]}`);
    assert.match(stages[i]!.instruction, /No corras la suite ni `unit-gate\.sh`/);
  }
  for (const w of catalog.items) for (const s of w.config.stages) {
    assert.equal(s.verifyCmd, undefined, `${w.name}/${s.key}: el catálogo empaquetado no lleva verifyCmd`);
    assert.equal(s.mergeGate, undefined, `${w.name}/${s.key}: ni mergeGate`);
  }
});
