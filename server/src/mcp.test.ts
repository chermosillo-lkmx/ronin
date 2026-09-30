import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessStore } from "./test-harness/config.js";
import { createTestHarnessService } from "./test-harness/service.js";
import { handleMcp, MCP_TOOLS } from "./mcp.js";
import { ensureCapabilityToken } from "./capability.js";
import { createApp } from "./index.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ronin-mcp-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  const store = createHarnessStore({ directory: join(dir, "data"), repos: () => ["fixture"] });
  store.saveRepo("fixture", { profiles: [], suites: {} });
  const harness = createTestHarnessService({ store, trustedRoots: () => [realpathSync(dir)] });
  return { dir, root, store, harness, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const deps = (harness: ReturnType<typeof createTestHarnessService>) => ({ harness, version: "0.1.0-test" });

function invokeMcp(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}, url = "/mcp"): Promise<{ status: number; body?: unknown }> {
  return new Promise((resolve, reject) => {
    const req: any = { method: "POST", url, originalUrl: url, headers, socket: {}, body, get(name: string) { return headers[name.toLowerCase()]; } };
    const res: any = {
      statusCode: 200,
      setHeader() {},
      getHeader() { return undefined; },
      getHeaders() { return {}; },
      status(status: number) { this.statusCode = status; return this; },
      json(value: unknown) { resolve({ status: this.statusCode, body: value }); },
      end() { resolve({ status: this.statusCode }); },
    };
    app.handle(req, res, reject);
  });
}

test("initialize conserva exactamente la versión de protocolo del cliente", async () => {
  const { harness, cleanup } = setup();
  try {
    const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, deps(harness));
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ronin", version: "0.1.0-test" } },
    });
  } finally {
    cleanup();
  }
});

test("las notificaciones MCP no producen respuesta", async () => {
  const { harness, cleanup } = setup();
  try {
    assert.equal(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, deps(harness)), null);
  } finally {
    cleanup();
  }
});

test("POST /mcp exige capability y responde 202 vacío a una notificación", async () => {
  const { harness, cleanup } = setup();
  try {
    const app = createApp({ harness });
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    assert.equal((await invokeMcp(app, notification)).status, 401);
    const token = ensureCapabilityToken();
    assert.deepEqual(await invokeMcp(app, notification, { "x-ronin-capability": token }), { status: 202 });
  } finally {
    cleanup();
  }
});

test("tools/list publica reportar_pruebas y estado_pruebas con JSON Schema", async () => {
  const { harness, cleanup } = setup();
  try {
    const response: any = await handleMcp({ jsonrpc: "2.0", id: "tools", method: "tools/list" }, deps(harness));
    assert.deepEqual(response.result.tools.map((tool: { name: string }) => tool.name), [
      "reportar_pruebas", "estado_pruebas",
      "listar_repos_y_workflows", "crear_sesion", "estado_sesiones", "responder_sesion",
      "memoria_pendiente", "resolver_memoria",
      "skills_pendientes", "resolver_skill",
    ]);
    assert.equal(response.result.tools[0].inputSchema.type, "object");
    assert.deepEqual(response.result.tools[0].inputSchema.required, ["repo", "suite", "junitPath"]);
    assert.equal(response.result.tools[1].inputSchema.properties.repo.type, "string");
  } finally {
    cleanup();
  }
});

test("scope agent: tools/list sólo publica las herramientas de pruebas y bloquea las de sesión", async () => {
  const { harness, cleanup } = setup();
  try {
    const port = {
      catalog: async () => ({ repos: ["fixture"], workflows: [] }),
      launch: async () => { throw new Error("no debería lanzarse"); },
      status: async () => [],
      reply: async () => { throw new Error("no debería responder"); },
    };
    const list: any = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...deps(harness), sessions: port, scope: "agent" });
    assert.deepEqual(list.result.tools.map((tool: { name: string }) => tool.name), ["reportar_pruebas", "estado_pruebas"]);
    const call: any = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listar_repos_y_workflows", arguments: {} } }, { ...deps(harness), sessions: port, scope: "agent" });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /no tiene habilitadas las herramientas de sesión/);
  } finally {
    cleanup();
  }
});

test("POST /mcp?scope=agent no expone el puerto de sesiones; sin scope sí", async () => {
  const { harness, cleanup } = setup();
  try {
    const mcpSessions = {
      catalog: async () => ({ repos: ["fixture"], workflows: [] }),
      launch: async () => { throw new Error("no debería lanzarse"); },
      status: async () => [],
      reply: async () => { throw new Error("no debería responder"); },
    };
    const app = createApp({ harness, mcpSessions });
    const token = ensureCapabilityToken();
    const headers = { "x-ronin-capability": token };
    const catalogCall = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "listar_repos_y_workflows", arguments: {} } };
    const listCall = { jsonrpc: "2.0", id: 2, method: "tools/list" };
    const agentCall: any = await invokeMcp(app, catalogCall, headers, "/mcp?scope=agent");
    assert.equal(agentCall.body.result.isError, true);
    assert.match(agentCall.body.result.content[0].text, /no tiene habilitadas/);
    const agentList: any = await invokeMcp(app, listCall, headers, "/mcp?scope=agent");
    assert.deepEqual(agentList.body.result.tools.map((tool: { name: string }) => tool.name), ["reportar_pruebas", "estado_pruebas"]);
    const externalCall: any = await invokeMcp(app, catalogCall, headers);
    assert.equal(externalCall.body.result.isError, undefined);
    assert.deepEqual(JSON.parse(externalCall.body.result.content[0].text), { repos: ["fixture"], workflows: [] });
  } finally {
    cleanup();
  }
});

test("un método desconocido es un error JSON-RPC -32601", async () => {
  const { harness, cleanup } = setup();
  try {
    const response: any = await handleMcp({ jsonrpc: "2.0", id: 3, method: "no/existe" }, deps(harness));
    assert.equal(response.error.code, -32601);
  } finally {
    cleanup();
  }
});

test("un id JSON-RPC inválido devuelve -32600 sin ejecutar la herramienta", async () => {
  const { root, store, harness, cleanup } = setup();
  try {
    const junitPath = join(root, "junit.xml");
    writeFileSync(junitPath, `<testsuite tests="1"><testcase name="ok"/></testsuite>`);
    const response: any = await handleMcp({ jsonrpc: "2.0", id: true, method: "tools/call", params: { name: "reportar_pruebas", arguments: { repo: "fixture", suite: "unit", junitPath } } }, deps(harness));
    assert.equal(response.error.code, -32600);
    assert.equal(store.listRuns().length, 0);
  } finally {
    cleanup();
  }
});

test("reportar_pruebas responde los números extraídos y estado_pruebas deja visible la procedencia", async () => {
  const { root, harness, cleanup } = setup();
  try {
    const junitPath = join(root, "junit.xml");
    const coberturaPath = join(root, "cobertura.xml");
    writeFileSync(junitPath, `<testsuite tests="2" failures="1"><testcase name="ok"/><testcase name="bad"><failure message="real"/></testcase></testsuite>`);
    writeFileSync(coberturaPath, `<coverage line-rate="0.8"/>`);
    const reported: any = await handleMcp({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "reportar_pruebas", arguments: { repo: "fixture", suite: "unit", junitPath, coberturaPath, profile: "ci: el agente dijo 999 pasaron" } },
    }, deps(harness));
    assert.equal(reported.result.isError, undefined);
    assert.match(reported.result.content[0].text, /1 pasaron, 1 fallaron, cobertura 80%/);

    const state: any = await handleMcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "estado_pruebas", arguments: { repo: "fixture" } } }, deps(harness));
    assert.match(state.result.content[0].text, /procedencia: agent/);
    assert.match(state.result.content[0].text, /fallos: 1/);
    assert.ok(state.result.content[0].text.length < 25_000);
  } finally {
    cleanup();
  }
});

test("reportar_pruebas accepts explicit origin fields, persists them and mentions the origin", async () => {
  const { root, store, harness, cleanup } = setup();
  try {
    const junitPath = join(root, "origin-junit.xml");
    writeFileSync(junitPath, `<testsuite><testcase name="ok"/></testsuite>`);
    const response: any = await handleMcp({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "reportar_pruebas", arguments: { repo: "fixture", suite: "unit", junitPath, session: "cowork-origin", ticket: "CU-42", commit: "abc1234" } },
    }, deps(harness));

    assert.equal(response.result.isError, undefined);
    assert.match(response.result.content[0].text, /origen: sesión cowork-origin · ticket CU-42 · commit abc1234/);
    assert.deepEqual(store.listRuns()[0].trigger, { session: "cowork-origin", ticket: "CU-42", commit: "abc1234", source: "explicit" });
    assert.equal((MCP_TOOLS[0].inputSchema.properties as any).ticket.type, "string");
    assert.equal((MCP_TOOLS[0].inputSchema.properties as any).commit.type, "string");
    assert.equal((MCP_TOOLS[0].inputSchema.properties as any).session.type, "string");
  } finally {
    cleanup();
  }
});

test("reportar_pruebas devuelve isError y no registra ante JUnit ilegible o ruta no confiable", async () => {
  const { dir, root, store, harness, cleanup } = setup();
  const outside = mkdtempSync(join(tmpdir(), "ronin-mcp-outside-"));
  try {
    const badPath = join(root, "bad.xml");
    writeFileSync(badPath, "<html/>");
    const bad: any = await handleMcp({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "reportar_pruebas", arguments: { repo: "fixture", suite: "unit", junitPath: badPath } } }, deps(harness));
    assert.equal(bad.result.isError, true);
    assert.equal(store.listRuns().length, 0);

    const outsidePath = join(outside, "junit.xml");
    writeFileSync(outsidePath, `<testsuite tests="1"><testcase name="ok"/></testsuite>`);
    const rejected: any = await handleMcp({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "reportar_pruebas", arguments: { repo: "fixture", suite: "unit", junitPath: outsidePath } } }, deps(harness));
    assert.equal(rejected.result.isError, true);
    assert.equal(store.listRuns().length, 0);
    assert.ok(dir);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    cleanup();
  }
});

test("POST /mcp enruta crear_sesion al puerto de sesiones con capability", async () => {
  const { harness, cleanup } = setup();
  try {
    const launched: unknown[] = [];
    const mcpSessions = {
      catalog: async () => ({ repos: ["fixture"], workflows: [] }),
      launch: async (input: unknown) => { launched.push(input); return { name: "cowork-http", branch: "ronin/cowork-http" }; },
      status: async () => [],
      reply: async () => {},
    };
    const app = createApp({ harness, mcpSessions });
    const token = ensureCapabilityToken();
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crear_sesion", arguments: { repo: "fixture", workflowId: "wf-1", request: "hola", name: "cowork-http" } } };
    assert.equal((await invokeMcp(app, body)).status, 401);
    const response = await invokeMcp(app, body, { "x-ronin-capability": token });
    assert.equal(response.status, 200);
    const result = (response.body as { result: { content: Array<{ text: string }>; isError?: true } }).result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { name: "cowork-http", branch: "ronin/cowork-http" });
    assert.deepEqual(launched, [{ repo: "fixture", workflowId: "wf-1", request: "hola", name: "cowork-http" }]);
  } finally {
    cleanup();
  }
});

test("POST /mcp: memoria_pendiente sólo existe sin scope; con scope=agent se rechaza sin tocar el puerto", async () => {
  const { harness, cleanup } = setup();
  try {
    let calls = 0;
    const mcpMemory = {
      pending: async () => { calls++; return [{ id: "m_1", repo: "fixture", text: "Pendiente", kind: "trampa" as const, source: "cowork-a" }]; },
      resolve: async () => { throw new Error("no debería resolver"); },
    };
    const app = createApp({ harness, mcpMemory });
    const headers = { "x-ronin-capability": ensureCapabilityToken() };
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memoria_pendiente", arguments: {} } };
    const agent: any = await invokeMcp(app, body, headers, "/mcp?scope=agent");
    assert.equal(agent.body.result.isError, true);
    assert.equal(calls, 0);
    const agentList: any = await invokeMcp(app, { jsonrpc: "2.0", id: 2, method: "tools/list" }, headers, "/mcp?scope=agent");
    assert.equal(agentList.body.result.tools.some((tool: { name: string }) => tool.name === "memoria_pendiente"), false);
    const external: any = await invokeMcp(app, body, headers);
    assert.equal(external.body.result.isError, undefined);
    assert.equal(JSON.parse(external.body.result.content[0].text)[0].id, "m_1");
    assert.equal(calls, 1);
  } finally {
    cleanup();
  }
});
