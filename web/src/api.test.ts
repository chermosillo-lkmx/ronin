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
