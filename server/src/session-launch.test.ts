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
        { key: "implement", label: "Implementa", icon: "I", instruction: "implementa {ticket} en {repo}" },
      ],
      verifyAfter: ["implement"],
      inputs: [{ key: "ticket", label: "Ticket" }],
    },
  };
  return {
    listRepos: () => ["monorepo"],
    resolveCwd: () => ({ cwd: "/repo", real: true }),
    hasSession: async () => false,
    findWorkflowCatalogItem: () => workflow,
    worktreePathForSession: (_cwd, name) => `/worktrees/${name}`,
    resolveBaseRef: async () => "main",
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

test("una sesión de workflow recibe el comando MCP inyectado", async () => {
  const commands: string[] = [];
  const deps = launchDeps({
    createSession: async (_name, _cwd, command) => { commands.push(command); },
    startCommandFor: (command) => `${command} --mcp-config \"/tmp/Application Support/agent-mcp.json\"`,
  });

  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-mcp-workflow" }, deps);

  assert.deepEqual(commands, ["claude --permission-mode bypassPermissions --mcp-config \"/tmp/Application Support/agent-mcp.json\""]);
});

test("sin ruta MCP el workflow conserva el comando de siempre", async () => {
  const commands: string[] = [];
  const deps = launchDeps({ createSession: async (_name, _cwd, command) => { commands.push(command); } });

  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-sin-mcp" }, deps);

  assert.deepEqual(commands, ["claude --permission-mode bypassPermissions"]);
});

test("workflow crea el worktree desde la rama base resuelta", async () => {
  const addCalls: unknown[][] = [];
  const deps = launchDeps({
    resolveBaseRef: async () => "develop",
    addWorktree: async (...args) => { addCalls.push(args); },
  });

  const launched = await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-develop" }, deps);

  assert.deepEqual(addCalls, [["/repo", "/worktrees/cowork-develop", "ronin/cowork-develop", "develop"]]);
  assert.equal(launched.baseRef, "develop");
});

test("A2: flow.json recibe verifyAfter como array", async () => {
  let frozen: unknown;
  const deps = launchDeps({ writeFlow: (_cycle, flow) => { frozen = flow; } });

  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-flow-array" }, deps);

  assert.deepEqual((frozen as { verifyAfter: unknown }).verifyAfter, ["implement"]);
});

test("workflow sin rama base resoluble lanza BASE_BRANCH_UNRESOLVED antes de crear recursos", async () => {
  let addWorktreeCalls = 0;
  const deps = launchDeps({
    resolveBaseRef: async () => null,
    addWorktree: async () => { addWorktreeCalls++; },
  });

  await assert.rejects(
    () => launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-sin-base" }, deps),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "BASE_BRANCH_UNRESOLVED",
  );
  assert.equal(addWorktreeCalls, 0);
});

test("workflow con petición persiste launch.json y entrega el prompt completo sin esperar", async () => {
  const delivered: Array<[string, string]> = [];
  const deps = launchDeps({ deliverPrompt: async (session, prompt) => { delivered.push([session, prompt]); } });

  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-cu-86e2", request: "Necesito que trabajes CU-86e2\ncon detalle." }, deps);

  const launch = deps.readWrite?.("/cycles/cowork-cu-86e2/launch.json") as Record<string, unknown>;
  assert.deepEqual({ ...launch, createdAt: typeof launch.createdAt }, {
    version: 1, repo: "monorepo", workflowId: "wf-test", name: "cowork-cu-86e2",
    request: "Necesito que trabajes CU-86e2\ncon detalle.", inputs: {}, mode: "workflow", workflowName: "test",
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

test("el lanzamiento sanea inputs declarados, los persiste y los inserta en el prompt", async () => {
  const delivered: Array<[string, string]> = [];
  const deps = launchDeps({ deliverPrompt: async (session, prompt) => { delivered.push([session, prompt]); } });

  await launchManagedSession({
    repo: "monorepo", workflowId: "wf-test", name: "cowork-inputs",
    inputs: { ticket: "  CU-42  ", noDeclarada: "no debe llegar" },
  }, deps);

  const launch = deps.readWrite?.("/cycles/cowork-inputs/launch.json") as Record<string, unknown>;
  assert.deepEqual(launch.inputs, { ticket: "CU-42" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0][1], /CU-42/);
  assert.equal(delivered[0][1].includes("no debe llegar"), false);
});

test("sin petición y sin entradas declaradas, o en terminal, no entrega un prompt", async () => {
  let calls = 0;
  const deps = launchDeps({
    deliverPrompt: async () => { calls++; },
    findWorkflowCatalogItem: () => ({
      id: "wf-test", name: "sin-inputs", updatedAt: 1,
      config: { stages: [{ key: "plan", label: "Plan", icon: "P" }], verifyAfter: [] },
    }),
  });
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

/**
 * Provisión del entorno: un worktree recién creado no trae `.venv` ni `node_modules`, así que la
 * copia de la sesión no podría correr sus propias pruebas. Se arranca en SEGUNDO PLANO: instalar
 * dependencias tarda minutos y el lanzamiento no puede quedarse esperando ni caerse por ello.
 */
test("una sesión de workflow provisiona el worktree cuando el repo declara setupCommand", async () => {
  const llamadas: { cycle: string; cwd: string; cmd: string }[] = [];
  const deps = launchDeps({
    setupCommandFor: () => "python3 -m venv .venv",
    provision: async (cycle, cwd, cmd) => { llamadas.push({ cycle, cwd, cmd }); },
  });

  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-prov" }, deps);
  assert.deepEqual(llamadas, [{ cycle: "/cycles/cowork-prov", cwd: "/worktrees/cowork-prov", cmd: "python3 -m venv .venv" }]);
});

test("sin setupCommand no se provisiona nada", async () => {
  let veces = 0;
  const deps = launchDeps({ setupCommandFor: () => null, provision: async () => { veces++; } });
  await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-sin-prov" }, deps);
  assert.equal(veces, 0);
});

test("una terminal normal nunca provisiona: no tiene worktree", async () => {
  let veces = 0;
  const deps = launchDeps({ setupCommandFor: () => "npm ci", provision: async () => { veces++; } });
  await launchManagedSession({ repo: "monorepo", name: "cowork-term", mode: "terminal", agent: "claude" }, deps);
  assert.equal(veces, 0);
});

test("el lanzamiento no espera a la provisión ni se cae si revienta", async () => {
  const errores: unknown[] = [];
  const deps = launchDeps({
    setupCommandFor: () => "instalar",
    provision: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("pip falló")), 20)),
    logError: (error) => errores.push(error),
  });

  const resultado = await launchManagedSession({ repo: "monorepo", workflowId: "wf-test", name: "cowork-lenta" }, deps);
  assert.equal(resultado.name, "cowork-lenta"); // resolvió sin esperar los 20ms de la provisión

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(errores.length, 1); // el fallo se reporta, no se traga ni se propaga
});
