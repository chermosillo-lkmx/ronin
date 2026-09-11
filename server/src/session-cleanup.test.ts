import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupSession, matchesSession, type CleanupDeps } from "./session-cleanup.js";

function managedLaunch() {
  return { mode: "workflow", cwd: "/repo", worktree: "/worktree", branch: "ronin/cowork-clean" };
}

function cleanupFixture(options: {
  launch?: unknown | null;
  cycleExists?: boolean;
  worktreeResult?: { removed: boolean; kept: boolean };
  containerIds?: string[];
  listError?: NodeJS.ErrnoException;
  failingContainers?: string[];
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "ronin-cleanup-test-"));
  const cycle = join(root, "cycle");
  if (options.cycleExists !== false) mkdirSync(cycle);
  const calls: string[] = [];
  const failing = new Set(options.failingContainers ?? []);
  const deps: CleanupDeps = {
    readLaunch: () => options.launch === undefined ? managedLaunch() : options.launch,
    cycleFor: () => cycle,
    removeWorktree: async () => {
      calls.push("worktree");
      return options.worktreeResult ?? { removed: true, kept: false };
    },
    removeCycleDir: (path) => {
      calls.push("cycle");
      rmSync(path, { recursive: true, force: true });
    },
    listContainers: async () => {
      calls.push("containers:list");
      if (options.listError) throw options.listError;
      return options.containerIds ?? ["container-a", "container-b"];
    },
    removeContainer: async (id) => {
      calls.push(`container:remove:${id}`);
      if (failing.has(id)) throw new Error(`cannot remove ${id}`);
    },
  };
  return { cycle, calls, deps, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("cleanupSession: una gestionada limpia contenedores, worktree y cycle dir en orden", async () => {
  const fixture = cleanupFixture();
  try {
    const report = await cleanupSession("cowork-clean", fixture.deps);
    assert.deepEqual(fixture.calls, ["containers:list", "container:remove:container-a", "container:remove:container-b", "worktree", "cycle"]);
    assert.deepEqual(report, {
      kind: "managed",
      worktree: { status: "removed", path: "/worktree", branch: "ronin/cowork-clean" },
      cycleDir: { status: "removed", path: fixture.cycle },
      containers: { removed: ["container-a", "container-b"], failed: [] },
    });
  } finally {
    fixture.dispose();
  }
});

test("cleanupSession: conserva el cycle dir cuando el worktree tiene trabajo sin integrar", async () => {
  const fixture = cleanupFixture({ worktreeResult: { removed: false, kept: true } });
  try {
    const report = await cleanupSession("cowork-clean", fixture.deps);
    assert.equal(report.worktree.status, "kept");
    assert.equal(report.worktree.reason, "tiene trabajo sin integrar");
    assert.deepEqual(report.cycleDir, { status: "kept", path: fixture.cycle });
    assert.equal(fixture.calls.includes("cycle"), false);
  } finally {
    fixture.dispose();
  }
});

test("cleanupSession: una sesión ajena no toca worktree ni contenedores y sí borra su cycle dir", async () => {
  const fixture = cleanupFixture({ launch: null });
  try {
    const report = await cleanupSession("foreign", fixture.deps);
    assert.equal(report.kind, "foreign");
    assert.deepEqual(report.worktree, { status: "none" });
    assert.deepEqual(report.cycleDir, { status: "removed", path: fixture.cycle });
    assert.deepEqual(report.containers, { removed: [], failed: [] });
    assert.deepEqual(fixture.calls, ["cycle"]);
  } finally {
    fixture.dispose();
  }
});

test("cleanupSession: sin launch.json ni cycle dir reporta todo como none", async () => {
  const fixture = cleanupFixture({ launch: null, cycleExists: false });
  try {
    const report = await cleanupSession("foreign", fixture.deps);
    assert.deepEqual(report, {
      kind: "foreign",
      worktree: { status: "none" },
      cycleDir: { status: "none" },
      containers: { removed: [], failed: [] },
    });
    assert.deepEqual(fixture.calls, []);
  } finally {
    fixture.dispose();
  }
});

test("cleanupSession: docker ausente se marca skipped y no detiene el resto", async () => {
  const error = Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
  const fixture = cleanupFixture({ listError: error });
  try {
    const report = await cleanupSession("cowork-clean", fixture.deps);
    assert.deepEqual(report.containers, { removed: [], failed: [], skipped: "docker no disponible" });
    assert.deepEqual(fixture.calls, ["containers:list", "worktree", "cycle"]);
    assert.equal(report.worktree.status, "removed");
    assert.equal(report.cycleDir.status, "removed");
  } finally {
    fixture.dispose();
  }
});

test("cleanupSession: un rm de contenedor fallido no impide retirar los demás", async () => {
  const fixture = cleanupFixture({ containerIds: ["ok-a", "bad", "ok-b"], failingContainers: ["bad"] });
  try {
    const report = await cleanupSession("cowork-clean", fixture.deps);
    assert.deepEqual(report.containers, { removed: ["ok-a", "ok-b"], failed: ["bad"] });
    assert.equal(report.worktree.status, "removed");
    assert.equal(report.cycleDir.status, "removed");
  } finally {
    fixture.dispose();
  }
});

test("matchesSession sólo acepta el nombre exacto o un prefijo separado", () => {
  assert.equal(matchesSession("cfdis", "cfdis-webhook-db"), true);
  assert.equal(matchesSession("cfdis", "cfdis-pg-cycle"), true);
  assert.equal(matchesSession("cfdis", "cfdis_worker"), true);
  assert.equal(matchesSession("cfdis", "cfdis"), true);
  assert.equal(matchesSession("cfdis", "my-cfdis"), false);
  assert.equal(matchesSession("cfdis", "cfdiswebhook"), false);
});
