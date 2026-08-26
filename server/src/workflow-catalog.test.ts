import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowCatalogItem, loadWorkflowCatalog, updateWorkflowCatalogItem } from "./workflow-catalog.js";

const valid = { stages: [{ key: "plan", label: "Plan", icon: "•" }], verifyAfter: null };

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
    assert.throws(() => createWorkflowCatalogItem("broken", { stages: [], verifyAfter: null }, dir), /necesita al menos una etapa/);
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
