import assert from "node:assert/strict";
import test from "node:test";
import type { Incident, OpenIncidentInput } from "./incident.js";
import type { MainHealthAttribution } from "./attribution.js";
import type { MainHealthError, MainHealthMeasurement } from "./store.js";
import { createMainHealthWatcher } from "./watcher.js";
import * as watcherModule from "./watcher.js";

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
  const operational = new Map<string, string>();
  const key = (repo: string, sha: string) => `${repo}@${sha}`;
  return {
    measurements,
    errors,
    operational,
    readMeasurement: (repo: string, sha: string) => measurements.get(key(repo, sha)) ?? null,
    readError: (repo: string, sha: string) => errors.get(key(repo, sha)) ?? null,
    hasRecentError(repo: string, sha: string) {
      const value = errors.get(key(repo, sha));
      return value !== undefined && now - value.at >= 0 && now - value.at < 60 * 60_000;
    },
    listMeasurements: (repo: string) => [...measurements.values()].filter((item) => item.repo === repo),
    confirmOperationalMeasurement: (repo: string, sha: string) => { operational.set(repo, sha); },
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
    heartbeatOwner: async (_repo: string) => false,
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
  await watcher.idle();
  assert.equal(gitCalls, 2, "main se resuelve y se revalida antes de publicar");
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

test("ensureMeasured respeta disabled/veto app y rechaza SHA no canónico", async () => {
  let gitCalls = 0;
  let measures = 0;
  const disabled = baseDeps(["repo"]);
  disabled.readSettings = () => baseSettings(["repo"], { enabled: false });
  disabled.git.lsRemoteMain = async () => { gitCalls += 1; return SHA_A; };
  disabled.measure = async () => { measures += 1; };
  assert.deepEqual(await createMainHealthWatcher(disabled).ensureMeasured("repo"), {
    status: "ignored", reason: "disabled", repo: "repo",
  });

  const deps = baseDeps(["repo", "ant-liebre-app"]);
  deps.git.lsRemoteMain = async () => { gitCalls += 1; return SHA_A.toUpperCase(); };
  deps.measure = async () => { measures += 1; };
  const watcher = createMainHealthWatcher(deps);
  assert.deepEqual(await watcher.ensureMeasured("ant-liebre-app", SHA_A), {
    status: "ignored", reason: "repo-vetoed", repo: "ant-liebre-app",
  });
  for (const sha of [SHA_A.slice(0, 7), SHA_A.toUpperCase()]) {
    assert.deepEqual(await watcher.ensureMeasured("repo", sha), {
      status: "unavailable", reason: "invalid-sha", repo: "repo",
    });
  }
  assert.deepEqual(await watcher.ensureMeasured("repo"), {
    status: "unavailable", reason: "invalid-sha", repo: "repo",
  });
  assert.equal(gitCalls, 1, "disabled y veto no consultan Git");
  assert.equal(measures, 0);
});

test("evaluate veta entradas deshabilitadas, inseguras, app, repo cruzado y SHA no canónico", async () => {
  const deps = baseDeps(["repo", "a..b", "ant-liebre-app"]);
  let paths = 0;
  let attributions = 0;
  deps.repoDir = (root, repo) => { paths += 1; return `${root}/${repo}`; };
  deps.attribute = async ({ red }) => { attributions += 1; return attribution(red); };
  const watcher = createMainHealthWatcher(deps);

  const disabled = baseDeps(["repo"]);
  disabled.readSettings = () => baseSettings(["repo"], { enabled: false });
  await createMainHealthWatcher(disabled).evaluate("repo", measurement("repo", SHA_A, "red"));
  await watcher.evaluate("a..b", measurement("a..b", SHA_A, "red"));
  await watcher.evaluate("ant-liebre-app", measurement("ant-liebre-app", SHA_A, "red"));
  await watcher.evaluate("repo", measurement("otro", SHA_A, "red"));
  await watcher.evaluate("repo", measurement("repo", SHA_A.slice(0, 7), "red"));
  await watcher.evaluate("repo", measurement("repo", SHA_A.toUpperCase(), "red"));
  await watcher.evaluate("repo", measurement("repo", SHA_B, "red"));

  assert.equal(paths, 1, "sólo el SHA canónico consulta origin/main antes de descartarse");
  assert.equal(attributions, 0);
});

test("cola expone una barrera inyectable justo antes de retirar el dedupe", async () => {
  const store = memoryStore();
  store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A, "green"));
  const deps = baseDeps(["repo"], store);
  let finalizations = 0;
  Object.assign(deps, {
    beforeJobFinalize: async (repo: string, sha: string) => {
      assert.equal(repo, "repo");
      assert.equal(sha, SHA_A);
      finalizations += 1;
    },
  });
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("repo", SHA_A);
  await watcher.idle();

  assert.equal(finalizations, 1);
});

test("promoción terminal reencola main antes de retirar el dedupe baseline", async () => {
  const store = memoryStore();
  store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A, "red"));
  const deps = baseDeps(["repo"], store);
  let reportTerminal!: () => void;
  let releaseTerminal!: () => void;
  const terminal = new Promise<void>((resolve) => { reportTerminal = resolve; });
  const gate = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  let finalizations = 0;
  let opens = 0;
  Object.assign(deps, {
    beforeJobFinalize: async () => {
      finalizations += 1;
      if (finalizations !== 1) return;
      reportTerminal();
      await gate;
    },
  });
  deps.incidents = {
    ...noopIncidents(),
    openIncident: (input) => {
      opens += 1;
      return { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
    },
  };
  const watcher = createMainHealthWatcher(deps);

  assert.equal((await watcher.ensureMeasured("repo", SHA_A)).status, "cached");
  await terminal;
  assert.deepEqual(await watcher.ensureMeasured("repo"), {
    status: "cached",
    measurement: measurement("repo", SHA_A, "red"),
  });
  releaseTerminal();
  await watcher.idle();

  assert.equal(finalizations, 2, "la promoción terminal crea reconciliación operacional nueva");
  assert.equal(store.operational.get("repo"), SHA_A);
  assert.equal(opens, 1);
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

test("timeout termina el grupo TERM→gracia→KILL y la cola espera close antes del siguiente job", async () => {
  type Listener = (error?: Error) => void;
  const children: Array<{
    pid: number;
    listeners: { error?: Listener; close?: Listener };
    once(event: "error" | "close", listener: Listener): void;
    kill(signal: string): boolean;
    close(): void;
  }> = [];
  const spawnOptions: Array<{ detached?: boolean }> = [];
  const timers: Array<{ callback: () => void; ms: number; active: boolean }> = [];
  const kills: string[] = [];
  const factory = (watcherModule as Record<string, unknown>).createMainHealthMeasurementRunner;
  assert.equal(typeof factory, "function", "debe exponer runner con spawn/timers inyectables");
  const measure = (factory as (deps: unknown) => (input: unknown) => Promise<void>)({
    platform: "darwin",
    graceMs: 50,
    spawnProcess: (_command: string, _args: string[], options: { detached?: boolean }) => {
      spawnOptions.push(options);
      const child = {
        pid: 100 + children.length,
        listeners: {} as { error?: Listener; close?: Listener },
        once(event: "error" | "close", listener: Listener) { this.listeners[event] = listener; },
        kill: (_signal: string) => true,
        close() { this.listeners.close?.(); },
      };
      children.push(child);
      return child;
    },
    killProcessGroup: (child: { pid: number }, signal: string) => { kills.push(`${child.pid}:${signal}`); },
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const timer = { callback, ms, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { active: boolean }) => { timer.active = false; },
    },
  });
  const deps = baseDeps(["alpha", "beta"]);
  deps.measure = measure;
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("alpha", SHA_A);
  await watcher.ensureMeasured("beta", SHA_B);
  assert.equal(children.length, 1);
  assert.equal(spawnOptions[0]!.detached, true);
  assert.equal(timers[0]!.ms, 123_000);

  timers[0]!.callback();
  assert.deepEqual(kills, ["100:SIGTERM"]);
  assert.equal(children.length, 1, "TERM no libera la cola antes de close");
  assert.equal(timers[1]!.ms, 50);
  timers[1]!.callback();
  assert.deepEqual(kills, ["100:SIGTERM", "100:SIGKILL"]);
  assert.equal(children.length, 1, "KILL tampoco libera hasta close");

  children[0]!.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2, "el siguiente job empieza sólo tras close");
  children[1]!.close();
  await watcher.idle();
});

test("abort de medición hace TERM→gracia→KILL y espera close antes de rechazar", async () => {
  type Listener = (error?: Error) => void;
  const listeners: { error?: Listener; close?: Listener } = {};
  const removed: string[] = [];
  const timers: Array<{ callback: () => void; ms: number; active: boolean }> = [];
  const kills: string[] = [];
  const factory = (watcherModule as Record<string, unknown>).createMainHealthMeasurementRunner as (deps: unknown) => (input: unknown) => Promise<void>;
  const measure = factory({
    graceMs: 25,
    spawnProcess: () => ({
      pid: 321,
      once: (event: "error" | "close", listener: Listener) => { listeners[event] = listener; },
      removeListener: (event: "error" | "close") => { removed.push(event); },
      kill: () => true,
    }),
    killProcessGroup: (_child: unknown, signal: string) => { kills.push(signal); },
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const timer = { callback, ms, active: true };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer: { active: boolean }) => { timer.active = false; },
    },
  });
  const controller = new AbortController();
  const running = measure({
    command: "measure",
    args: [],
    cwd: "/repo",
    env: {},
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });

  controller.abort();
  assert.deepEqual(kills, ["SIGTERM"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "TERM no termina la promesa antes de close");
  assert.equal(timers[1]!.ms, 25);
  timers[1]!.callback();
  assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(settled, false, "KILL tampoco termina la promesa antes de close");

  listeners.close?.();
  await assert.rejects(running, (error: any) => error?.name === "AbortError");
  assert.equal(timers.every(({ active }) => !active), true);
  assert.ok(removed.includes("error"));
});

test("stop aborta la medición activa, espera su close y descarta la cola", async () => {
  const store = memoryStore();
  const deps = baseDeps(["alpha", "beta"], store);
  const intervals: unknown[] = [];
  Object.assign(deps, {
    timers: {
      setInterval: (callback: () => void) => { intervals.push(callback); return callback; },
      clearInterval: () => undefined,
    },
  });
  const runs: string[] = [];
  let activeSignal: AbortSignal | undefined;
  let finishActive!: () => void;
  deps.measure = ({ args, signal }: { args: string[]; signal?: AbortSignal }) => {
    runs.push(args[0]!);
    activeSignal = signal;
    return new Promise<void>((resolve) => { finishActive = resolve; });
  };
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("alpha", SHA_A);
  await watcher.ensureMeasured("beta", SHA_B);
  const stopping = watcher.stop();
  let stopped = false;
  void Promise.resolve(stopping).then(() => { stopped = true; });
  assert.equal(activeSignal?.aborted, true);
  assert.deepEqual(await watcher.ensureMeasured("beta", SHA_C), {
    status: "ignored", reason: "stopping", repo: "beta",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop espera que el proceso emita close/termine");
  assert.deepEqual(runs, ["alpha"], "el job en cola nunca arranca");

  finishActive();
  await stopping;
  assert.equal(stopped, true);
  assert.deepEqual(runs, ["alpha"]);

  deps.git.lsRemoteMain = async () => null;
  deps.measure = async ({ args }: { args: string[] }) => { runs.push(args[0]!); };
  watcher.start();
  await watcher.ensureMeasured("beta", SHA_B);
  await watcher.idle();
  assert.deepEqual(runs, ["alpha", "beta"], "restart crea una generación limpia");
  await watcher.stop();
});

test("stop espera evaluate/attribution en vuelo y la cerca antes de abrir o lanzar auxiliares", async () => {
  const deps = baseDeps(["repo"]);
  let attributionStarted!: () => void;
  let releaseAttribution!: () => void;
  const started = new Promise<void>((resolve) => { attributionStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseAttribution = resolve; });
  let opens = 0;
  let fixer = 0;
  let comments = 0;
  deps.readSettings = () => baseSettings(["repo"], { commentOnPr: true });
  deps.attribute = async ({ red }) => {
    attributionStarted();
    await gate;
    return attribution(red);
  };
  deps.incidents = {
    ...noopIncidents(),
    openIncident: (input) => {
      opens += 1;
      return { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
    },
    ensureFixer: async () => { fixer += 1; },
  };
  deps.commentPullRequest = async () => { comments += 1; };
  const watcher = createMainHealthWatcher(deps);

  const evaluating = watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  await started;
  const stopping = watcher.stop();
  let stopped = false;
  void Promise.resolve(stopping).then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseAttribution();
  await Promise.all([evaluating, stopping]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(opens, 0);
  assert.equal(fixer, 0);
  assert.equal(comments, 0);
});

test("stop espera Git en vuelo y el SHA tardío no encola una medición", async () => {
  const deps = baseDeps(["repo"]);
  let gitStarted!: () => void;
  let releaseGit!: () => void;
  const started = new Promise<void>((resolve) => { gitStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseGit = resolve; });
  let measures = 0;
  deps.git.lsRemoteMain = async () => {
    gitStarted();
    await gate;
    return SHA_A;
  };
  deps.measure = async () => { measures += 1; };
  const watcher = createMainHealthWatcher(deps);

  const tick = watcher.tick();
  await started;
  const stopping = watcher.stop();
  await watcher.tick();
  releaseGit();
  await Promise.all([tick, stopping]);

  assert.equal(measures, 0);
});

test("stop espera close en vuelo y no encola su notificación después de la barrera", async () => {
  const deps = baseDeps(["repo"]);
  const current: Incident = {
    id: `repo@${SHA_A.slice(0, 7)}`,
    repo: "repo",
    firstRedSha: SHA_A,
    openedAt: 1,
    summary: "rojo",
    attribution: attribution(measurement("repo", SHA_A, "red")),
  };
  let closeStarted!: () => void;
  let releaseClose!: () => void;
  const started = new Promise<void>((resolve) => { closeStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseClose = resolve; });
  let notifications = 0;
  deps.incidents = {
    ...noopIncidents(),
    readIncident: () => current,
    closeIncident: async () => {
      closeStarted();
      await gate;
      return { ...current, closedAt: 2 };
    },
  };
  deps.notifier.closed = async () => { notifications += 1; };
  deps.git.lsRemoteMain = async () => SHA_B;
  const watcher = createMainHealthWatcher(deps);

  const evaluating = watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  await started;
  const stopping = watcher.stop();
  releaseClose();
  await Promise.all([evaluating, stopping]);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(notifications, 0);
});

test("stop aborta el signal del comentario auxiliar activo", async () => {
  const deps = baseDeps(["repo"]);
  deps.readSettings = () => baseSettings(["repo"], { commentOnPr: true });
  Object.assign(deps, {
    scheduleAuxiliaryStart: (callback: () => void) => callback(),
    scheduleAuxiliaryDeadline: () => () => undefined,
  });
  let current: Incident | null = null;
  let commentSignal: AbortSignal | undefined;
  deps.incidents = {
    ...noopIncidents(),
    readIncident: () => current,
    openIncident: (input) => {
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
  };
  deps.commentPullRequest = async (input: any) => {
    commentSignal = input.signal;
    await new Promise<void>((_resolve, reject) => input.signal.addEventListener(
      "abort",
      () => reject(new DOMException("cancelado", "AbortError")),
      { once: true },
    ));
  };
  const watcher = createMainHealthWatcher(deps);

  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  assert.equal(commentSignal?.aborted, false);
  await watcher.stop();
  assert.equal(commentSignal?.aborted, true);
});

test("cache hit de main se reconcilia en la cola sin medir y recupera apertura/cierre", async () => {
  const store = memoryStore();
  store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A, "red"));
  store.measurements.set(`repo@${SHA_B}`, measurement("repo", SHA_B, "green"));
  const deps = baseDeps(["repo"], store);
  let current: Incident | null = null;
  let measures = 0;
  let opens = 0;
  let closes = 0;
  const notified: string[] = [];
  deps.measure = async () => { measures += 1; };
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      opens += 1;
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => ({ status: "disabled" as const, session: null }),
    closeIncident: async () => {
      closes += 1;
      const closed = current ? { ...current, closedAt: 2 } : null;
      current = null;
      return closed;
    },
  };
  let remote = SHA_A;
  deps.git.lsRemoteMain = async () => remote;
  deps.notifier = {
    opened: async () => { notified.push("open"); },
    closed: async () => { notified.push("close"); },
  };
  const watcher = createMainHealthWatcher(deps);

  assert.equal((await watcher.ensureMeasured("repo")).status, "cached");
  await watcher.idle();
  assert.equal(opens, 1);
  assert.equal(current?.firstRedSha, SHA_A);
  remote = SHA_B;
  assert.equal((await watcher.ensureMeasured("repo")).status, "cached");
  await watcher.idle();

  assert.equal(measures, 0);
  assert.equal(closes, 1);
  assert.deepEqual(notified, ["open", "close"]);
});

test("baseline histórico rojo no abre y verde no cierra el incidente operacional", async () => {
  const store = memoryStore();
  store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A, "red"));
  store.measurements.set(`repo@${SHA_B}`, measurement("repo", SHA_B, "green"));
  const deps = baseDeps(["repo"], store);
  let current: Incident | null = null;
  let opens = 0;
  let closes = 0;
  let fixers = 0;
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      opens += 1;
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => { fixers += 1; return { status: "disabled" as const, session: null }; },
    closeIncident: async () => { closes += 1; current = null; return null; },
  };
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("repo", SHA_A);
  await watcher.idle();
  assert.equal(opens, 0, "un rojo baseline no abre incidente");
  assert.equal(fixers, 0, "un rojo baseline no lanza fixer");

  current = {
    id: `repo@${SHA_C.slice(0, 7)}`,
    repo: "repo",
    firstRedSha: SHA_C,
    openedAt: 1,
    summary: "main rojo",
    attribution: attribution(measurement("repo", SHA_C, "red")),
  };
  await watcher.ensureMeasured("repo", SHA_B);
  await watcher.idle();
  assert.equal(closes, 0, "un verde baseline no cierra main rojo actual");
  assert.equal(current?.firstRedSha, SHA_C);
  assert.equal(store.operational.size, 0, "baseline nunca publica el puntero operacional");
});

test("main promueve un baseline en vuelo del mismo SHA y lo evalúa una sola vez", async () => {
  const store = memoryStore();
  const deps = baseDeps(["repo"], store);
  let release!: () => void;
  let started!: () => void;
  const measuring = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let gitCalls = 0;
  let opens = 0;
  deps.git.lsRemoteMain = async () => { gitCalls += 1; return SHA_A; };
  deps.measure = async () => {
    started();
    await gate;
    store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A, "red"));
  };
  deps.incidents = {
    ...noopIncidents(),
    openIncident: (input) => {
      opens += 1;
      return { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
    },
  };
  const watcher = createMainHealthWatcher(deps);

  assert.equal((await watcher.ensureMeasured("repo", SHA_A)).status, "queued");
  await measuring;
  assert.deepEqual(await watcher.ensureMeasured("repo"), {
    status: "queued", repo: "repo", sha: SHA_A, deduplicated: true,
  });
  release();
  await watcher.idle();

  assert.equal(gitCalls, 2, "resuelve main y lo revalida antes de publicar");
  assert.equal(store.operational.get("repo"), SHA_A);
  assert.equal(opens, 1);
});

test("job operacional no publica ni evalúa si origin/main avanzó durante la medición", async () => {
  const store = memoryStore();
  const deps = baseDeps(["repo"], store);
  let remote = SHA_A;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let opens = 0;
  deps.git.lsRemoteMain = async () => remote;
  deps.measure = async () => {
    await gate;
    store.measurements.set(`repo@${SHA_A}`, measurement("repo", SHA_A, "red"));
  };
  deps.incidents = {
    ...noopIncidents(),
    openIncident: (input) => { opens += 1; return { id: "inesperado", openedAt: 1, ...input }; },
  };
  const watcher = createMainHealthWatcher(deps);

  assert.equal((await watcher.ensureMeasured("repo")).status, "queued");
  remote = SHA_B;
  release();
  await watcher.idle();

  assert.equal(store.operational.size, 0);
  assert.equal(opens, 0);
  assert.ok(store.measurements.has(`repo@${SHA_A}`), "la medición baseline queda disponible para gate");
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
    heartbeatOwner: async () => false,
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
  let remoteMain = SHA_A;
  deps.git.lsRemoteMain = async () => remoteMain;
  const watcher = createMainHealthWatcher(deps);
  const red = measurement("repo", SHA_A, "red");

  await watcher.evaluate("repo", red);
  await watcher.evaluate("repo", red);
  remoteMain = SHA_B;
  await watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  remoteMain = SHA_C;
  await watcher.evaluate("repo", measurement("repo", SHA_C, "green"));

  assert.equal(opens, 1);
  assert.equal(fixer, 2, "cada rojo reconciliado reintenta adoptar/lanzar vía manager");
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
    heartbeatOwner: async () => false,
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
  deps.git.lsRemoteMain = async (repoDir) => repoDir.endsWith("/alpha") ? SHA_A : SHA_B;
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("alpha");
  await watcher.ensureMeasured("beta");
  await watcher.idle();

  assert.deepEqual(opened, ["alpha", "beta"]);
});

test("auxiliares colgados no bloquean core ni idle y se deduplican mientras siguen pendientes", async () => {
  const store = memoryStore();
  const deps = baseDeps(["alpha", "beta"], store);
  deps.readSettings = () => baseSettings(["alpha", "beta"], { commentOnPr: true });
  const betaIncident: Incident = {
    id: `beta@${SHA_B.slice(0, 7)}`,
    repo: "beta",
    firstRedSha: SHA_B,
    openedAt: 1,
    summary: "rojo",
    attribution: attribution(measurement("beta", SHA_B, "red")),
  };
  const incidents = new Map<string, Incident>([["beta", betaIncident]]);
  let closes = 0;
  let notifyCalls = 0;
  let commentCalls = 0;
  let fixerCalls = 0;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const never = new Promise<never>(() => undefined);
  deps.incidents = {
    readIncident: (repo) => incidents.get(repo) ?? null,
    openIncident: (input) => {
      const value: Incident = { id: `${input.repo}@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      incidents.set(input.repo, value);
      return value;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => { fixerCalls += 1; return never; },
    closeIncident: async (repo) => {
      closes += 1;
      const value = incidents.get(repo) ?? null;
      incidents.delete(repo);
      return value;
    },
  };
  deps.notifier = {
    opened: async () => { notifyCalls += 1; notifyStarted(); return never; },
    closed: async () => never,
  };
  deps.commentPullRequest = async () => { commentCalls += 1; return never; };
  deps.measure = async ({ args }: { args: string[] }) => {
    const repo = args[0]!;
    const sha = args[2]!;
    store.measurements.set(`${repo}@${sha}`, measurement(repo, sha, repo === "alpha" ? "red" : "green"));
  };
  deps.git.lsRemoteMain = async (repoDir) => repoDir.endsWith("/alpha") ? SHA_A : SHA_B;
  const watcher = createMainHealthWatcher(deps);

  await watcher.ensureMeasured("alpha");
  await watcher.ensureMeasured("beta");
  const idle = watcher.idle();
  await started;
  let idleDone = false;
  void idle.then(() => { idleDone = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(idleDone, true, "idle no incluye auxiliares");
  assert.equal(closes, 1, "el close core siguiente sí se ejecutó");
  assert.equal(notifyCalls, 1);
  assert.equal(commentCalls, 1);
  assert.equal(fixerCalls, 1);
  await watcher.evaluate("alpha", measurement("alpha", SHA_A, "red"));
  assert.equal(fixerCalls, 1, "un auxiliar pendiente no se duplica");
});

test("timer heartbeat autorizado no se solapa y auxiliares fallidos se reintentan", async () => {
  const store = memoryStore();
  store.measurements.set(`alpha@${SHA_A}`, measurement("alpha", SHA_A, "red"));
  store.measurements.set(`beta@${SHA_B}`, measurement("beta", SHA_B, "green"));
  const deps = baseDeps(["alpha", "beta", "ant-liebre-app"], store);
  deps.git.lsRemoteMain = async (repoDir) => repoDir.endsWith("/alpha") ? SHA_A : repoDir.endsWith("/beta") ? SHA_B : SHA_C;
  const current: Incident = {
    id: `alpha@${SHA_A.slice(0, 7)}`,
    repo: "alpha",
    firstRedSha: SHA_A,
    openedAt: 1,
    summary: "rojo",
    attribution: attribution(measurement("alpha", SHA_A, "red")),
  };
  const heartbeats: string[] = [];
  let fixerCalls = 0;
  let releaseHeartbeat!: () => void;
  const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  deps.readSettings = () => baseSettings(["alpha", "beta", "ant-liebre-app"], { intervalMin: 60 });
  deps.git.lsRemoteMain = async () => null;
  deps.timers = {
    setInterval: (callback: () => void, ms: number) => {
      const timer = { callback, ms };
      intervals.push(timer);
      return timer;
    },
    clearInterval: () => undefined,
  };
  deps.incidents = {
    readIncident: (repo) => repo === "alpha" ? current : null,
    openIncident: () => { throw new Error("no debe abrir"); },
    heartbeatOwner: async (repo: string) => {
      heartbeats.push(repo);
      if (repo === "alpha") return heartbeatGate.then(() => true);
      throw new Error("heartbeat roto");
    },
    ensureFixer: async () => { fixerCalls += 1; throw new Error("fixer roto"); },
    closeIncident: async () => null,
  };
  const watcher = createMainHealthWatcher(deps);

  watcher.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(heartbeats, ["alpha", "beta"]);

  intervals.find(({ ms }) => ms === 900_000)!.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(heartbeats, ["alpha", "beta", "beta"], "alpha pendiente no solapa; beta fallido reintenta");

  deps.git.lsRemoteMain = async () => SHA_A;
  await watcher.evaluate("alpha", measurement("alpha", SHA_A, "red"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  await watcher.evaluate("alpha", measurement("alpha", SHA_A, "red"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixerCalls, 2, "fixer fallido libera su clave para retry");
  const stopping = watcher.stop();
  releaseHeartbeat();
  await stopping;
});

test("evaluate serializa dos cierres concurrentes y sólo uno ejecuta close", async () => {
  const deps = baseDeps(["repo"]);
  let current: Incident | null = {
    id: `repo@${SHA_A.slice(0, 7)}`,
    repo: "repo",
    firstRedSha: SHA_A,
    openedAt: 1,
    summary: "rojo",
    attribution: attribution(measurement("repo", SHA_A, "red")),
  };
  let closeCalls = 0;
  let closeStarted!: () => void;
  let releaseClose!: () => void;
  const started = new Promise<void>((resolve) => { closeStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseClose = resolve; });
  deps.incidents = {
    readIncident: () => current,
    openIncident: () => { throw new Error("no debe abrir"); },
    heartbeatOwner: async () => false,
    ensureFixer: async () => ({ status: "disabled" as const, session: null }),
    closeIncident: async () => {
      closeCalls += 1;
      closeStarted();
      await gate;
      const value = current;
      current = null;
      return value;
    },
  };
  deps.git.lsRemoteMain = async () => SHA_B;
  const watcher = createMainHealthWatcher(deps);
  const green = measurement("repo", SHA_B, "green");

  const first = watcher.evaluate("repo", green);
  const second = watcher.evaluate("repo", green);
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  releaseClose();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1);
});

test("notify close espera a que notify open del mismo repo termine sin bloquear core", async () => {
  const deps = baseDeps(["repo"]);
  let current: Incident | null = null;
  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
  const events: string[] = [];
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => ({ status: "disabled" as const, session: null }),
    closeIncident: async () => {
      const closed = current;
      current = null;
      return closed;
    },
  };
  deps.notifier = {
    opened: async () => { events.push("open:start"); await openGate; events.push("open:end"); },
    closed: async () => { events.push("close"); },
  };
  let remoteMain = SHA_A;
  deps.git.lsRemoteMain = async () => remoteMain;
  const watcher = createMainHealthWatcher(deps);

  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  remoteMain = SHA_B;
  await watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  assert.deepEqual(events, ["open:start"], "close core terminó, pero su aviso conserva orden causal");
  releaseOpen();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["open:start", "open:end", "close"]);
});

test("deadline aborta notify open antes de iniciar notify close y evita entrega tardía", async () => {
  const deps = baseDeps(["repo"]);
  const deadlines: Array<{ callback: () => void; cancelled: boolean }> = [];
  Object.assign(deps, {
    auxiliaryLeaseMs: 500,
    scheduleAuxiliaryDeadline: (callback: () => void, ms: number) => {
      assert.equal(ms, 500);
      const deadline = { callback, cancelled: false };
      deadlines.push(deadline);
      return () => { deadline.cancelled = true; };
    },
  });
  let current: Incident | null = null;
  let finishOpen!: () => void;
  const events: string[] = [];
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => ({ status: "disabled" as const }),
    closeIncident: async () => {
      const closed = current;
      current = null;
      return closed;
    },
  };
  deps.notifier = {
    opened: async (_incident, signal) => new Promise<void>((resolve, reject) => {
      events.push("open:start");
      finishOpen = () => {
        if (!signal?.aborted) events.push("open:sent");
        resolve();
      };
      signal?.addEventListener("abort", () => {
        events.push("open:abort");
        reject(new DOMException("cancelado", "AbortError"));
      }, { once: true });
    }),
    closed: async () => { events.push("close:start"); },
  };
  let remoteMain = SHA_A;
  deps.git.lsRemoteMain = async () => remoteMain;
  const watcher = createMainHealthWatcher(deps);

  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  remoteMain = SHA_B;
  await watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  assert.deepEqual(events, ["open:start"]);
  deadlines[0]!.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["open:start", "open:abort", "close:start"]);

  finishOpen();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["open:start", "open:abort", "close:start"], "el envío abortado no entrega tarde");
});

test("heartbeat usa cadencia menor al lease e independiente de la medición", async () => {
  const deps = baseDeps(["repo"]);
  deps.readSettings = () => baseSettings(["repo"], { intervalMin: 60, leaseMin: 30 });
  const installed: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
  deps.timers = {
    setInterval: (callback: () => void, ms: number) => {
      const timer = { callback, ms, cleared: false };
      installed.push(timer);
      return timer;
    },
    clearInterval: (timer: { cleared: boolean }) => { timer.cleared = true; },
  };
  let gitCalls = 0;
  let heartbeats = 0;
  deps.git.lsRemoteMain = async () => { gitCalls += 1; return SHA_A; };
  deps.incidents.heartbeatOwner = async () => { heartbeats += 1; return true; };
  const watcher = createMainHealthWatcher(deps);

  watcher.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(installed.map(({ ms }) => ms).sort((a, b) => a - b), [900_000, 3_600_000]);
  const heartbeatTimer = installed.find(({ ms }) => ms === 900_000)!;
  const gitBeforeHeartbeat = gitCalls;
  const heartbeatBeforeTimer = heartbeats;
  heartbeatTimer.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(heartbeats, heartbeatBeforeTimer + 1, "renueva antes del lease sin esperar medición");
  assert.equal(gitCalls, gitBeforeHeartbeat, "el timer de heartbeat no descubre main");

  await watcher.stop();
  await watcher.stop();
  assert.equal(installed.filter(({ cleared }) => cleared).length, 2, "stop limpia ambos timers una vez");
});

test("stop espera todos los heartbeat iniciados aunque el deadline haya liberado el dedupe", async () => {
  const deps = baseDeps(["repo"]);
  deps.readSettings = () => baseSettings(["repo"], { intervalMin: 60 });
  const intervals: Array<{ callback: () => void; ms: number }> = [];
  const deadlines: Array<{ callback: () => void; cancelled: boolean }> = [];
  deps.timers = {
    setInterval: (callback: () => void, ms: number) => {
      const timer = { callback, ms };
      intervals.push(timer);
      return timer;
    },
    clearInterval: () => undefined,
  };
  Object.assign(deps, {
    auxiliaryLeaseMs: 500,
    scheduleAuxiliaryStart: (callback: () => void) => callback(),
    scheduleAuxiliaryDeadline: (callback: () => void, ms: number) => {
      assert.equal(ms, 500);
      const deadline = { callback, cancelled: false };
      deadlines.push(deadline);
      return () => { deadline.cancelled = true; };
    },
  });
  let calls = 0;
  const releases: Array<() => void> = [];
  deps.incidents.heartbeatOwner = async () => {
    calls += 1;
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return true;
  };
  deps.git.lsRemoteMain = async () => null;
  const watcher = createMainHealthWatcher(deps);

  watcher.start();
  assert.equal(calls, 1);
  const heartbeatTimer = intervals.find(({ ms }) => ms === 900_000)!;
  heartbeatTimer.callback();
  assert.equal(calls, 1, "no solapa dentro del lease");
  deadlines[0]!.callback();
  heartbeatTimer.callback();
  assert.equal(calls, 2, "el deadline libera la clave aunque el efecto siga colgado");

  const stopping = watcher.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop conserva las dos ejecuciones terminales aunque ya no estén en dedupe");
  releases[0]!();
  await Promise.resolve();
  assert.equal(stopped, false, "todavía espera el segundo heartbeat iniciado");
  releases[1]!();
  await stopping;

  watcher.start();
  assert.equal(calls, 3, "el restart sólo inicia una generación nueva después del drain anterior");
  const restartedStop = watcher.stop();
  releases[2]!();
  await restartedStop;
});

test("stop espera un fixer iniciado que ignora abort antes de permitir restart", async () => {
  const deps = baseDeps(["repo"]);
  Object.assign(deps, {
    scheduleAuxiliaryStart: (callback: () => void) => callback(),
    scheduleAuxiliaryDeadline: () => () => undefined,
  });
  const current: Incident = {
    id: `repo@${SHA_A.slice(0, 7)}`,
    repo: "repo",
    firstRedSha: SHA_A,
    openedAt: 1,
    summary: "rojo",
    attribution: attribution(measurement("repo", SHA_A, "red")),
  };
  const releases: Array<() => void> = [];
  let calls = 0;
  deps.incidents = {
    ...noopIncidents(),
    readIncident: () => current,
    ensureFixer: async () => {
      calls += 1;
      await new Promise<void>((resolve) => { releases.push(resolve); });
    },
  };
  const watcher = createMainHealthWatcher(deps);

  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  assert.equal(calls, 1);
  const stopping = watcher.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  assert.equal(calls, 1, "no inicia otra generación mientras stop drena la anterior");

  releases[0]!();
  await stopping;
  watcher.start();
  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  assert.equal(calls, 2);
  const restartedStop = watcher.stop();
  releases[1]!();
  await restartedStop;
});

test("close invalida fixer y comentario encolados antes de que inicien", async () => {
  const deps = baseDeps(["repo"]);
  deps.readSettings = () => baseSettings(["repo"], { commentOnPr: true });
  const starts: Array<() => void> = [];
  Object.assign(deps, { scheduleAuxiliaryStart: (callback: () => void) => { starts.push(callback); } });
  let current: Incident | null = null;
  let fixer = 0;
  let comments = 0;
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => { fixer += 1; },
    closeIncident: async () => {
      const closed = current;
      current = null;
      return closed;
    },
  };
  deps.commentPullRequest = async () => { comments += 1; };
  let remoteMain = SHA_A;
  deps.git.lsRemoteMain = async () => remoteMain;
  const watcher = createMainHealthWatcher(deps);

  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  remoteMain = SHA_B;
  await watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  for (const start of starts) start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fixer, 0);
  assert.equal(comments, 0);
});

test("stop aborta y espera notify activo antes de crear la lane reiniciada", async () => {
  const deps = baseDeps(["repo"]);
  const timers: Array<() => void> = [];
  deps.timers = {
    setInterval: (callback: () => void) => { timers.push(callback); return callback; },
    clearInterval: () => undefined,
  };
  let remoteMain: string | null = null;
  deps.git.lsRemoteMain = async () => remoteMain;
  let current: Incident | null = null;
  let rejectFirst!: (error: Error) => void;
  let firstSignal: AbortSignal | undefined;
  const events: string[] = [];
  deps.incidents = {
    readIncident: () => current,
    openIncident: (input) => {
      current = { id: `repo@${input.firstRedSha.slice(0, 7)}`, openedAt: 1, ...input };
      return current;
    },
    heartbeatOwner: async () => false,
    ensureFixer: async () => ({ status: "disabled" as const }),
    closeIncident: async () => {
      const closed = current;
      current = null;
      return closed;
    },
  };
  deps.notifier = {
    opened: async (incident, signal) => {
      events.push(`open:${incident.id}:start`);
      if (incident.firstRedSha === SHA_A) {
        firstSignal = signal;
        await new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
      }
      events.push(`open:${incident.id}:end`);
    },
    closed: async (incident) => { events.push(`close:${incident.id}`); },
  };
  const watcher = createMainHealthWatcher(deps);

  watcher.start();
  remoteMain = SHA_A;
  await watcher.evaluate("repo", measurement("repo", SHA_A, "red"));
  remoteMain = SHA_B;
  await watcher.evaluate("repo", measurement("repo", SHA_B, "green"));
  const stopping = watcher.stop();
  assert.equal(firstSignal?.aborted, true);
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop espera el notifier aunque ignore el abort");
  watcher.start();
  await watcher.evaluate("repo", measurement("repo", SHA_C, "red"));
  assert.equal(events.includes(`open:repo@${SHA_C.slice(0, 7)}:start`), false, "no reinicia durante stop");

  rejectFirst(new DOMException("cancelado", "AbortError"));
  await stopping;
  watcher.start();
  remoteMain = SHA_C;
  await watcher.evaluate("repo", measurement("repo", SHA_C, "red"));
  assert.deepEqual(events, [
    `open:repo@${SHA_A.slice(0, 7)}:start`,
    `open:repo@${SHA_C.slice(0, 7)}:start`,
    `open:repo@${SHA_C.slice(0, 7)}:end`,
  ], "restart crea una lane nueva sólo tras terminar la promesa vieja");
  await watcher.stop();
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
  enabled.readSettings = () => baseSettings(["repo"], { leaseMin: 5 });
  let measurementCallback!: () => void;
  let installs = 0;
  let clears = 0;
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
    setInterval: (fn: () => void, ms: number) => {
      installs += 1;
      if (ms === 600_000) measurementCallback = fn;
      else assert.equal(ms, 150_000);
      return undefined;
    },
    clearInterval: (_handle: unknown) => { clears += 1; },
  };
  const on = createMainHealthWatcher(enabled);
  on.start();
  on.start();
  assert.equal(installs, 2, "start idempotente aunque los handles sean undefined");
  measurementCallback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  release();
  await on.idle();
  assert.equal(maxActive, 1);
  await on.stop();
  await on.stop();
  assert.equal(clears, 2, "stop elimina una sola vez ambos intervalos activos");
  on.start();
  assert.equal(installs, 4, "puede arrancar otra vez tras stop");
  await on.stop();
  assert.equal(clears, 4);
});
