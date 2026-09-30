import assert from "node:assert/strict";
import test from "node:test";
import * as api from "./api.js";

test("getHealth conserva false y trata verifyGate ausente como desconocido", async () => {
  assert.equal(typeof api.getHealth, "function");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, verifyGate: false }));
    assert.deepEqual(await api.getHealth(), { verifyGate: false });

    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }));
    assert.equal(await api.getHealth(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getTestsRunCases returns the saved case file and null for historical runs", async () => {
  const originalFetch = globalThis.fetch;
  const file = { runId: "run-1", cases: [{ id: "::ok#0", name: "ok", status: "passed" }], truncated: false };
  try {
    globalThis.fetch = async (input) => {
      assert.equal(input, "/api/tests/runs/run-1/cases");
      return new Response(JSON.stringify(file));
    };
    assert.deepEqual(await api.getTestsRunCases("run-1"), file);

    globalThis.fetch = async () => new Response(JSON.stringify({ code: "CASES_NOT_FOUND" }), { status: 404 });
    assert.equal(await api.getTestsRunCases("run-old"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("closeTmuxSession solicita cleanup y devuelve el reporte del servidor", async () => {
  const originalFetch = globalThis.fetch;
  const report = {
    kind: "managed" as const,
    worktree: { status: "removed" as const, path: "/worktree", branch: "ronin/cowork-clean" },
    cycleDir: { status: "removed" as const, path: "/tmp/cowork-cycle-cowork-clean" },
    containers: { removed: ["abc"], failed: [] },
  };
  try {
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "/api/sessions/cowork-clean");
      assert.equal(init?.method, "DELETE");
      assert.deepEqual(JSON.parse(String(init?.body)), { confirm: true, cleanup: true });
      return new Response(JSON.stringify({ ok: true, cleanup: report }));
    };

    assert.deepEqual(await api.closeTmuxSession("cowork-clean", { cleanup: true }), { ok: true, cleanup: report });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memoria: cada acción llama a la ruta, el método y el cuerpo correctos", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const view = { repo: "acme-api", enabled: true, globalEnabled: true, entries: [], kbSuggestions: [], preview: { text: "", bytes: 0, maxBytes: 2048, omitted: 0 } };
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(view));
    };
    assert.deepEqual(await api.getRepoMemory("acme-api"), view);
    await api.setRepoMemoryEnabled("acme-api", false);
    await api.addRepoMemory("acme-api", { text: "Tests: usar make test-unit", kind: "comando" });
    await api.resolveRepoMemory("acme-api", "m_1", "approve");
    await api.resolveRepoMemory("acme-api", "m_2", "edit", "Texto editado");
    await api.resolveRepoMemory("acme-api", "m_3", "discard");
    await api.deleteRepoMemory("acme-api", "k_1");
    assert.deepEqual(calls, [
      { url: "/api/repos/acme-api/memory", method: "GET", body: undefined },
      { url: "/api/repos/acme-api/memory/enabled", method: "PUT", body: { enabled: false } },
      { url: "/api/repos/acme-api/memory", method: "POST", body: { text: "Tests: usar make test-unit", kind: "comando" } },
      { url: "/api/repos/acme-api/memory/m_1", method: "PATCH", body: { action: "approve" } },
      { url: "/api/repos/acme-api/memory/m_2", method: "PATCH", body: { action: "edit", text: "Texto editado" } },
      { url: "/api/repos/acme-api/memory/m_3", method: "PATCH", body: { action: "discard" } },
      { url: "/api/repos/acme-api/memory/k_1", method: "DELETE", body: undefined },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memoria y destilación: un error del servidor llega como Error con su mensaje", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "sólo se puede aprobar una entrada pendiente", code: "MEMORY_INVALID" }), { status: 409 });
    await assert.rejects(api.resolveRepoMemory("acme-api", "m_1", "approve"), /sólo se puede aprobar una entrada pendiente/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "ya hay una destilación en curso para esta sesión", code: "DISTILL_RUNNING" }), { status: 409 });
    await assert.rejects(api.distillSession("cowork-csv"), /ya hay una destilación en curso/);
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "/api/sessions/cowork-csv/distill");
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({ status: "running", repo: "acme-api", at: 1 }), { status: 202 });
    };
    assert.deepEqual(await api.distillSession("cowork-csv"), { status: "running", repo: "acme-api", at: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skills aprendidas: cada acción llama a la ruta, el método y el cuerpo correctos", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const url = String(input);
      if (url.startsWith("/api/skills/proposals?") || url === "/api/skills/proposals") return new Response(JSON.stringify({ proposals: [{ id: "s_1" }] }));
      return new Response(JSON.stringify({ ok: true }), { status: url.endsWith("/skill") ? 202 : 200 });
    };
    assert.deepEqual(await api.listSkillProposals(), [{ id: "s_1" }]);
    await api.listSkillProposals("acme-api");
    await api.getSkillProposal("s_1");
    await api.resolveSkillProposal("s_1", "approve", { contentHash: "sha256:abc" });
    await api.resolveSkillProposal("s_2", "edit", { content: "---\nname: x\n---\n" });
    await api.resolveSkillProposal("s_3", "discard");
    await api.getRepoSkillLearning("acme-api");
    await api.setRepoSkillLearning("acme-api", false);
    await api.proposeSessionSkill("cowork-mig");
    assert.deepEqual(calls, [
      { url: "/api/skills/proposals", method: "GET", body: undefined },
      { url: "/api/skills/proposals?repo=acme-api", method: "GET", body: undefined },
      { url: "/api/skills/proposals/s_1", method: "GET", body: undefined },
      { url: "/api/skills/proposals/s_1", method: "PATCH", body: { action: "approve", contentHash: "sha256:abc" } },
      { url: "/api/skills/proposals/s_2", method: "PATCH", body: { action: "edit", content: "---\nname: x\n---\n" } },
      { url: "/api/skills/proposals/s_3", method: "PATCH", body: { action: "discard" } },
      { url: "/api/repos/acme-api/skills/learning", method: "GET", body: undefined },
      { url: "/api/repos/acme-api/skills/learning", method: "PUT", body: { enabled: false } },
      { url: "/api/sessions/cowork-mig/skill", method: "POST", body: undefined },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("skills aprendidas: un error del servidor llega como Error con su mensaje y la lista falla a vacío", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "el texto que aprobaste no coincide con la propuesta guardada", code: "SKILL_STALE" }), { status: 409 });
    await assert.rejects(api.resolveSkillProposal("s_1", "approve", { contentHash: "x" }), /no coincide con la propuesta guardada/);
    await assert.rejects(api.proposeSessionSkill("cowork-mig"), /no coincide/);
    assert.deepEqual(await api.listSkillProposals(), []);
    assert.equal(await api.getRepoSkillLearning("acme-api"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
