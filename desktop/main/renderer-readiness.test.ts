import assert from "node:assert/strict";
import test from "node:test";
import { RendererReadinessError, loadDevRenderer, waitForVite } from "./renderer-readiness.js";

test("waitForVite holds renderer navigation until Vite serves HTML", async () => {
  let now = 0;
  let attempts = 0;
  await waitForVite({
    fetch: async () => {
      attempts++;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return { ok: true, status: 200, headers: { get: () => "text/html" } };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
  });
  assert.equal(attempts, 3);
});

test("loadDevRenderer retries a navigation failure under the same readiness policy", async () => {
  let now = 0;
  let loads = 0;
  await loadDevRenderer({
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }),
    loadURL: async () => { if (++loads === 1) throw new Error("Vite fell over"); },
    sleep: async (ms) => { now += ms; },
    now: () => now,
  });
  assert.equal(loads, 2);
});

test("loadDevRenderer keeps Vite probing and navigation inside one 30 second deadline", async () => {
  let now = 0;
  let probes = 0;
  await assert.rejects(
    loadDevRenderer({
      fetch: async () => {
        probes++;
        return { ok: probes === 120, status: probes === 120 ? 200 : 503, headers: { get: () => "text/html" } };
      },
      loadURL: async () => { throw new Error("navigation failed"); },
      sleep: async (ms) => { now += ms; },
      now: () => now,
    }),
    (error: unknown) => error instanceof RendererReadinessError && error.code === "RENDERER_DEV_TIMEOUT",
  );
  assert.equal(now, 30_000);
});

test("waitForVite reports a bounded dev timeout", async () => {
  let now = 0;
  await assert.rejects(
    waitForVite({ fetch: async () => { throw new Error("offline"); }, sleep: async (ms) => { now += ms; }, now: () => now }),
    (error: unknown) => error instanceof RendererReadinessError && error.code === "RENDERER_DEV_TIMEOUT",
  );
});
