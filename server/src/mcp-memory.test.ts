import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleMcp } from "./mcp.js";
import { createMemoryPort, type McpMemoryPort } from "./mcp-memory.js";
import { createMemoryStore } from "./memory.js";

const harness = {} as never; // estas pruebas no tocan el harness

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ronin-mcp-memory-"));
  let seq = 0;
  const store = createMemoryStore({ directory, listRepos: () => ["acme-api", "acme-web"], now: () => 1_790_000_000_000, newId: (prefix) => `${prefix}_${++seq}` });
  return { store, memory: createMemoryPort(store), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

async function call(name: string, args: unknown, memory?: McpMemoryPort, scope?: "agent") {
  const response = await handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { harness, ...(memory ? { memory } : {}), ...(scope ? { scope } : {}) },
  );
  const result = response?.result as { content: Array<{ text: string }>; isError?: true };
  return { text: result.content[0].text, isError: result.isError === true };
}

async function listNames(scope?: "agent", memory?: McpMemoryPort): Promise<string[]> {
  const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { harness, ...(memory ? { memory } : {}), ...(scope ? { scope } : {}) });
  return (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
}

test("memoria_pendiente lista las pendientes de todos los repos o de uno", async () => {
  const { store, memory, cleanup } = fixture();
  try {
    store.propose("acme-api", [{ text: "Pendiente api", kind: "trampa" }], "cowork-a");
    store.propose("acme-web", [{ text: "Pendiente web", kind: "comando" }], "cowork-b");
    const all = await call("memoria_pendiente", {}, memory);
    assert.equal(all.isError, false);
    assert.deepEqual(JSON.parse(all.text), [
      { id: "m_1", repo: "acme-api", text: "Pendiente api", kind: "trampa", source: "cowork-a" },
      { id: "m_2", repo: "acme-web", text: "Pendiente web", kind: "comando", source: "cowork-b" },
    ]);
    assert.deepEqual(JSON.parse((await call("memoria_pendiente", { repo: "acme-web" }, memory)).text).map((e: { id: string }) => e.id), ["m_2"]);
    const unknown = await call("memoria_pendiente", { repo: "acme-otro" }, memory);
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /^MEMORY_INVALID: /);
  } finally {
    cleanup();
  }
});

test("resolver_memoria aprueba, edita y descarta; la de arquitectura queda como sugerencia para la KB", async () => {
  const { store, memory, cleanup } = fixture();
  try {
    store.propose("acme-api", [
      { text: "Pendiente A", kind: "trampa" },
      { text: "Pendiente B", kind: "comando" },
      { text: "El importador vive en src/csv", kind: "arquitectura" },
    ], "cowork-a");
    assert.deepEqual(JSON.parse((await call("resolver_memoria", { id: "m_1", accion: "aprobar" }, memory)).text), { id: "m_1", repo: "acme-api", resultado: "activa" });
    assert.deepEqual(JSON.parse((await call("resolver_memoria", { id: "m_2", accion: "editar", texto: "Pendiente B editada" }, memory)).text), { id: "m_2", repo: "acme-api", resultado: "activa" });
    assert.deepEqual(JSON.parse((await call("resolver_memoria", { id: "m_3", accion: "aprobar" }, memory)).text), { id: "m_3", repo: "acme-api", resultado: "sugerencia_kb" });
    assert.deepEqual(JSON.parse((await call("resolver_memoria", { id: "m_1", accion: "descartar" }, memory)).text), { id: "m_1", repo: "acme-api", resultado: "descartada" });
    const saved = store.read("acme-api");
    assert.deepEqual(saved.entries.map((e) => [e.id, e.status, e.text]), [["m_1", "discarded", "Pendiente A"], ["m_2", "active", "Pendiente B editada"]]);
    assert.deepEqual(saved.kbSuggestions.map((s) => s.text), ["El importador vive en src/csv"]);
  } finally {
    cleanup();
  }
});

test("resolver_memoria: id desconocido → MEMORY_NOT_FOUND; argumentos o transición inválidos → MEMORY_INVALID", async () => {
  const { store, memory, cleanup } = fixture();
  try {
    store.propose("acme-api", [{ text: "Pendiente A", kind: "trampa" }], "cowork-a");
    const cases: Array<[unknown, RegExp]> = [
      [{ id: "m_nope", accion: "aprobar" }, /^MEMORY_NOT_FOUND: /],
      [{ id: "m_1", accion: "borrar" }, /^MEMORY_INVALID: /],
      [{ accion: "aprobar" }, /^MEMORY_INVALID: /],
      [{ id: "m_1", accion: "editar" }, /^MEMORY_INVALID: /],
      [{ id: "m_1", accion: "editar", texto: "x".repeat(201) }, /^MEMORY_INVALID: /],
    ];
    for (const [args, error] of cases) {
      const result = await call("resolver_memoria", args, memory);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.text, error, JSON.stringify(args));
    }
    assert.equal((await call("resolver_memoria", { id: "m_1", accion: "aprobar" }, memory)).isError, false);
    const again = await call("resolver_memoria", { id: "m_1", accion: "aprobar" }, memory);
    assert.equal(again.isError, true);
    assert.match(again.text, /^MEMORY_INVALID: /);
  } finally {
    cleanup();
  }
});

test("scope agent: no lista ni acepta las herramientas de memoria", async () => {
  const { store, memory, cleanup } = fixture();
  try {
    store.propose("acme-api", [{ text: "Pendiente A", kind: "trampa" }], "cowork-a");
    const full = await listNames(undefined, memory);
    assert.ok(full.includes("memoria_pendiente") && full.includes("resolver_memoria"));
    const agent = await listNames("agent", memory);
    assert.equal(agent.includes("memoria_pendiente"), false);
    assert.equal(agent.includes("resolver_memoria"), false);
    for (const [name, args] of [["memoria_pendiente", {}], ["resolver_memoria", { id: "m_1", accion: "aprobar" }]] as const) {
      const result = await call(name, args, memory, "agent");
      assert.equal(result.isError, true, name);
      assert.match(result.text, /no tiene habilitadas las herramientas de memoria/);
    }
    assert.equal(store.read("acme-api").entries[0].status, "pending");
  } finally {
    cleanup();
  }
});

test("sin puerto de memoria, las herramientas responden un error legible", async () => {
  const result = await call("memoria_pendiente", {});
  assert.equal(result.isError, true);
  assert.match(result.text, /no tiene habilitadas las herramientas de memoria/);
});
