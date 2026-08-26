import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalTerminalCommand, launchManagedSession, SessionLaunchError, validateManagedSessionLaunch, type ManagedSessionLaunchDeps } from "./session-launch.js";

function launchDeps(overrides: Partial<ManagedSessionLaunchDeps> = {}): ManagedSessionLaunchDeps {
  const writes = new Map<string, unknown>();
  const workflow = {
    id: "wf-test",
    name: "test",
    updatedAt: 1,
    config: {
      stages: [
        { key: "plan", label: "Plan", icon: "P", instruction: "planifica en {cycle}" },
        { key: "implement", label: "Implementa", icon: "I", instruction: "implementa en {repo}" },
      ],
      verifyAfter: "implement",
    },
  };
  return {
    listRepos: () => ["monorepo"],
    resolveCwd: () => ({ cwd: "/repo", real: true }),
    hasSession: async () => false,
    findWorkflowCatalogItem: () => workflow,
    worktreePathForSession: (_cwd, name) => `/worktrees/${name}`,
    addWorktree: async () => {},
    removeWorktree: async () => ({ removed: true, kept: false }),
    createSession: async () => {},
    killSession: async () => {},
    cycleDirForSession: (name) => `/cycles/${name}`,
    ensureCycleDir: () => {},
    removeCycleDir: () => {},
    writeFlow: () => {},
    writeJsonAtomic: (file, value) => writes.set(file, value),
    readWrite: (file) => writes.get(file),
    ...overrides,
  };
}

test("managed session validation requires a safe cowork- name", () => {
  assert.throws(
    () => validateManagedSessionLaunch({ repo: "monorepo", workflowId: "wf-x", name: "scratch" }),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "MANAGED_SESSION_PREFIX_REQUIRED",
  );
  assert.throws(
    () => validateManagedSessionLaunch({ repo: "monorepo", workflowId: "wf-x", name: "cowork-../../etc" }),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "INVALID_SESSION",
  );
});

test("normal terminal sessions do not require a workflow", () => {
  assert.doesNotThrow(() => validateManagedSessionLaunch({
    repo: "monorepo",
    workflowId: "",
    name: "cowork-codex-shell",
    mode: "terminal",
    agent: "codex",
  }));
});

test("normal terminal sessions only accept Claude or Codex", () => {
  assert.throws(
    () => validateManagedSessionLaunch({
      repo: "monorepo",
      workflowId: "",
      name: "cowork-unknown-shell",
      mode: "terminal",
      agent: "shell",
    }),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "AGENT_INVALID",
  );
});

test("normal Claude sessions use the interactive terminal command", () => {
  assert.equal(normalTerminalCommand("claude", { claude: "claude", codex: "codex" }), "claude");
  assert.equal(normalTerminalCommand("codex", { claude: "claude", codex: "codex" }), "codex");
});

test("workflow con petición persiste launch.json y entrega el prompt completo sin esperar", async () => {
  const delivered: Array<[string, string]> = [];
  const deps = launchDeps({ deliverPrompt: async (session, prompt) => { delivered.push([session, prompt]); } });

  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-cu-86e2", request: "Necesito que trabajes CU-86e2\ncon detalle." }, deps);

  const launch = deps.readWrite?.("/cycles/cowork-cu-86e2/launch.json") as Record<string, unknown>;
  assert.deepEqual({ ...launch, createdAt: typeof launch.createdAt }, {
    version: 1, repo: "monorepo", workflowId: "wf-test", name: "cowork-cu-86e2",
    request: "Necesito que trabajes CU-86e2\ncon detalle.", mode: "workflow", workflowName: "test",
    cwd: "/repo", worktree: "/worktrees/cowork-cu-86e2", branch: "ronin/cowork-cu-86e2", createdAt: "number",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  const [session, prompt] = delivered[0];
  assert.equal(session, "cowork-cu-86e2");
  assert.match(prompt, /Necesito que trabajes CU-86e2/);
  assert.match(prompt, /Necesito que trabajes CU-86e2\ncon detalle\./);
  assert.match(prompt, /touch \/cycles\/cowork-cu-86e2\/plan/);
  assert.match(prompt, /touch \/cycles\/cowork-cu-86e2\/implement/);
  assert.match(prompt, /VERIFICADOR independiente/);
});

test("sin petición o en terminal no entrega un prompt", async () => {
  let calls = 0;
  const deps = launchDeps({ deliverPrompt: async () => { calls++; } });
  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-sin-peticion" }, deps);
  await launchManagedSession({ repo: "monorepo", name: "cowork-terminal", mode: "terminal", agent: "claude", request: "ignorada" }, deps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("un error al entregar la petición se registra sin deshacer el lanzamiento", async () => {
  const errors: unknown[] = [];
  const deps = launchDeps({
    deliverPrompt: async () => { throw new Error("tmux caído"); },
    logError: (error) => { errors.push(error); },
  });
  await assert.doesNotReject(() => launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-entrega-falla", request: "hazlo" }, deps));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
});
