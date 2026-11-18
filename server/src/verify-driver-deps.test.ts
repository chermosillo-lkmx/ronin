import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  createVerifyDriverDeps,
  gateConfigFrom,
  realVerifyDriverDeps,
  resolveMainMergeBase,
  type VerifyDriverDepSources,
} from "./verify-driver-deps.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function sources(overrides: Partial<VerifyDriverDepSources> = {}): VerifyDriverDepSources {
  return {
    readTmuxInventory: async () => ({ sessions: [], diagnostic: null }),
    readLaunch: () => null,
    readFlow: () => null,
    resolveFlow: () => ({ stages: [], verifyAfter: [] }),
    cycleDirForSession: (name) => `/cycle/${name}`,
    detectStage: () => null,
    gateSettings: () => ({ timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 }),
    repoGate: () => ({}),
    deliverPrompt: async () => true,
    ...overrides,
  };
}

test("listSessions marca ocupado sólo cuando attention.level es working", async () => {
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({
      diagnostic: null,
      sessions: [
        { name: "cowork-working", kind: "managed", attention: { level: "working" } },
        { name: "cowork-idle", kind: "managed", attention: { level: "idle" } },
        { name: "cowork-shell", kind: "managed", attention: { level: "shell" } },
        { name: "cowork-decision", kind: "managed", attention: { level: "decision" } },
        { name: "cowork-gone", kind: "managed", attention: { level: "gone" } },
        { name: "cowork-without-attention", kind: "managed" },
      ],
    }),
  }));

  assert.deepEqual(await deps.listSessions(), [
    { name: "cowork-working", busy: true },
    { name: "cowork-idle", busy: false },
    { name: "cowork-shell", busy: false },
    { name: "cowork-decision", busy: false },
    { name: "cowork-gone", busy: false },
    { name: "cowork-without-attention", busy: false },
  ]);
});

test("listSessions descarta sesiones ajenas", async () => {
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({
      diagnostic: null,
      sessions: [
        { name: "cowork-managed", kind: "managed", attention: { level: "working" } },
        { name: "foreign-session", kind: "foreign", attention: { level: "working" } },
      ],
    }),
  }));

  assert.deepEqual(await deps.listSessions(), [{ name: "cowork-managed", busy: true }]);
});

test("listSessions no interpreta inventario diagnosticado", async () => {
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({
      diagnostic: { kind: "tmux-not-found", message: "tmux no está disponible" },
      sessions: [{ name: "cowork-managed", kind: "managed", attention: { level: "working" } }],
    }),
  }));

  assert.deepEqual(await deps.listSessions(), []);
});

test("launchOf devuelve null si falta launch.json", () => {
  const deps = createVerifyDriverDeps(sources({ readLaunch: () => null }));
  assert.equal(deps.launchOf("cowork-missing"), null);
});

test("launchOf devuelve null ante JSON inválido", () => {
  const deps = createVerifyDriverDeps(sources({
    readLaunch: () => { throw new SyntaxError("JSON inválido"); },
  }));
  assert.equal(deps.launchOf("cowork-invalid"), null);
});

test("launchOf devuelve null con mode o repo de tipo incorrecto", () => {
  const deps = createVerifyDriverDeps(sources({ readLaunch: () => ({ mode: 42, repo: false, worktree: "/wt" }) }));
  assert.equal(deps.launchOf("cowork-wrong-types"), null);
  const invalidMode = createVerifyDriverDeps(sources({ readLaunch: () => ({ mode: "script", repo: "monorepo" }) }));
  assert.equal(invalidMode.launchOf("cowork-wrong-mode"), null);
});

test("launchOf lee los campos del launch.json real de un workflow", () => {
  const deps = createVerifyDriverDeps(sources({
    readLaunch: () => ({
      version: 1,
      name: "cowork-workflow",
      mode: "workflow",
      repo: "monorepo",
      workflowId: "bugfix",
      workflowName: "Bugfix",
      cwd: "/repos/monorepo",
      worktree: "/repos/monorepo/.worktrees/cowork-workflow",
      branch: "cowork/cowork-workflow",
      createdAt: 1_700_000_000_000,
    }),
  }));

  assert.deepEqual(deps.launchOf("cowork-workflow"), {
    mode: "workflow",
    repo: "monorepo",
    worktree: "/repos/monorepo/.worktrees/cowork-workflow",
  });
});

test("A4: flowFor prefiere el flow.json congelado de la sesión", () => {
  let fallbacks = 0;
  const frozen = [{ key: "tests", label: "Tests", verifyCmd: "npm test" }];
  const deps = createVerifyDriverDeps(sources({
    readFlow: (cycle) => cycle === "/cycle/cowork-frozen" ? { stages: frozen, verifyAfter: [] } : null,
    resolveFlow: () => { fallbacks++; return { stages: [], verifyAfter: [] }; },
  }));

  assert.deepEqual(deps.flowFor("cowork-frozen", "monorepo"), frozen);
  assert.equal(fallbacks, 0);
});

test("A4: flowFor cae al override por repo cuando flow.json no existe", () => {
  const override = [{ key: "tests", label: "Tests", verifyCmd: "npm test" }];
  const deps = createVerifyDriverDeps(sources({
    readFlow: () => null,
    resolveFlow: (_keys, repo) => ({ stages: repo === "monorepo" ? override : [], verifyAfter: [] }),
  }));

  assert.deepEqual(deps.flowFor("cowork-missing", "monorepo"), override);
});

test("A4: flowFor cae al override por repo cuando flow.json está corrupto", () => {
  const override = [{ key: "tests", label: "Tests", verifyCmd: "npm test" }];
  const deps = createVerifyDriverDeps(sources({
    readFlow: () => null,
    resolveFlow: () => ({ stages: override, verifyAfter: [] }),
  }));

  assert.deepEqual(deps.flowFor("cowork-corrupt", "monorepo"), override);
});

test("gateConfig incluye UNIT_GATE_XDIST sólo si el repo lo declara", () => {
  const sin = createVerifyDriverDeps(sources({ repoGate: () => ({}) }));
  assert.deepEqual(sin.gateConfig("api").env, { UNIT_GATE_REPORTS_DIR: "reports/ronin-gate", UNIT_GATE_MAX_SUITES: "2", UNIT_GATE_REAL_PG: "0" });
  const con = createVerifyDriverDeps(sources({ repoGate: (repo) => (repo === "api" ? { xdist: 4 } : {}) }));
  assert.deepEqual(con.gateConfig("api").env, { UNIT_GATE_REPORTS_DIR: "reports/ronin-gate", UNIT_GATE_MAX_SUITES: "2", UNIT_GATE_XDIST: "4", UNIT_GATE_REAL_PG: "0" });
  assert.deepEqual(con.gateConfig("otro").env, { UNIT_GATE_REPORTS_DIR: "reports/ronin-gate", UNIT_GATE_MAX_SUITES: "2", UNIT_GATE_REAL_PG: "0" });
});

test("gateConfigFrom fija UNIT_GATE_REAL_PG efectivo sin heredar el entorno", () => {
  const global = { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 };
  assert.equal(gateConfigFrom(global, { realPg: true }).env.UNIT_GATE_REAL_PG, "1");
  assert.equal(gateConfigFrom(global, { realPg: false }).env.UNIT_GATE_REAL_PG, "0");
  assert.equal(gateConfigFrom(global, {}).env.UNIT_GATE_REAL_PG, "0");
});

test("gateConfig comparte gate.maxConcurrent con unit-gate.sh", () => {
  let maxConcurrent = 2;
  const deps = createVerifyDriverDeps(sources({
    gateSettings: () => ({ timeoutMin: 45, maxConcurrent, maxConcurrentLight: 4 }),
  }));
  assert.equal(deps.gateConfig("api").env.UNIT_GATE_MAX_SUITES, "2");
  maxConcurrent = 3;
  assert.equal(deps.gateConfig("api").env.UNIT_GATE_MAX_SUITES, "3");
});

test("gateConfig toma el timeout del repo o, si falta, el global (en ms), leído en cada llamada", () => {
  let global = 45;
  const deps = createVerifyDriverDeps(sources({
    gateSettings: () => ({ timeoutMin: global, maxConcurrent: 2, maxConcurrentLight: 4 }),
    repoGate: (repo) => (repo === "lento" ? { timeoutMin: 120 } : {}),
  }));
  assert.equal(deps.gateConfig("lento").timeoutMs, 120 * 60_000);
  assert.equal(deps.gateConfig("api").timeoutMs, 45 * 60_000);
  global = 30;
  assert.equal(deps.gateConfig("api").timeoutMs, 30 * 60_000);
});

test("maxConcurrent sale de gate.maxConcurrent de settings, leído en cada llamada", () => {
  let max = 2;
  const deps = createVerifyDriverDeps(sources({ gateSettings: () => ({ timeoutMin: 45, maxConcurrent: max, maxConcurrentLight: 4 }) }));
  assert.equal(deps.maxConcurrent?.(), 2);
  max = 4;
  assert.equal(deps.maxConcurrent?.(), 4);
});

test("maxConcurrentLight sale de settings y se relee en cada llamada", () => {
  let maxConcurrentLight = 4;
  const deps = createVerifyDriverDeps(sources({ gateSettings: () => ({ timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight }) }));
  assert.equal((deps as any).maxConcurrentLight?.(), 4);
  maxConcurrentLight = 7;
  assert.equal((deps as any).maxConcurrentLight?.(), 7);
});

/** Una sesión de workflow: ventana 0 = el conductor (%3); la 1 la abrió para delegar y es la ACTIVA (%7). */
const conVentanas = (panes: Array<{ id: string; windowIndex: number; role: string | null }>) => async () => ({
  diagnostic: null,
  sessions: [{ name: "cowork-x", kind: "managed" as const, attention: { level: "idle" }, panes }],
});

test("notify: true si la entrega llegó; false si deliverPrompt dice que no o lanza", async () => {
  const vistos: Array<[string, string]> = [];
  const inventario = conVentanas([{ id: "%3", windowIndex: 0, role: "conductor" }]);
  const ok = createVerifyDriverDeps(sources({ readTmuxInventory: inventario, deliverPrompt: async (s, t) => { vistos.push([s, t]); return true; } }));
  assert.equal(await ok.notify!("cowork-x", "UNIT-GATE: PASS"), true);
  assert.deepEqual(vistos, [["%3", "UNIT-GATE: PASS"]]);

  const sinCli = createVerifyDriverDeps(sources({ readTmuxInventory: inventario, deliverPrompt: async () => false }));
  assert.equal(await sinCli.notify!("cowork-x", "t"), false);

  const lanza = createVerifyDriverDeps(sources({ readTmuxInventory: inventario, deliverPrompt: async () => { throw new Error("tmux"); } }));
  assert.equal(await lanza.notify!("cowork-x", "t"), false);
});

test("notify: entrega al pane conductor (%N de la ventana 0), nunca al pane activo de la sesión", async () => {
  const vistos: string[] = [];
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: conVentanas([
      { id: "%3", windowIndex: 0, role: "conductor" },
      { id: "%7", windowIndex: 1, role: "ejecutor" },
    ]),
    deliverPrompt: async (target) => { vistos.push(target); return true; },
  }));
  assert.equal(await deps.notify!("cowork-x", "UNIT-GATE: PASS"), true);
  assert.deepEqual(vistos, ["%3"]);
});

test("notify: en el arreglo de 4 panes entrega al pane driver", async () => {
  const vistos: string[] = [];
  const deps = createVerifyDriverDeps(sources({
    readTmuxInventory: conVentanas([
      { id: "%1", windowIndex: 0, role: "driver" },
      { id: "%2", windowIndex: 0, role: "worker" },
      { id: "%4", windowIndex: 0, role: "review" },
    ]),
    deliverPrompt: async (target) => { vistos.push(target); return true; },
  }));
  assert.equal(await deps.notify!("cowork-x", "t"), true);
  assert.deepEqual(vistos, ["%1"]);
});

test("notify: sin un conductor inequívoco devuelve false y no escribe en ningún pane", async () => {
  let llamadas = 0;
  const entregar = async () => { llamadas++; return true; };
  const ambiguo = createVerifyDriverDeps(sources({
    readTmuxInventory: conVentanas([
      { id: "%1", windowIndex: 0, role: "conductor" },
      { id: "%2", windowIndex: 0, role: "conductor" },
    ]),
    deliverPrompt: entregar,
  }));
  const ausente = createVerifyDriverDeps(sources({ readTmuxInventory: conVentanas([{ id: "%7", windowIndex: 1, role: "ejecutor" }]), deliverPrompt: entregar }));
  const otra = createVerifyDriverDeps(sources({ readTmuxInventory: async () => ({ diagnostic: null, sessions: [] }), deliverPrompt: entregar }));
  const diagnostico = createVerifyDriverDeps(sources({
    readTmuxInventory: async () => ({ diagnostic: { kind: "x" }, sessions: [] }),
    deliverPrompt: entregar,
  }));
  const lanza = createVerifyDriverDeps(sources({ readTmuxInventory: async () => { throw new Error("tmux"); }, deliverPrompt: entregar }));
  for (const d of [ambiguo, ausente, otra, diagnostico, lanza]) assert.equal(await d.notify!("cowork-x", "t"), false);
  assert.equal(llamadas, 0);
});

test("el driver real lee el mtime de los sentinelas (vuelta a pre-merge desde pr/merge)", () => {
  const deps = createVerifyDriverDeps(sources({}));
  assert.equal(typeof deps.sentinelAt, "function");
  assert.equal(deps.sentinelAt!("/no/existe/ronin-ciclo", "pre-merge"), null);
});

test("resolveMainMergeBase usa root/hijo, deriva repo canónico de HTTPS, scp y path", async () => {
  const cases = [
    {
      worktree: "/wt/api",
      head: { repo: "api", sha: SHA_A, dirty: false },
      cwd: "/wt/api",
      remote: "https://github.com/lkmx/ant-liebre-api.git",
      repo: "ant-liebre-api",
    },
    {
      worktree: "/wt/cycle",
      head: { repo: "cfdis", sha: SHA_A, dirty: false },
      cwd: "/wt/cycle/cfdis",
      remote: "git@github.com:lkmx/ant-ms-cfdis.git",
      repo: "ant-ms-cfdis",
    },
    {
      worktree: "/wt/cycle",
      head: { repo: "i18n", sha: SHA_A, dirty: false },
      cwd: "/wt/cycle/i18n",
      remote: "/tmp/remotes/ant-ms-i18n.git",
      repo: "ant-ms-i18n",
    },
  ];
  for (const value of cases) {
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const git = {
      run: async (args: string[], cwd: string) => {
        calls.push({ args, cwd });
        return args[0] === "remote"
          ? { ok: true, out: `${value.remote}\n` }
          : { ok: true, out: `${SHA_B}\n` };
      },
    };

    assert.deepEqual(await resolveMainMergeBase(value.worktree, value.head, git, (path) => path), {
      repo: value.repo,
      sha: SHA_B,
    });
    assert.deepEqual(calls, [
      { args: ["fetch", "-q", "origin", "main"], cwd: value.cwd },
      { args: ["remote", "get-url", "origin"], cwd: value.cwd },
      { args: ["merge-base", SHA_A, "origin/main"], cwd: value.cwd },
    ]);
  }
});

test("resolveMainMergeBase falla cerrado si no puede refrescar origin/main", async () => {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const git = {
    run: async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      return { ok: false, out: "" };
    },
  };

  assert.equal(
    await resolveMainMergeBase("/wt/cycle", { repo: "api", sha: SHA_A, dirty: false }, git, (path) => path),
    null,
  );
  assert.deepEqual(calls, [
    { args: ["fetch", "-q", "origin", "main"], cwd: "/wt/cycle/api" },
  ]);
});

test("resolveMainMergeBase rechaza un subrepo cuyo realpath escapa del worktree", async () => {
  let gitCalls = 0;
  const git = { run: async () => { gitCalls += 1; return { ok: true, out: "" }; } };
  const paths = new Map([
    ["/wt/cycle", "/real/cycle"],
    ["/wt/cycle/api", "/outside/api"],
  ]);

  assert.equal(
    await resolveMainMergeBase(
      "/wt/cycle",
      { repo: "api", sha: SHA_A, dirty: false },
      git,
      (path) => paths.get(path) ?? path,
    ),
    null,
  );
  assert.equal(gitCalls, 0);
});

test("createVerifyDriverDeps propaga el resolver realPath inyectado", async () => {
  const seen: string[] = [];
  const deps = createVerifyDriverDeps(sources({
    realPath: (path) => {
      seen.push(path);
      throw new Error("path ausente");
    },
  }));

  assert.equal(await deps.mainMergeBase!("/wt/cycle", { repo: "api", sha: SHA_A, dirty: false }), null);
  assert.deepEqual(seen, ["/wt/cycle"]);
});

test("resolveMainMergeBase falla cerrado ante path, remoto, repo o SHA inseguros", async () => {
  let calls = 0;
  const never = { run: async () => { calls += 1; return { ok: true, out: "x" }; } };
  assert.equal(await resolveMainMergeBase("/wt", { repo: "../api", sha: SHA_A, dirty: false }, never), null);
  assert.equal(await resolveMainMergeBase("/wt", { repo: "api", sha: "ABC123", dirty: false }, never), null);
  assert.equal(calls, 0);

  const scenarios = [
    [{ ok: true, out: "" }, { ok: false, out: "" }, { ok: true, out: SHA_B }],
    [{ ok: true, out: "" }, { ok: true, out: "git@host:org/a..b.git" }, { ok: true, out: SHA_B }],
    [{ ok: true, out: "" }, { ok: true, out: "git@host:org/repo.git" }, { ok: false, out: "" }],
    [{ ok: true, out: "" }, { ok: true, out: "git@host:org/repo.git" }, { ok: true, out: SHA_B.toUpperCase() }],
  ];
  for (const replies of scenarios) {
    let index = 0;
    const git = { run: async () => replies[index++]! };
    assert.equal(await resolveMainMergeBase("/wt", { repo: "api", sha: SHA_A, dirty: false }, git, (path) => path), null);
  }
});

test("createVerifyDriverDeps propaga ensureMainMeasured y el real conserva sólo el resolver Git", () => {
  const ensureMainMeasured = (_repo: string, _sha: string) => ({ status: "queued" });
  const deps = createVerifyDriverDeps(sources({ ensureMainMeasured }));

  assert.equal(deps.ensureMainMeasured, ensureMainMeasured);
  assert.equal(typeof deps.mainMergeBase, "function");
  assert.equal(typeof realVerifyDriverDeps.mainMergeBase, "function");
  assert.equal(realVerifyDriverDeps.ensureMainMeasured, undefined);
});
