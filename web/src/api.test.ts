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
