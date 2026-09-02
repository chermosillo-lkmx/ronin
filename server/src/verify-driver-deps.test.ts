import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createVerifyDriverDeps, type VerifyDriverDepSources } from "./verify-driver-deps.js";

function sources(overrides: Partial<VerifyDriverDepSources> = {}): VerifyDriverDepSources {
  return {
    readTmuxInventory: async () => ({ sessions: [], diagnostic: null }),
    readLaunch: () => null,
    resolveFlow: () => ({ stages: [], verifyAfter: null }),
    cycleDirForSession: (name) => `/cycle/${name}`,
    detectStage: () => null,
    ...overrides,
  };
}

test("listSessions marca ocupado sólo cuando attention.level es working", async () => {
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({
      diagnostic: null,
      sessions: [
        { name: "cowork-working", kind: "managed", attention: { level: "working" } },
        { name: "cowork-idle", kind: "managed", attention: { level: "idle" } },
        { name: "cowork-shell", kind: "managed", attention: { level: "shell" } },
        { name: "cowork-decision", kind: "managed", attention: { level: "decision" } },
        { name: "cowork-gone", kind: "managed", attention: { level: "gone" } },
        { name: "cowork-without-attention", kind: "managed" },
      ],
    }),
  }));

  assert.deepEqual(await deps.listSessions(), [
    { name: "cowork-working", busy: true },
    { name: "cowork-idle", busy: false },
    { name: "cowork-shell", busy: false },
    { name: "cowork-decision", busy: false },
    { name: "cowork-gone", busy: false },
    { name: "cowork-without-attention", busy: false },
  ]);
});

test("listSessions descarta sesiones ajenas", async () => {
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({
      diagnostic: null,
      sessions: [
        { name: "cowork-managed", kind: "managed", attention: { level: "working" } },
        { name: "foreign-session", kind: "foreign", attention: { level: "working" } },
      ],
    }),
  }));

  assert.deepEqual(await deps.listSessions(), [{ name: "cowork-managed", busy: true }]);
});

test("listSessions no interpreta inventario diagnosticado", async () => {
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({
      diagnostic: { kind: "tmux-not-found", message: "tmux no está disponible" },
      sessions: [{ name: "cowork-managed", kind: "managed", attention: { level: "working" } }],
    }),
  }));

  assert.deepEqual(await deps.listSessions(), []);
});

test("launchOf devuelve null si falta launch.json", () => {
  const deps = createVerifyDriverDeps(sources({ readLaunch: () => null }));
  assert.equal(deps.launchOf("cowork-missing"), null);
});

test("launchOf devuelve null ante JSON inválido", () => {
  const deps = createVerifyDriverDeps(sources({
    readLaunch: () => { throw new SyntaxError("JSON inválido"); },
  }));
  assert.equal(deps.launchOf("cowork-invalid"), null);
});

test("launchOf devuelve null con mode o repo de tipo incorrecto", () => {
  const deps = createVerifyDriverDeps(sources({ readLaunch: () => ({ mode: 42, repo: false, worktree: "/wt" }) }));
  assert.equal(deps.launchOf("cowork-wrong-types"), null);
  const invalidMode = createVerifyDriverDeps(sources({ readLaunch: () => ({ mode: "script", repo: "monorepo" }) }));
  assert.equal(invalidMode.launchOf("cowork-wrong-mode"), null);
});

test("launchOf lee los campos del launch.json real de un workflow", () => {
  const deps = createVerifyDriverDeps(sources({
    readLaunch: () => ({
      version: 1,
      name: "cowork-workflow",
      mode: "workflow",
      repo: "monorepo",
      workflowId: "bugfix",
      workflowName: "Bugfix",
      cwd: "/repos/monorepo",
      worktree: "/repos/monorepo/.worktrees/cowork-workflow",
      branch: "cowork/cowork-workflow",
      createdAt: 1_700_000_000_000,
    }),
  }));

  assert.deepEqual(deps.launchOf("cowork-workflow"), {
    mode: "workflow",
    repo: "monorepo",
    worktree: "/repos/monorepo/.worktrees/cowork-workflow",
  });
});
