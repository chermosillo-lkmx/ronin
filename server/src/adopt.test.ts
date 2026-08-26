import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import {
  AdoptCommitError,
  AdoptValidationError,
  commitAdopt,
  validateAdopt,
  type AdoptDeps,
  type AdoptInventoryEntry,
  type CommitAdoptDeps,
} from "./adopt.js";

function tempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "cowork-adopt-")));
}

function baseInventory(overrides: Partial<AdoptInventoryEntry> = {}): AdoptInventoryEntry {
  return {
    name: "foreign-session",
    kind: "foreign",
    createdAt: 1_700_000_000_000,
    panes: [{ id: "%1" }],
    ...overrides,
  };
}

function baseDeps(overrides: Partial<AdoptDeps> = {}): AdoptDeps {
  return {
    inventory: () => [baseInventory()],
    listRepos: () => ["monorepo"],
    resolveCwd: () => ({ cwd: "/tmp", real: true }),
    allowedRoots: ["/tmp"],
    realpath: (p) => p,
    resolveFlow: () => ({ stages: [{ key: "a", label: "A", icon: "x" }], verifyAfter: null }),
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    session: "foreign-session",
    confirm: true,
    repo: "monorepo",
    paneId: "%1",
    expectedSessionCreatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    throw new Error("expected validateAdopt to throw");
  } catch (error) {
    if (error instanceof AdoptValidationError) return error.code;
    throw error;
  }
}

test("sin confirm:true → CONFIRMATION_REQUIRED", () => {
  const deps = baseDeps();
  assert.equal(codeOf(() => validateAdopt(baseInput({ confirm: false }), deps)), "CONFIRMATION_REQUIRED");
  assert.equal(codeOf(() => validateAdopt(baseInput({ confirm: undefined }), deps)), "CONFIRMATION_REQUIRED");
});

test("nombre de sesión inseguro (traversal) → INVALID_SESSION", () => {
  const deps = baseDeps();
  assert.equal(codeOf(() => validateAdopt(baseInput({ session: "../../etc" }), deps)), "INVALID_SESSION");
});

test("sesión ausente del inventario vivo → SESSION_NOT_FOUND", () => {
  const deps = baseDeps({ inventory: () => [] });
  assert.equal(codeOf(() => validateAdopt(baseInput(), deps)), "SESSION_NOT_FOUND");
});

test("B3: expectedSessionCreatedAt que no coincide con el vivo → STALE_VIEW", () => {
  const deps = baseDeps();
  assert.equal(codeOf(() => validateAdopt(baseInput({ expectedSessionCreatedAt: 1 }), deps)), "STALE_VIEW");
});

test("paneId malformado ('1', '%', '$(x)') → INVALID_PANE", () => {
  const deps = baseDeps();
  for (const bad of ["1", "%", "$(x)"]) {
    assert.equal(codeOf(() => validateAdopt(baseInput({ paneId: bad }), deps)), "INVALID_PANE", bad);
  }
});

test("paneId de OTRA sesión → PANE_NOT_IN_SESSION", () => {
  const deps = baseDeps();
  assert.equal(codeOf(() => validateAdopt(baseInput({ paneId: "%99" }), deps)), "PANE_NOT_IN_SESSION");
});

test("repo fuera de listRepos() → REPO_NOT_ALLOWED", () => {
  const deps = baseDeps({ listRepos: () => ["monorepo"] });
  assert.equal(codeOf(() => validateAdopt(baseInput({ repo: "not-listed" }), deps)), "REPO_NOT_ALLOWED");
});

test("repo con resolveCwd().real === false → REPO_NOT_ALLOWED (nunca cae a process.cwd())", () => {
  const deps = baseDeps({ resolveCwd: () => ({ cwd: process.cwd(), real: false }) });
  assert.equal(codeOf(() => validateAdopt(baseInput(), deps)), "REPO_NOT_ALLOWED");
});

test("M1: repo cuyo realpath escapa TODAS las raíces de confianza → REPO_NOT_ALLOWED; uno que resuelve DENTRO se acepta y el registro guarda el realpath", () => {
  const root = tempDir();
  const outside = tempDir();
  const linkOutside = join(root, "link-outside");
  symlinkSync(outside, linkOutside);
  const inside = join(root, "ok");
  mkdirSync(inside);
  const linkInside = join(root, "link-inside");
  symlinkSync(inside, linkInside);

  const escaping = baseDeps({ allowedRoots: [root], resolveCwd: () => ({ cwd: linkOutside, real: true }), realpath: realpathSync });
  assert.equal(codeOf(() => validateAdopt(baseInput(), escaping)), "REPO_NOT_ALLOWED");

  const accepted = baseDeps({ allowedRoots: [root], resolveCwd: () => ({ cwd: linkInside, real: true }), realpath: realpathSync });
  const result = validateAdopt(baseInput(), accepted);
  assert.equal(result.cwd, realpathSync(inside));
});

test("'..' en el valor mapeado que escapa su raíz → REPO_NOT_ALLOWED", () => {
  const root = tempDir();
  const outside = tempDir();
  const traversal = join(root, "sub", "..", "..", basename(outside));
  const deps = baseDeps({ allowedRoots: [root], resolveCwd: () => ({ cwd: traversal, real: true }), realpath: realpathSync });
  assert.equal(codeOf(() => validateAdopt(baseInput(), deps)), "REPO_NOT_ALLOWED");
});

test("el flow adoptado tiene verifyAfter === null aunque el repo traiga otro valor", () => {
  const deps = baseDeps({
    resolveFlow: () => ({ stages: [{ key: "a", label: "A", icon: "x" }, { key: "b", label: "B", icon: "y" }], verifyAfter: "a" }),
  });
  const result = validateAdopt(baseInput(), deps);
  assert.equal(result.workflow.verifyAfter, null);
});

test("ninguna etapa del flow adoptado conserva verifyCmd/maxRetries", () => {
  const deps = baseDeps({
    resolveFlow: () => ({
      stages: [{ key: "a", label: "A", icon: "x", verifyCmd: "npm test", maxRetries: 3 }],
      verifyAfter: null,
    }),
  });
  const result = validateAdopt(baseInput(), deps);
  assert.deepEqual(result.workflow.stages, [{ key: "a", label: "A", icon: "x" }]);
});

test("sesión ya managed (por prefijo o por marca) → ALREADY_MANAGED", () => {
  const deps = baseDeps({ inventory: () => [baseInventory({ kind: "managed" })] });
  assert.equal(codeOf(() => validateAdopt(baseInput(), deps)), "ALREADY_MANAGED");
});

test("sin paneId y 2+ panes → PANE_AMBIGUOUS; con exactamente 1 pane → adopta ese", () => {
  const ambiguous = baseDeps({ inventory: () => [baseInventory({ panes: [{ id: "%1" }, { id: "%2" }] })] });
  assert.equal(codeOf(() => validateAdopt(baseInput({ paneId: undefined }), ambiguous)), "PANE_AMBIGUOUS");

  const single = baseDeps({ inventory: () => [baseInventory({ panes: [{ id: "%7" }] })] });
  const result = validateAdopt(baseInput({ paneId: undefined }), single);
  assert.equal(result.paneId, "%7");
});

// ---- T2: commitAdopt (persistencia atómica + rollback, cierra B4) ----

function baseCommitDeps(overrides: Partial<CommitAdoptDeps> = {}): { deps: CommitAdoptDeps; cycle: string; calls: string[] } {
  // El PADRE existe (mkdtemp), pero el propio cycle dir NO — así snapshotExisted es false y
  // el rollback puede borrarlo de verdad. El test "preexistente" lo crea a mano antes de llamar.
  const cycle = join(tempDir(), "cycle");
  const calls: string[] = [];
  const marks = new Map<string, string>();
  const deps: CommitAdoptDeps = {
    ...baseDeps(),
    cycleDirForSession: () => cycle,
    liveSessionSnapshot: async () => ({ createdAt: baseInventory().createdAt, panes: baseInventory().panes }),
    setAdoptedMark: async (session, payload) => { calls.push("setMark"); marks.set(session, payload); },
    readAdoptedMark: async (session) => marks.get(session) ?? null,
    clearAdoptedMark: async (session) => { calls.push("clearMark"); marks.delete(session); },
    registerWorker: () => { calls.push("registerWorker"); },
    serialize: (_session, fn) => fn(),
    ...overrides,
  };
  return { deps, cycle, calls };
}

test("commitAdopt: adopción válida crea cycle dir + evidence/ + adopted.json + flow.json legibles + marca tmux", async () => {
  const { deps, cycle, calls } = baseCommitDeps();
  const outcome = await commitAdopt(baseInput(), deps);
  assert.equal(outcome.status, "created");
  assert.equal(existsSync(cycle), true);
  assert.equal(existsSync(join(cycle, "evidence")), true);
  assert.deepEqual(JSON.parse(readFileSync(join(cycle, "adopted.json"), "utf8")).session, "foreign-session");
  assert.ok(existsSync(join(cycle, "flow.json")));
  assert.equal(await deps.readAdoptedMark("foreign-session") !== null, true);
  assert.deepEqual(calls, ["setMark", "registerWorker"]);
});

test("commitAdopt: si escribir adopted.json falla, no hay marca tmux, no hay worker, y el cycle dir se borra SÓLO si lo creamos nosotros", async () => {
  const { deps, cycle, calls } = baseCommitDeps();
  const broken: CommitAdoptDeps = {
    ...deps,
    resolveFlow: () => { throw new Error("simulated disk failure writing adopted.json"); },
  };
  await assert.rejects(() => commitAdopt(baseInput(), broken));
  assert.equal(existsSync(cycle), false, "el dir que creamos nosotros se borra en el rollback");
  assert.deepEqual(calls, []);
});

test("commitAdopt: el cycle dir preexistente NO se borra en un rollback (sólo se borra el que creamos nosotros)", async () => {
  const { deps, cycle } = baseCommitDeps();
  mkdirSync(cycle, { recursive: true });
  writeFileSync(join(cycle, "sentinel-previo"), "x");
  const broken: CommitAdoptDeps = { ...deps, resolveFlow: () => { throw new Error("simulated failure"); } };
  await assert.rejects(() => commitAdopt(baseInput(), broken));
  assert.equal(existsSync(join(cycle, "sentinel-previo")), true);
});

test("commitAdopt: si set-option falla, rollback completo — no queda adopted.json ni marca", async () => {
  const { deps, cycle } = baseCommitDeps({ setAdoptedMark: async () => { throw new Error("tmux set-option failed"); } });
  await assert.rejects(() => commitAdopt(baseInput(), deps));
  assert.equal(existsSync(cycle), false);
});

test("commitAdopt: si la relectura de la marca NO coincide con lo escrito, rollback completo", async () => {
  const { deps, cycle } = baseCommitDeps({ readAdoptedMark: async () => "algo-distinto" });
  await assert.rejects(() => commitAdopt(baseInput(), deps));
  assert.equal(existsSync(cycle), false);
});

test("commitAdopt: si el registro del worker falla TRAS la marca, la adopción QUEDA VÁLIDA (no es adopción parcial)", async () => {
  const { deps, cycle } = baseCommitDeps({ registerWorker: () => { throw new Error("engine registration failed"); } });
  const outcome = await commitAdopt(baseInput(), deps);
  assert.equal(outcome.status, "created");
  assert.equal(existsSync(join(cycle, "adopted.json")), true);
  assert.equal(await deps.readAdoptedMark("foreign-session") !== null, true);
});

test("commitAdopt: la misma adopción dos veces (mismo cuerpo) es idempotente — no repite ensureCycleDir/marca/worker", async () => {
  const { deps, calls } = baseCommitDeps();
  const first = await commitAdopt(baseInput(), deps);
  assert.equal(first.status, "created");
  calls.length = 0;
  const second = await commitAdopt(baseInput(), deps);
  assert.equal(second.status, "idempotent");
  assert.deepEqual(calls, []);
});

test("commitAdopt: la misma sesión con un cuerpo DISTINTO → conflict con el registro vigente", async () => {
  const { deps } = baseCommitDeps();
  await commitAdopt(baseInput(), deps);
  const outcome = await commitAdopt(baseInput({ paneId: "%1", repo: "monorepo" }), { ...deps, resolveCwd: () => ({ cwd: "/tmp/otro", real: true }) } as CommitAdoptDeps);
  assert.equal(outcome.status, "conflict");
});

test("D1 (bloqueante, hallado en review): commitAdopt rechaza si la sesión fue matada+recreada (otro createdAt/%N) ENTRE el inventario capturado y esta sección crítica", async () => {
  const { deps } = baseCommitDeps({
    // El inventario que validateAdopt ya usó (vía deps.inventory, congelado por el llamador)
    // sigue diciendo la sesión VIEJA — pero liveSessionSnapshot (re-consultado DENTRO de la
    // sección crítica) ve que YA es otra: createdAt distinto, %N distinto.
    liveSessionSnapshot: async () => ({ createdAt: 1_999_999_999_999, panes: [{ id: "%9" }] }),
  });
  await assert.rejects(
    () => commitAdopt(baseInput(), deps),
    (error: unknown) => {
      assert.ok(error instanceof AdoptValidationError || error instanceof AdoptCommitError);
      assert.match((error as Error).message, /STALE_VIEW|PANE_NOT_IN_SESSION/);
      return true;
    }
  );
});

test("D1: commitAdopt rechaza si sólo el %N cambió (mismo createdAt, sesión recreada instantáneo con distinto layout de panes)", async () => {
  const { deps } = baseCommitDeps({
    liveSessionSnapshot: async () => ({ createdAt: 1_700_000_000_000, panes: [{ id: "%9" }] }), // %1 (esperado) ya no está
  });
  await assert.rejects(() => commitAdopt(baseInput(), deps));
});

test("commitAdopt: un adopted.json cuyo sessionCreatedAt no coincide con el vivo se ignora (sesión recreada con el mismo nombre)", async () => {
  const { deps, cycle } = baseCommitDeps();
  await commitAdopt(baseInput(), deps);
  const staleDeps: CommitAdoptDeps = {
    ...deps,
    inventory: () => [baseInventory({ createdAt: 1_800_000_000_000 })],
    liveSessionSnapshot: async () => ({ createdAt: 1_800_000_000_000, panes: [{ id: "%1" }] }),
  };
  const outcome = await commitAdopt(baseInput({ expectedSessionCreatedAt: 1_800_000_000_000 }), staleDeps);
  assert.equal(outcome.status, "created");
  assert.equal(JSON.parse(readFileSync(join(cycle, "adopted.json"), "utf8")).sessionCreatedAt, 1_800_000_000_000);
});
