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
