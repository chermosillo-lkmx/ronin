import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionPresentationStore } from "./session-presentation.js";

test("session presentation: persiste título visible y repo sin cambiar el nombre técnico de tmux", () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-session-presentation-"));
  const file = join(dir, "sessions.json");
  try {
    const store = createSessionPresentationStore(file, () => ["monorepo", "ant-liebre-api"]);
    assert.deepEqual(store.save("174", { title: "Revisión de factura", repo: "ant-liebre-api" }), {
      title: "Revisión de factura",
      repo: "ant-liebre-api",
    });

    const reloaded = createSessionPresentationStore(file, () => ["monorepo", "ant-liebre-api"]);
    assert.deepEqual(reloaded.get("174"), { title: "Revisión de factura", repo: "ant-liebre-api" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session presentation: rechaza un repo que no está configurado y títulos excesivos", () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-session-presentation-"));
  try {
    const store = createSessionPresentationStore(join(dir, "sessions.json"), () => ["monorepo"]);
    assert.throws(() => store.save("174", { title: "Trabajo", repo: "desconocido" }), /REPO_UNKNOWN/);
    assert.throws(() => store.save("174", { title: "x".repeat(121), repo: "monorepo" }), /TITLE_INVALID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
