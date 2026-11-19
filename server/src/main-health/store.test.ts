import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMainHealthStore, type MainHealthMeasurement } from "./store.js";

const SHA = "a".repeat(40);

function measurement(overrides: Partial<MainHealthMeasurement> = {}): MainHealthMeasurement {
  return {
    sha: SHA,
    repo: "api",
    status: "red",
    tests: 3,
    total: 80,
    floor: 90,
    failed: ["tests.test_app::test_falla"],
    errors: [],
    skipped: 1,
    skipped_by_reason: { "needs db": 1 },
    uncovered_by_file: { "src/app.py": [2, 8] },
    duration: 125,
    at: 1_000,
    gate_rc: 1,
    ...overrides,
  };
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-store-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("store lee mediciones y errores válidos sin exponer referencias mutables", () => {
  withRoot((root) => {
    const store = createMainHealthStore({ root });
    const expected = measurement();
    store.writeMeasurement(expected);
    store.writeError({ sha: SHA, reason: "falló junit", at: 900, log_tail: "detalle" }, "api");

    const read = store.readMeasurement("api", SHA)!;
    assert.deepEqual(read, expected);
    read.failed.push("mutación");
    assert.deepEqual(store.readMeasurement("api", SHA)?.failed, expected.failed);

    const error = store.readError("api", SHA)!;
    error.reason = "mutado";
    assert.equal(store.readError("api", SHA)?.reason, "falló junit");
    assert.deepEqual(JSON.parse(readFileSync(join(root, "api", `${SHA}.json`), "utf8")), expected);
  });
});

test("store tolera JSON corrupto o shape inválido y bloquea traversal", () => {
  withRoot((base) => {
    const root = join(base, "health");
    const repoDir = join(root, "api");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, `${SHA}.json`), "{");
    assert.equal(createMainHealthStore({ root }).readMeasurement("api", SHA), null);

    writeFileSync(join(repoDir, `${SHA}.json`), JSON.stringify({ ...measurement(), tests: "tres" }));
    writeFileSync(join(repoDir, `${SHA}.error.json`), JSON.stringify({ sha: SHA, reason: 7, at: 1, log_tail: "x" }));
    const store = createMainHealthStore({ root });
    assert.equal(store.readMeasurement("api", SHA), null);
    assert.equal(store.readError("api", SHA), null);

    const outside = join(base, "escape");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, `${SHA}.json`), JSON.stringify(measurement({ repo: "escape" })));
    assert.equal(store.readMeasurement("../escape", SHA), null);
    assert.equal(store.readMeasurement("api", `../${SHA}`), null);
    assert.throws(() => store.writeMeasurement(measurement({ repo: "../escape" })), /repo inválido/);
    assert.throws(() => store.writeError({ sha: `../${SHA}`, reason: "x", at: 1, log_tail: "" }, "api"), /SHA inválido/);
  });
});

test("store lista sólo mediciones válidas del repo y obtiene la última por at", () => {
  withRoot((root) => {
    const store = createMainHealthStore({ root });
    const older = measurement({ sha: "b".repeat(40), at: 20 });
    const latest = measurement({ sha: "c".repeat(40), status: "green", at: 80 });
    store.writeMeasurement(latest);
    store.writeMeasurement(older);
    writeFileSync(join(root, "api", `${"d".repeat(40)}.json`), JSON.stringify({ nope: true }));
    writeFileSync(join(root, "api", "nota.txt"), "ignorar");

    assert.deepEqual(store.listMeasurements("api").map((item) => item.sha), [latest.sha, older.sha]);
    assert.deepEqual(store.latestMeasurement("api"), latest);
    assert.deepEqual(store.listMeasurements("../api"), []);
    assert.equal(store.latestMeasurement("sin-repo"), null);
  });
});

test("store conserva un puntero atómico a la última medición operacional confirmada", () => {
  withRoot((root) => {
    let now = 4_000;
    const writes: Array<{ target: string; value: unknown }> = [];
    const store = createMainHealthStore({
      root,
      now: () => now,
      atomicWrite: (target, value) => {
        writes.push({ target, value });
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, JSON.stringify(value));
      },
    });
    const operational = measurement({ sha: "b".repeat(40), at: 20 });
    const newerBaseline = measurement({ sha: "c".repeat(40), status: "green", at: 80 });
    store.writeMeasurement(operational);
    store.confirmOperationalMeasurement("api", operational.sha);
    now = 5_000;
    store.writeMeasurement(newerBaseline);

    assert.deepEqual(store.latestMeasurement("api"), newerBaseline, "el historial conserva orden por fecha");
    assert.deepEqual(store.latestOperationalMeasurement("api"), operational, "baseline no mueve el puntero");
    assert.deepEqual(writes.find(({ target }) => target.endsWith("operational.json")), {
      target: join(root, "api", "operational.json"),
      value: { sha: operational.sha, confirmedAt: 4_000 },
    });

    writeFileSync(join(root, "api", "operational.json"), JSON.stringify({ sha: "../escape", confirmedAt: 6_000 }));
    assert.equal(store.latestOperationalMeasurement("api"), null, "puntero corrupto falla cerrado");
    assert.throws(() => store.confirmOperationalMeasurement("../api", operational.sha), /repo inválido/);
    assert.throws(() => store.confirmOperationalMeasurement("api", "abreviado"), /SHA inválido/);
  });
});

test("store considera reciente un error sólo durante menos de una hora con reloj inyectado", () => {
  withRoot((root) => {
    const now = 10_000_000;
    const store = createMainHealthStore({ root, now: () => now });
    store.writeError({ sha: SHA, reason: "reciente", at: now - 3_599_999, log_tail: "" }, "api");
    assert.equal(store.hasRecentError("api", SHA), true);

    store.writeError({ sha: SHA, reason: "límite", at: now - 3_600_000, log_tail: "" }, "api");
    assert.equal(store.hasRecentError("api", SHA), false);
    assert.equal(store.hasRecentError("../api", SHA), false);
  });
});

test("store resuelve root desde MAIN_HEALTH_DIR o desde home inyectado", () => {
  assert.equal(
    createMainHealthStore({ env: { MAIN_HEALTH_DIR: "/salud/configurada" }, home: () => "/no-usar" }).root,
    "/salud/configurada",
  );
  assert.equal(
    createMainHealthStore({ env: {}, home: () => "/home/prueba" }).root,
    join("/home/prueba", ".cowork", "main-health"),
  );
});
