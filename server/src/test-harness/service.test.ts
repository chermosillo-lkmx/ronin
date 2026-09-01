import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarnessStore } from "./config.js";
import { createTestHarnessService, type TestHarnessService } from "./service.js";

const NODE = process.execPath;

/** Fixture: un "repo" cuyo `unit` escribe JUnit + Cobertura reales con node. */
function writeFixtureRepo(root: string, opts: { fail?: boolean; coverage?: boolean; slow?: boolean; junit?: boolean } = {}): void {
  mkdirSync(join(root, "svc"), { recursive: true });
  const junit = opts.fail
    ? `<testsuite tests="2" failures="1"><testcase name="ok"/><testcase name="bad"><failure message="boom"/></testcase></testsuite>`
    : `<testsuite tests="2"><testcase name="ok"/><testcase name="ok2"/></testsuite>`;
  const script = [
    "const fs = require('fs');",
    "fs.mkdirSync('reports', { recursive: true });",
    opts.junit === false ? "" : `fs.writeFileSync('reports/junit.xml', ${JSON.stringify(junit)});`,
    opts.coverage === false ? "" : `fs.writeFileSync('reports/cobertura.xml', '<coverage line-rate="0.8" branch-rate="0.5"/>');`,
    "process.stdout.write('TOKEN=' + process.env.TOKEN + ' LEAK=' + (process.env.RONIN_SVC_LEAK ?? 'none'));",
    opts.slow ? "setInterval(() => {}, 1000);" : `process.exit(${opts.fail ? 1 : 0});`,
  ].join("\n");
  writeFileSync(join(root, "svc", "run.js"), script);
}

function setup(): { dir: string; repoRoot: string; service: TestHarnessService; store: ReturnType<typeof createHarnessStore>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ronin-svc-"));
  const repoRoot = join(dir, "repo");
  const store = createHarnessStore({ directory: join(dir, "data"), repos: () => ["fixture", "other"] });
  const service = createTestHarnessService({
    store,
    resolveCwd: (repo) => (repo === "fixture" ? { cwd: repoRoot, real: true } : { cwd: process.cwd(), real: false }),
  });
  return { dir, repoRoot, service, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const UNIT = {
  command: { program: NODE, args: ["run.js"] },
  cwd: "svc",
  junitPath: "reports/junit.xml",
  coberturaPath: "reports/cobertura.xml",
};

test("declared argv creates a run with parsed JUnit and coverage, copies artifacts and never leaks env", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  process.env.RONIN_SVC_LEAK = "leaked";
  try {
    writeFixtureRepo(repoRoot);
    store.saveRepo("fixture", { profiles: [{ name: "dev", variables: { TOKEN: "secreto1" } }], suites: { unit: UNIT } });
    const result = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] });
    assert.equal(result.runIds.length, 1);
    const queued = service.getRun(result.runIds[0])!;
    assert.ok(["queued", "running"].includes(queued.status));
    await service.waitFor(result.runIds[0]);
    const run = service.getRun(result.runIds[0])!;
    assert.equal(run.status, "passed");
    assert.equal(run.exitCode, 0);
    assert.deepEqual(run.totals, { total: 2, passed: 2, failed: 0, skipped: 0, errors: 0 });
    assert.deepEqual(run.coverage, { status: "reported", lines: 80, branches: 50 });
    assert.equal(run.stdout, "TOKEN=*** LEAK=none");
    assert.equal(JSON.stringify(run).includes("secreto1"), false);
    assert.equal(run.artifacts?.length, 2);
    for (const a of run.artifacts!) {
      assert.ok(a.startsWith(store.artifactsDir(run.runId)));
      assert.ok(existsSync(a));
    }
    assert.equal(run.cwd, realpathSync(join(repoRoot, "svc")));
  } finally {
    delete process.env.RONIN_SVC_LEAK;
    cleanup();
  }
});

test("a failing suite is failed with failures listed; missing coverage is not_reported and missing JUnit has a reason", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot, { fail: true, coverage: false });
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: UNIT } });
    const { runIds } = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] });
    await service.waitFor(runIds[0]);
    const run = service.getRun(runIds[0])!;
    assert.equal(run.status, "failed");
    assert.deepEqual(run.failures, [{ name: "bad", message: "boom" }]);
    assert.equal(run.coverage?.status, "not_reported");
    assert.ok(run.fingerprint);

    // El junit.xml de la corrida anterior sigue en el repo: el harness debe borrarlo antes de
    // lanzar, para que un artefacto viejo nunca pase por resultado nuevo.
    writeFixtureRepo(repoRoot, { junit: false });
    const second = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] });
    await service.waitFor(second.runIds[0]);
    const r2 = service.getRun(second.runIds[0])!;
    assert.equal(r2.status, "passed"); // exit 0 sin JUnit sigue siendo verde, pero sin conteos
    assert.equal(r2.totals, undefined);
    assert.match(r2.totalsReason!, /JUnit junit.xml no encontrado/);
  } finally {
    cleanup();
  }
});

test("missing profile, missing suite and unresolvable repo produce blocked runs without spawning", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot);
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: UNIT } });
    const a = await service.start({ kind: "suites", repo: "fixture", profile: "qa", suites: ["unit"] });
    assert.equal(service.getRun(a.runIds[0])?.status, "blocked");
    assert.match(service.getRun(a.runIds[0])!.reason!, /perfil/);
    const b = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["e2e"] });
    assert.match(service.getRun(b.runIds[0])!.reason!, /suite/);
    store.saveRepo("other", { profiles: [{ name: "dev" }], suites: { unit: UNIT } });
    const c = await service.start({ kind: "suites", repo: "other", profile: "dev", suites: ["unit"] });
    assert.match(service.getRun(c.runIds[0])!.reason!, /carpeta/);
    await assert.rejects(service.start({ kind: "suites", repo: "nope", profile: "dev", suites: ["unit"] }), /repo/);
  } finally {
    cleanup();
  }
});

test("cancelling a running child preserves bounded partial output and marks cancelled; timeout marks timeout", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot, { slow: true });
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: UNIT, e2e: { ...UNIT, timeoutMs: 1_000 } } });
    const { runIds } = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(service.getRun(runIds[0])?.status, "running");
    assert.equal(service.cancel(runIds[0]), true);
    await service.waitFor(runIds[0]);
    const run = service.getRun(runIds[0])!;
    assert.equal(run.status, "cancelled");
    assert.match(run.stdout!, /TOKEN=/);
    assert.ok(run.finishedAt);
    assert.equal(service.cancel(runIds[0]), false);

    const t = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["e2e"] });
    await service.waitFor(t.runIds[0]);
    assert.equal(service.getRun(t.runIds[0])?.status, "timeout");
    assert.equal(service.getRun(t.runIds[0])?.coverage?.status, "reported"); // el artefacto ya escrito se conserva
  } finally {
    cleanup();
  }
});

test("runs for the same repo execute FIFO one at a time", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot);
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: UNIT, e2e: UNIT } });
    const { runIds } = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit", "e2e"] });
    await service.waitForAll(runIds);
    const [a, b] = runIds.map((id) => service.getRun(id)!);
    assert.ok(a.finishedAt! <= b.startedAt!, `unit debió terminar antes de que e2e arrancara`);
  } finally {
    cleanup();
  }
});

test("all creates a batch with one child per repo×suite, blocks repos without the profile, and failed reruns only failures", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot, { fail: true });
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: UNIT } });
    store.saveRepo("other", { profiles: [{ name: "qa" }], suites: { unit: UNIT } });
    const all = await service.start({ kind: "all", profile: "dev" });
    assert.ok(all.batchId);
    assert.equal(all.runIds.length, 2);
    await service.waitForAll(all.runIds);
    const byRepo = Object.fromEntries(all.runIds.map((id) => [service.getRun(id)!.repo, service.getRun(id)!]));
    assert.equal(byRepo.fixture.status, "failed");
    assert.equal(byRepo.other.status, "blocked");
    assert.equal(byRepo.fixture.batchId, all.batchId);
    assert.deepEqual(service.getBatch(all.batchId!)?.runIds, all.runIds);

    writeFixtureRepo(repoRoot);
    const failed = await service.start({ kind: "failed", profile: "dev" });
    assert.equal(failed.runIds.length, 1);
    await service.waitForAll(failed.runIds);
    assert.equal(service.getRun(failed.runIds[0])?.status, "passed");
    const nothing = await service.start({ kind: "failed", profile: "dev" });
    assert.equal(nothing.runIds.length, 0);
  } finally {
    cleanup();
  }
});

test("matrix shows unconfigured, blocked and latest terminal state per suite with coverage only when reported", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot);
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: UNIT } });
    let m = service.matrix();
    assert.deepEqual(m.map((r) => [r.repo, r.configured]), [["fixture", true], ["other", false]]);
    assert.equal(m[0].cells.unit.state, "never_run");
    assert.equal(m[0].cells.e2e.state, "unconfigured");
    assert.equal(m[1].cells.unit.state, "unconfigured");
    const { runIds } = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] });
    await service.waitFor(runIds[0]);
    m = service.matrix();
    assert.equal(m[0].cells.unit.state, "passed");
    assert.equal(m[0].cells.unit.runId, runIds[0]);
    assert.equal(m[0].cells.unit.coverage?.lines, 80);
    assert.equal(m[0].cells.unit.totals?.total, 2);
    // el journal es la fuente: una instancia nueva ve lo mismo
    const again = createTestHarnessService({ store: createHarnessStore({ directory: store.directory, repos: () => ["fixture", "other"] }), resolveCwd: () => ({ cwd: repoRoot, real: true }) });
    assert.equal(again.matrix()[0].cells.unit.state, "passed");
    assert.equal(readdirSync(store.artifactsDir(runIds[0])).length, 2);
  } finally {
    cleanup();
  }
});

test("a declared artifact path that escapes the repo via symlink is not copied", async () => {
  const { repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot);
    const outside = mkdtempSync(join(tmpdir(), "ronin-outside-"));
    writeFileSync(join(outside, "junit.xml"), `<testsuite tests="1"><testcase name="x"/></testsuite>`);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(outside, join(repoRoot, "svc", "escape"));
    store.saveRepo("fixture", { profiles: [{ name: "dev" }], suites: { unit: { ...UNIT, junitPath: "escape/junit.xml", coberturaPath: undefined } } });
    const { runIds } = await service.start({ kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] });
    await service.waitFor(runIds[0]);
    const run = service.getRun(runIds[0])!;
    assert.equal(run.totals, undefined);
    assert.match(run.totalsReason!, /fuera del repo/);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    cleanup();
  }
});

/**
 * `--root`: el gate de una etapa corre en el worktree de la sesión, no en el checkout que
 * `repos.json` mapea. Sin poder redirigir la raíz, una sesión aprobaría código que no es el suyo.
 * La ruta llega SÓLO por el CLI y se valida contra las raíces confiables: la API HTTP nunca la
 * acepta, porque el renderer manda identificadores, nunca rutas.
 */
test("start({root}) corre la suite en la raíz indicada en vez de la de repos.json", async () => {
  const { dir, repoRoot, service, store, cleanup } = setup();
  try {
    const worktree = join(dir, "worktree");
    writeFixtureRepo(repoRoot);
    writeFixtureRepo(worktree);
    store.saveRepo("fixture", { profiles: [{ name: "dev", variables: {} }], suites: { unit: UNIT } });

    const result = await service.start(
      { kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] },
      { root: worktree, trustedRoots: [realpathSync(dir)] },
    );
    const run = service.getRun(result.runIds[0])!;
    assert.equal(run.cwd, realpathSync(join(worktree, "svc")));
    assert.notEqual(run.cwd, realpathSync(join(repoRoot, "svc")));
  } finally {
    cleanup();
  }
});

test("start({root}) bloquea una raíz fuera de las raíces confiables, sin ejecutar nada", async () => {
  const { dir, repoRoot, service, store, cleanup } = setup();
  const fuera = mkdtempSync(join(tmpdir(), "ronin-fuera-"));
  try {
    writeFixtureRepo(repoRoot);
    writeFixtureRepo(fuera);
    store.saveRepo("fixture", { profiles: [{ name: "dev", variables: {} }], suites: { unit: UNIT } });

    const result = await service.start(
      { kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] },
      { root: fuera, trustedRoots: [realpathSync(dir)] },
    );
    const run = service.getRun(result.runIds[0])!;
    assert.equal(run.status, "blocked");
    assert.match(run.reason ?? "", /raíz/i);
    assert.equal(run.cwd, undefined);
  } finally {
    rmSync(fuera, { recursive: true, force: true });
    cleanup();
  }
});

test("start({root}) bloquea una raíz que no existe", async () => {
  const { dir, repoRoot, service, store, cleanup } = setup();
  try {
    writeFixtureRepo(repoRoot);
    store.saveRepo("fixture", { profiles: [{ name: "dev", variables: {} }], suites: { unit: UNIT } });
    const result = await service.start(
      { kind: "suites", repo: "fixture", profile: "dev", suites: ["unit"] },
      { root: join(dir, "no-existe"), trustedRoots: [realpathSync(dir)] },
    );
    assert.equal(service.getRun(result.runIds[0])!.status, "blocked");
  } finally {
    cleanup();
  }
});
