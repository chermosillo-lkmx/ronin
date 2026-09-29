import assert from "node:assert/strict";
import test from "node:test";
import { handleMcp } from "./mcp.js";
import { McpToolError, type McpSessionPort, type McpLaunchInput } from "./mcp-sessions.js";

const harness = {} as never; // estas pruebas no tocan el harness

function fakePort(overrides: Partial<McpSessionPort> = {}) {
  const calls: { launch: McpLaunchInput[]; reply: Array<[string, string]>; status: Array<string[] | undefined> } = { launch: [], reply: [], status: [] };
  const port: McpSessionPort = {
    catalog: async () => ({ repos: ["todo-api"], workflows: [{ id: "wf-1", name: "plan-tdd-evidencia", stages: ["planning", "implementing", "tests", "done"] }] }),
    launch: async (input) => { calls.launch.push(input); return { name: input.name ?? "cowork-x", branch: "ronin/cowork-x", worktree: "/wt/cowork-x" }; },
    status: async (names) => { calls.status.push(names); return []; },
    reply: async (name, text) => { calls.reply.push([name, text]); },
    ...overrides,
  };
  return { port, calls };
}

async function call(name: string, args: unknown, port?: McpSessionPort) {
  const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { harness, ...(port ? { sessions: port } : {}) });
  const result = response?.result as { content: Array<{ text: string }>; isError?: true };
  return { text: result.content[0].text, isError: result.isError === true };
}

test("tools/list incluye las cuatro herramientas de sesión además de las de pruebas", async () => {
  const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { harness });
  const names = (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  for (const name of ["reportar_pruebas", "estado_pruebas", "listar_repos_y_workflows", "crear_sesion", "estado_sesiones", "responder_sesion"]) {
    assert.ok(names.includes(name), name);
  }
});

test("sin puerto de sesiones, las herramientas responden error legible", async () => {
  const result = await call("listar_repos_y_workflows", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /no tiene habilitadas las herramientas de sesión/);
});

test("listar_repos_y_workflows devuelve el catálogo como JSON", async () => {
  const { port } = fakePort();
  const result = await call("listar_repos_y_workflows", {}, port);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.text), { repos: ["todo-api"], workflows: [{ id: "wf-1", name: "plan-tdd-evidencia", stages: ["planning", "implementing", "tests", "done"] }] });
});

test("crear_sesion pasa repo, workflow, petición, nombre y origen al puerto", async () => {
  const { port, calls } = fakePort();
  const result = await call("crear_sesion", { repo: "todo-api", workflowId: "wf-1", request: "valida títulos", name: "cowork-valida", origen: "clickup:86abc1234" }, port);
  assert.equal(result.isError, false);
  assert.deepEqual(calls.launch, [{ repo: "todo-api", workflowId: "wf-1", request: "valida títulos", name: "cowork-valida", origin: "clickup:86abc1234" }]);
  assert.deepEqual(JSON.parse(result.text), { name: "cowork-valida", branch: "ronin/cowork-x", worktree: "/wt/cowork-x" });
});

test("crear_sesion exige repo, workflowId y request", async () => {
  const { port, calls } = fakePort();
  const result = await call("crear_sesion", { repo: "todo-api", workflowId: "wf-1" }, port);
  assert.equal(result.isError, true);
  assert.match(result.text, /request/);
  assert.equal(calls.launch.length, 0);
});

test("crear_sesion rechaza una petición de más de 8 KB", async () => {
  const { port, calls } = fakePort();
  const result = await call("crear_sesion", { repo: "todo-api", workflowId: "wf-1", request: "x".repeat(8 * 1024 + 1) }, port);
  assert.equal(result.isError, true);
  assert.equal(calls.launch.length, 0);
});

test("crear_sesion normaliza la petición (sin NUL y recortada) antes de medirla y pasarla", async () => {
  const { port, calls } = fakePort();
  const padded = `  \0${"x".repeat(8 * 1024)}\0\n  `;
  const result = await call("crear_sesion", { repo: "todo-api", workflowId: "wf-1", request: padded, name: "cowork-n" }, port);
  assert.equal(result.isError, false, result.text);
  assert.equal(calls.launch[0]?.request, "x".repeat(8 * 1024));
});

test("crear_sesion rechaza una petición que sólo tiene NUL y espacios", async () => {
  const { port, calls } = fakePort();
  const result = await call("crear_sesion", { repo: "todo-api", workflowId: "wf-1", request: " \0 \0 " }, port);
  assert.equal(result.isError, true);
  assert.match(result.text, /^TOOL_INPUT_INVALID: /);
  assert.equal(calls.launch.length, 0);
});

test("crear_sesion propaga errores de lanzamiento como resultado de error", async () => {
  const { port } = fakePort({ launch: async () => { throw new McpToolError("SESSION_ALREADY_EXISTS", "ya existe una sesión con ese nombre"); } });
  const result = await call("crear_sesion", { repo: "todo-api", workflowId: "wf-1", request: "x", name: "cowork-dup" }, port);
  assert.equal(result.isError, true);
  assert.match(result.text, /SESSION_ALREADY_EXISTS: ya existe una sesión con ese nombre/);
});

test("estado_sesiones acepta names opcional y valida su tipo", async () => {
  const { port, calls } = fakePort();
  assert.equal((await call("estado_sesiones", {}, port)).isError, false);
  assert.equal((await call("estado_sesiones", { names: ["cowork-a"] }, port)).isError, false);
  const bad = await call("estado_sesiones", { names: "cowork-a" }, port);
  assert.equal(bad.isError, true);
  assert.deepEqual(calls.status, [undefined, ["cowork-a"]]);
});

test("responder_sesion exige name y text de tipo string", async () => {
  const { port, calls } = fakePort();
  assert.equal((await call("responder_sesion", { name: "cowork-a", text: 42 }, port)).isError, true);
  const ok = await call("responder_sesion", { name: "cowork-a", text: "sí, adelante" }, port);
  assert.equal(ok.isError, false);
  assert.deepEqual(JSON.parse(ok.text), { ok: true });
  assert.deepEqual(calls.reply, [["cowork-a", "sí, adelante"]]);
});
