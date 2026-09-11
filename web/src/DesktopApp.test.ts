import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("DesktopApp monta WorkflowWorkspace en la vista workflows y no WorkflowEditorScreen (pin por fuente)", () => {
  const source = readFileSync(new URL("./DesktopApp.tsx", import.meta.url), "utf8");

  assert.match(
    source,
    /import\s*\{[^}]*\bWorkflowWorkspace\b[^}]*\}\s*from\s*["']\.\/components\/workflows\/WorkflowWorkspace["']/s,
  );
  assert.match(source, /view\s*===\s*["']workflows["']\s*&&\s*<WorkflowWorkspace\b/);
  assert.doesNotMatch(source, /\bWorkflowEditorScreen\b/);
  assert.doesNotMatch(source, /\bHarnessView\b/);
});
