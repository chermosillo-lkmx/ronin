import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { MainHealthRow } from "../../api.js";
import * as stripModule from "./MainHealthStrip.js";

const green: MainHealthRow = {
  repo: "ant-ms-i18n",
  sha: "a".repeat(40),
  status: "green",
  total: 96.4,
  floor: 90,
  failedCount: 0,
  measuredAt: 1_800_000_000_000,
};

const redOwned: MainHealthRow = {
  repo: "ant-liebre-api",
  sha: "b".repeat(40),
  status: "red",
  total: 84,
  floor: 90,
  failedCount: 3,
  measuredAt: 1_800_000_000_100,
  incident: {
    id: "ant-liebre-api@bbbbbbb",
    openedAt: 1_800_000_000_200,
    owner: { session: "cowork-main-health-api", heartbeat: 1_800_000_000_300 },
  },
};

test("MainHealthStrip renderiza verde, rojo, cobertura, incidente y owner con texto visible", () => {
  const MainHealthStrip = (stripModule as any).MainHealthStrip;
  assert.equal(typeof MainHealthStrip, "function");
  const output = renderToString(createElement(MainHealthStrip, { initialRows: [green, redOwned] }));

  assert.match(output, /aria-label="Salud de main"/);
  assert.match(output, />Salud de main</);
  assert.match(output, />Verde</);
  assert.match(output, />Rojo</);
  assert.match(output, /ant-ms-i18n/);
  assert.match(output, /aaaaaaa/);
  assert.match(output, /96\.4%/);
  assert.match(output, /Piso 90%/);
  assert.match(output, /3 fallos/);
  assert.match(output, /ant-liebre-api@bbbbbbb/);
  assert.match(output, /cowork-main-health-api/);
});

test("MainHealthStrip usa owner remoto corto y presenta vacío discreto", () => {
  const MainHealthStrip = (stripModule as any).MainHealthStrip;
  const remoteOwner = "host-remoto-muy-largo.example.internal/123456";
  const remote: MainHealthRow = {
    ...redOwned,
    incident: { ...redOwned.incident!, owner: undefined, remoteOwner },
  };
  const output = renderToString(createElement(MainHealthStrip, { initialRows: [remote] }));
  assert.match(output, /Remoto/);
  assert.match(output, /host-remoto-muy-largo/);
  assert.doesNotMatch(output, new RegExp(remoteOwner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const empty = renderToString(createElement(MainHealthStrip, { initialRows: [] }));
  assert.match(empty, /Salud de main/);
  assert.match(empty, /Sin mediciones/);
});

test("polling actualiza, conserva datos ante error y limpia su timer", async () => {
  const startPolling = (stripModule as any).startMainHealthPolling;
  assert.equal(typeof startPolling, "function");
  const updates: MainHealthRow[][] = [];
  let interval!: () => void;
  let cleared = false;
  let calls = 0;
  const stop = startPolling({
    load: async () => {
      calls += 1;
      if (calls === 2) throw new Error("sin red");
      return [green];
    },
    onRows: (rows: MainHealthRow[]) => { updates.push(rows); },
    refreshMs: 5_000,
    timers: {
      setInterval: (callback: () => void, ms: number) => { assert.equal(ms, 5_000); interval = callback; return 7; },
      clearInterval: (handle: unknown) => { assert.equal(handle, 7); cleared = true; },
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [[green]]);
  interval();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(updates, [[green]], "un error no borra el último snapshot");
  stop();
  assert.equal(cleared, true);
});

test("SSR usa initialRows y no inicia polling", () => {
  const MainHealthStrip = (stripModule as any).MainHealthStrip;
  let loads = 0;
  const output = renderToString(createElement(MainHealthStrip, {
    initialRows: [green],
    load: async () => { loads += 1; return []; },
  }));
  assert.match(output, /ant-ms-i18n/);
  assert.equal(loads, 0);
});
