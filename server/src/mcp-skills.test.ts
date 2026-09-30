import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLearnedSkillStore } from "./learned-skills.js";
import { handleMcp } from "./mcp.js";
import { createSkillPort, type McpSkillPort } from "./mcp-skills.js";

const harness = {} as never; // estas pruebas no tocan el harness

const DRAFT = {
  repo: "acme-api",
  source: "cowork-mig",
  name: "migracion-reversible",
  description: "Agrega una migración reversible y la prueba ida y vuelta.",
  body: "1. Crea la migración.\n2. Pruébala ida y vuelta.",
};

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ronin-mcp-skills-"));
  let seq = 0;
  const store = createLearnedSkillStore({
    root: join(base, "skills", "learned"),
    metaFile: join(base, "skills", "learned.json"),
    historyDir: join(base, "skills", "history"),
    listRepos: () => ["acme-api", "acme-web"],
    contextFor: (repo) => ({ repo }),
    associate: () => {},
    now: () => 1_790_000_000_000,
    newId: () => `s_${++seq}`,
  });
  return { store, skills: createSkillPort(store), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

async function call(name: string, args: unknown, skills?: McpSkillPort, scope?: "agent") {
  const response = await handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    { harness, ...(skills ? { skills } : {}), ...(scope ? { scope } : {}) },
  );
  const result = response?.result as { content: Array<{ text: string }>; isError?: true };
  return { text: result.content[0].text, isError: result.isError === true };
}

async function listNames(scope?: "agent", skills?: McpSkillPort): Promise<string[]> {
  const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { harness, ...(skills ? { skills } : {}), ...(scope ? { scope } : {}) });
  return (response?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
}

test("skills_pendientes devuelve el SKILL.md completo, su hash, el diff de una actualización y los avisos", async () => {
  const { store, skills, cleanup } = fixture();
  try {
    const created = store.propose(DRAFT);
    const [pending] = JSON.parse((await call("skills_pendientes", {}, skills)).text);
    assert.deepEqual(pending, {
      id: "s_1", kind: "new", name: "migracion-reversible", repo: "acme-api", source: "cowork-mig", description: DRAFT.description,
      content: created.content, contentHash: created.contentHash, diff: null, changes: "", warnings: [],
    });
    store.resolve(created.id, "approve", { contentHash: created.contentHash });
    store.propose({ ...DRAFT, source: "cowork-2", body: `${DRAFT.body}\n3. Revisa https://docs.example.com/migraciones.` });
    const [update] = JSON.parse((await call("skills_pendientes", { repo: "acme-api" }, skills)).text);
    assert.equal(update.kind, "update");
    assert.match(update.diff, /^\+3\. Revisa https:\/\/docs\.example\.com\/migraciones\.$/m);
    assert.deepEqual(update.warnings, ["url-externa"]);
    assert.deepEqual(JSON.parse((await call("skills_pendientes", { repo: "acme-web" }, skills)).text), []);
    const unknown = await call("skills_pendientes", { repo: "acme-otro" }, skills);
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /^SKILL_INVALID: /);
  } finally {
    cleanup();
  }
});

test("resolver_skill aprueba con el hash, edita revalidando y descarta", async () => {
  const { store, skills, cleanup } = fixture();
  try {
    const first = store.propose(DRAFT);
    const second = store.propose({ ...DRAFT, name: "otra-skill" });
    const third = store.propose({ ...DRAFT, name: "tercera" });
    assert.deepEqual(JSON.parse((await call("resolver_skill", { id: first.id, accion: "aprobar", hash: first.contentHash }, skills)).text), {
      id: first.id, name: "migracion-reversible", resultado: "aprobada", version: 1,
    });
    const edited = JSON.parse((await call("resolver_skill", { id: second.id, accion: "editar", contenido: second.content.replace("Pruébala", "Prueba") }, skills)).text);
    assert.deepEqual(edited, { id: second.id, name: "otra-skill", resultado: "aprobada", version: 1 });
    assert.deepEqual(JSON.parse((await call("resolver_skill", { id: third.id, accion: "descartar" }, skills)).text), { id: third.id, name: "tercera", resultado: "descartada" });
    assert.deepEqual(store.pending(), []);
  } finally {
    cleanup();
  }
});

test("resolver_skill: sin hash o con argumentos inválidos → SKILL_INVALID; id desconocido → SKILL_PROPOSAL_NOT_FOUND; hash o base viejos → SKILL_STALE", async () => {
  const { store, skills, cleanup } = fixture();
  try {
    const created = store.propose(DRAFT);
    const cases: Array<[unknown, RegExp]> = [
      [{ id: created.id, accion: "aprobar" }, /^SKILL_INVALID: hash es obligatorio/],
      [{ id: created.id, accion: "borrar" }, /^SKILL_INVALID: /],
      [{ accion: "aprobar", hash: "x" }, /^SKILL_INVALID: /],
      [{ id: created.id, accion: "editar" }, /^SKILL_INVALID: contenido es obligatorio/],
      [{ id: created.id, accion: "editar", contenido: created.content.replace("Pruébala", "token: abcdefgh1234") }, /^SKILL_INVALID: .*credencial asignada/],
      [{ id: "s_nope", accion: "aprobar", hash: "x" }, /^SKILL_PROPOSAL_NOT_FOUND: /],
      [{ id: created.id, accion: "aprobar", hash: "sha256:otro" }, /^SKILL_STALE: /],
    ];
    for (const [args, error] of cases) {
      const result = await call("resolver_skill", args, skills);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.text, error, JSON.stringify(args));
    }
    assert.equal(store.pendingCount(), 1);
  } finally {
    cleanup();
  }
});

test("scope agent: no lista ni acepta las herramientas de skills, y sin puerto responden un error legible", async () => {
  const { store, skills, cleanup } = fixture();
  try {
    const created = store.propose(DRAFT);
    const full = await listNames(undefined, skills);
    assert.ok(full.includes("skills_pendientes") && full.includes("resolver_skill"));
    const agent = await listNames("agent", skills);
    assert.equal(agent.includes("skills_pendientes"), false);
    assert.equal(agent.includes("resolver_skill"), false);
    for (const [name, args] of [["skills_pendientes", {}], ["resolver_skill", { id: created.id, accion: "aprobar", hash: created.contentHash }]] as const) {
      const result = await call(name, args, skills, "agent");
      assert.equal(result.isError, true, name);
      assert.match(result.text, /no tiene habilitadas las herramientas de skills/);
    }
    assert.equal(store.pendingCount(), 1);
    const without = await call("skills_pendientes", {});
    assert.equal(without.isError, true);
    assert.match(without.text, /no tiene habilitadas las herramientas de skills/);
  } finally {
    cleanup();
  }
});
