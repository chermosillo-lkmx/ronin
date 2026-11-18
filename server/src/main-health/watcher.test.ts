import assert from "node:assert/strict";
import test from "node:test";
import type { Incident, OpenIncidentInput } from "./incident.js";
import type { MainHealthAttribution } from "./attribution.js";
import type { MainHealthError, MainHealthMeasurement } from "./store.js";
import { createMainHealthWatcher } from "./watcher.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function measurement(repo: string, sha: string, status: "green" | "red" = "green"): MainHealthMeasurement {
  return {
    repo,
    sha,
    status,
    tests: 10,
    total: 99,
    floor: 100,
    failed: status === "red" ? ["tests::falla"] : [],
    errors: [],
    skipped: 0,
    skipped_by_reason: {},
    uncovered_by_file: {},
    duration: 12,
    at: 1_000,
    gate_rc: status === "red" ? 1 : 0,
  };
}

function attribution(red: MainHealthMeasurement): MainHealthAttribution {
  return {
    status: "no_prior_green",
    reason: "sin medición verde previa",
    redSha: red.sha,
    greenSha: null,
    commits: [],
    culpritShas: [],
    newRed: red.failed,
    unattributedRed: red.failed,
  };
}

function memoryStore(now = 10_000) {
  const measurements = new Map<string, MainHealthMeasurement>();
  const errors = new Map<string, MainHealthError>();
  const key = (repo: string, sha: string) => `${repo}@${sha}`;
  return {
    measurements,
    errors,
    readMeasurement: (repo: string, sha: string) => measurements.get(key(repo, sha)) ?? null,
    readError: (repo: string, sha: string) => errors.get(key(repo, sha)) ?? null,
    hasRecentError(repo: string, sha: string) {
      const value = errors.get(key(repo, sha));
      return value !== undefined && now - value.at >= 0 && now - value.at < 60 * 60_000;
    },
    listMeasurements: (repo: string) => [...measurements.values()].filter((item) => item.repo === repo),
  };
}

const baseSettings = (repos: string[], patch: Record<string, unknown> = {}) => ({
  enabled: true,
  intervalMin: 10,
  repos,
  commentOnPr: false,
  remoteClaim: false,
  autoFix: true,
  leaseMin: 30,
  aliases: {},
  ...patch,
});

function noopIncidents() {
  return {
    readIncident: (_repo: string): Incident | null => null,
    openIncident: (_input: OpenIncidentInput): Incident => { throw new Error("open inesperado"); },
    ensureFixer: async (_repo: string, _repoDir: string) => ({ status: "disabled" as const, session: null }),
    closeIncident: async (_repo: string, _repoDir?: string): Promise<Incident | null> => null,
  };
}

function baseDeps(repos: string[], store = memoryStore()) {
  return {
    readSettings: () => baseSettings(repos),
    store,
    git: { lsRemoteMain: async (_repoDir: string) => SHA_A },
    measure: async (_input: unknown) => undefined,
    repoRoot: "/repos",
    repoDir: (root: string, repo: string) => `${root}/${repo}`,
    gateConfig: (_repo: string) => ({ timeoutMs: 123_000, env: { UNIT_GATE_XDIST: "2" } }),
    now: () => 10_000,
    attribute: async ({ red }: { red: MainHealthMeasurement }) => attribution(red),
    incidents: noopIncidents(),
    notifier: { opened: async (_incident: Incident) => undefined, closed: async (_incident: Incident) => undefined },
    commentPullRequest: async (_input: unknown) => undefined,
    logError: (_error: unknown) => undefined,
  };
}

test("tick encola sólo SHA nuevo; caché y error reciente lo suprimen", async () => {
  const store = memoryStore();
  store.measurements.set(`medido@${SHA_B}`, measurement("medido", SHA_B));
  store.errors.set(`roto@${SHA_C}`, { sha: SHA_C, reason: "entorno", at: 9_500, log_tail: "x" });
  const calls: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }> = [];
  const deps = baseDeps(["nuevo", "medido", "roto"], store);
  deps.git.lsRemoteMain = async (repoDir) => repoDir.endsWith("/nuevo") ? SHA_A : repoDir.endsWith("/medido") ? SHA_B : SHA_C;
  deps.measure = async (input: typeof calls[number]) => {
    calls.push(input);
    store.measurements.set(`nuevo@${SHA_A}`, measurement("nuevo", SHA_A));
  };
  const watcher = createMainHealthWatcher(deps);

  await watcher.tick();
  await watcher.idle();

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /scripts\/main-health\.sh$/);
  assert.deepEqual(calls[0]!.args, ["nuevo", "--sha", SHA_A]);
  assert.equal(calls[0]!.cwd, "/repos");
  assert.deepEqual(calls[0]!.env, { MAIN_HEALTH_REPO_ROOT: "/repos", UNIT_GATE_XDIST: "2" });
  assert.equal(calls[0]!.timeoutMs, 123_000);
});

test("ensureMeasured retorna estado claro, resuelve main y no mide repos fuera de settings", async () => {
  const store = memoryStore();
  store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A));
  store.errors.set(`repo@${SHA_B}`, { sha: SHA_B, reason: "infra", at: 9_999, log_tail: "x" });
  const deps = baseDeps(["repo"], store);
  let gitCalls = 0;
  deps.git.lsRemoteMain = async () => { gitCalls += 1; return SHA_A; };
  const watcher = createMainHealthWatcher(deps);

  assert.deepEqual(await watcher.ensureMeasured("repo"), {
    status: "cached",
    measurement: measurement("repo", SHA_A),
  });
  assert.deepEqual(await watcher.ensureMeasured("repo", SHA_B), {
    status: "suppressed",
    reason: "recent-error",
    repo: "repo",
    sha: SHA_B,
  });
  assert.deepEqual(await watcher.ensureMeasured("ajeno", SHA_C), {
    status: "ignored",
    reason: "repo-not-configured",
    repo: "ajeno",
  });
  assert.equal(gitCalls, 1);
});

test("la ventana del error reciente usa el reloj inyectado y el error leído del store", async () => {
  const store = memoryStore(10_000);
  store.errors.set(`repo@${SHA_A}`, { sha: SHA_A, reason: "infra", at: 9_500, log_tail: "x" });
  const deps = baseDeps(["repo"], store);
  deps.now = () => 9_500 + 60 * 60_000;
  const watcher = createMainHealthWatcher(deps);

  assert.deepEqual(await watcher.ensureMeasured("repo", SHA_A), {
    status: "queued",
    repo: "repo",
    sha: SHA_A,
  });
  await watcher.idle();
});

test("cola global es serie, deduplica repo+sha y continúa tras error de medición", async () => {
  const store = memoryStore();
  const deps = baseDeps(["alpha", "beta"], store);
  let active = 0;
  let maxActive = 0;
  let alphaCalls = 0;
  let releaseAlpha!: () => void;
  const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });
  deps.measure = async ({ args }: { args: string[] }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (args[0] === "alpha") {
        alphaCalls += 1;
        await alphaGate;
        throw new Error("medición rota");
      }
      store.measurements.set(`beta@${SHA_B}`, measurement("beta", SHA_B));
    } finally {
      active -= 1;
    }
  };
  const watcher = createMainHealthWatcher(deps);

  assert.equal((await watcher.ensureMeasured("alpha", SHA_A)).status, "queued");
  assert.deepEqual(await watcher.ensureMeasured("alpha", SHA_A), {
    status: "queued", repo: "alpha", sha: SHA_A, deduplicated: true,
  });
  assert.equal((await watcher.ensureMeasured("beta", SHA_B)).status, "queued");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releaseAlpha();
  await watcher.idle();

  assert.equal(alphaCalls, 1);
  assert.equal(maxActive, 1);
  assert.ok(store.measurements.has(`beta@${SHA_B}`), "el trabajo siguiente sí terminó");
});

test("evaluate abre una vez, delega fixer, respeta commentOnPr=false y luego cierra", async () => {
  const store = memoryStore();
  const deps = baseDeps(["repo"], store);
  let current: Incident | null = null;
  let opens = 0;
  let closes = 0;
  let fixer = 0;
  let comments = 0;
  const notifications: string[] = [];
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      opens += 1;
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    ensureFixer: async () => { fixer += 1; return { status: "adopted" as const, session: "cowork-main-health-repo" }; },
    closeIncident: async () => {
      closes += 1;
      if (!current) return null;
      const closed = { ...current, closedAt: 2 };
      current = null;
      return closed;
    },
  };
  deps.notifier = {
    opened: async (value) => { notifications.push(`open:${value.id}`); },
    closed: async (value) => { notifications.push(`close:${value.id}`); },
  };
  deps.commentPullRequest = async () => { comments += 1; };
  const watcher = createMainHealthWatcher(deps);
  const red = measurement("repo", SHA_A, "red");

  await watcher.evaluate("repo", red);
  await watcher.evaluate("repo", red);
  await watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  await watcher.evaluate("repo", measurement("repo", SHA_C, "green"));

  assert.equal(opens, 1);
  assert.equal(fixer, 1, "adoptar/lanzar queda delegado al manager");
  assert.equal(comments, 0);
  assert.equal(closes, 1);
  assert.deepEqual(notifications, [`open:repo@${SHA_A.slice(0, 7)}`, `close:repo@${SHA_A.slice(0, 7)}`]);
});

test("fallos de notify, comentario y fixer no rompen evaluación ni la cola", async () => {
  const store = memoryStore();
  const deps = baseDeps(["alpha", "beta"], store);
  deps.readSettings = () => baseSettings(["alpha", "beta"], { commentOnPr: true });
  const incidents = new Map<string, Incident>();
  const opened: string[] = [];
  deps.incidents = {
    readIncident: (repo) => incidents.get(repo) ?? null,
    openIncident: (input) => {
      const value: Incident = { id: `${input.repo}@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      incidents.set(input.repo, value);
      opened.push(input.repo);
      return value;
    },
    ensureFixer: async () => { throw new Error("fixer caído"); },
    closeIncident: async () => null,
  };
  deps.notifier.opened = async () => { throw new Error("telegram caído"); };
  deps.commentPullRequest = async () => { throw new Error("gh caído"); };
  deps.measure = async ({ args }: { args: string[] }) => {
    const repo = args[0]!;
    const sha = args[2]!;
    store.measurements.set(`${repo}@${sha}`, measurement(repo, sha, "red"));
  };
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("alpha", SHA_A);
  await watcher.ensureMeasured("beta", SHA_B);
  await watcher.idle();

  assert.deepEqual(opened, ["alpha", "beta"]);
});

test("start con enabled=false no hace tick ni instala interval; ticks activos no se solapan", async () => {
  const disabled = baseDeps(["repo"]);
  disabled.readSettings = () => baseSettings(["repo"], { enabled: false });
  let intervals = 0;
  let gitCalls = 0;
  disabled.git.lsRemoteMain = async () => { gitCalls += 1; return SHA_A; };
  disabled.timers = {
    setInterval: (_callback: () => void, _ms: number) => { intervals += 1; return 1; },
    clearInterval: (_handle: unknown) => undefined,
  };
  const off = createMainHealthWatcher(disabled);
  off.start();
  assert.equal(intervals, 0);
  assert.equal(gitCalls, 0);

  const enabled = baseDeps(["repo"]);
  let callback!: () => void;
  let active = 0;
  let maxActive = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  enabled.git.lsRemoteMain = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return SHA_A;
  };
  enabled.timers = {
    setInterval: (fn: () => void, ms: number) => { callback = fn; assert.equal(ms, 600_000); return 2; },
    clearInterval: (_handle: unknown) => undefined,
  };
  const on = createMainHealthWatcher(enabled);
  on.start();
  callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  release();
  await on.idle();
  assert.equal(maxActive, 1);
  on.stop();
});
