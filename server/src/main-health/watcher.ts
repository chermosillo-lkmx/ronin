import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttributionInput, MainHealthAttribution } from "./attribution.js";
import type { Incident, OpenIncidentInput } from "./incident.js";
import type { MainHealthNotifier } from "./notify.js";
import { isMainHealthMeasurement, type MainHealthMeasurement, type MainHealthStore } from "./store.js";
import type { MainHealthSettings } from "../settings.js";

const CANONICAL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VETOED_REPO = "ant-liebre-app";
const DEFAULT_SCRIPT = fileURLToPath(new URL("../../../scripts/main-health.sh", import.meta.url));

export interface MainHealthGitPort {
  lsRemoteMain(repoDir: string): Promise<string | null>;
}

export interface MeasurementRunInput {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type MeasurementSignal = "SIGTERM" | "SIGKILL";

export interface MeasurementChildPort {
  pid?: number;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: () => void): unknown;
  removeListener?(event: "error" | "close", listener: ((error: Error) => void) | (() => void)): unknown;
  kill(signal: MeasurementSignal): unknown;
}

export interface MeasurementRunnerDeps {
  platform?: NodeJS.Platform;
  graceMs?: number;
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "ignore"; detached: boolean },
  ) => MeasurementChildPort;
  killProcessGroup?: (child: MeasurementChildPort, signal: MeasurementSignal) => void;
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export interface MainHealthIncidentPort {
  readIncident(repo: string): Incident | null;
  openIncident(input: OpenIncidentInput): Incident;
  heartbeatOwner(repo: string): Promise<boolean>;
  ensureFixer(repo: string, repoDir: string): Promise<unknown>;
  closeIncident(repo: string, repoDir?: string): Promise<Incident | null>;
}

export interface PullRequestCommentInput {
  repo: string;
  repoDir: string;
  incident: Incident;
  attribution: MainHealthAttribution;
  signal?: AbortSignal;
}

export interface MainHealthTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

type WatcherStore = Pick<MainHealthStore,
  "readMeasurement" | "readError" | "listMeasurements" | "confirmOperationalMeasurement"
>;

export interface MainHealthWatcherDeps {
  readSettings(): MainHealthSettings;
  store: WatcherStore;
  git: MainHealthGitPort;
  measure(input: MeasurementRunInput): Promise<void>;
  repoRoot: string;
  repoDir?: (root: string, repo: string) => string;
  script?: string;
  gateConfig(repo: string): { timeoutMs: number; env: Record<string, string> };
  attribute(input: AttributionInput): Promise<MainHealthAttribution>;
  incidents: MainHealthIncidentPort;
  notifier: MainHealthNotifier;
  commentPullRequest(input: PullRequestCommentInput): Promise<void>;
  timers?: MainHealthTimers;
  /** Lease de dedupe de efectos externos; no cancela la llamada subyacente. */
  auxiliaryLeaseMs?: number;
  scheduleAuxiliaryDeadline?: (callback: () => void, ms: number) => () => void;
  scheduleAuxiliaryStart?: (callback: () => void) => void;
  beforeJobFinalize?: (repo: string, sha: string) => Promise<void>;
  now?: () => number;
  logError?: (error: unknown) => void;
}

export type EnsureMeasuredResult =
  | { status: "cached"; measurement: MainHealthMeasurement }
  | { status: "queued"; repo: string; sha: string; deduplicated?: true }
  | { status: "suppressed"; reason: "recent-error"; repo: string; sha: string }
  | { status: "ignored"; reason: "disabled" | "repo-not-configured" | "repo-vetoed" | "stopping"; repo: string }
  | { status: "unavailable"; reason: "main-unavailable" | "invalid-sha"; repo: string };

export interface MainHealthWatcher {
  tick(): Promise<void>;
  ensureMeasured(repo: string, sha?: string): Promise<EnsureMeasuredResult>;
  evaluate(repo: string, measurement: MainHealthMeasurement): Promise<void>;
  /** Espera el tick vigente y el core de su cola; no auxiliares externos ni `evaluate` suelto. */
  idle(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

/** Puerto real para descubrir `main`; los tests sustituyen el método completo. */
export function createMainHealthGitPort(): MainHealthGitPort {
  return {
    lsRemoteMain(repoDir) {
      return new Promise((resolve, reject) => {
        execFile("git", ["ls-remote", "origin", "refs/heads/main"], {
          cwd: repoDir,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 256 * 1024,
        }, (error, stdout) => {
          if (error) return reject(error);
          const first = stdout.trim().split(/\s+/, 1)[0] ?? "";
          resolve(CANONICAL_SHA.test(first) ? first : null);
        });
      });
    },
  };
}

/** Construye el runner real dejando proceso, señales y reloj totalmente sustituibles. */
export function createMainHealthMeasurementRunner(runtime: MeasurementRunnerDeps = {}) {
  const platform = runtime.platform ?? process.platform;
  const graceMs = runtime.graceMs ?? 5_000;
  const spawnProcess = runtime.spawnProcess ?? ((command, args, options) => spawn(command, args, options));
  const timers = runtime.timers ?? {
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const killProcessGroup = runtime.killProcessGroup ?? ((child: MeasurementChildPort, signal: MeasurementSignal) => {
    if (platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    child.kill(signal);
  });

  /**
   * rc 1 (main rojo) y rc 2 (error registrado) son desenlaces normales. Incluso tras timeout
   * se espera `close`: el trap del script conserva la oportunidad de limpiar worktree y lock.
   */
  return function run(input: MeasurementRunInput): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawnProcess(input.command, input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: "ignore",
        detached: platform !== "win32",
      });
      let closed = false;
      let termination: "timeout" | "abort" | null = null;
      let spawnError: Error | undefined;
      let graceTimer: unknown;
      let timeoutTimer: unknown;
      const terminate = (reason: "timeout" | "abort") => {
        if (closed || termination) return;
        termination = reason;
        try { killProcessGroup(child, "SIGTERM"); } catch { /* se espera close igualmente */ }
        graceTimer = timers.setTimeout(() => {
          if (closed) return;
          try { killProcessGroup(child, "SIGKILL"); } catch { /* se espera close igualmente */ }
        }, graceMs);
      };
      const onError = (error: Error) => { spawnError = error; };
      const onAbort = () => { terminate("abort"); };
      const onClose = () => {
        closed = true;
        timers.clearTimeout(timeoutTimer);
        if (graceTimer !== undefined) timers.clearTimeout(graceTimer);
        input.signal?.removeEventListener("abort", onAbort);
        child.removeListener?.("error", onError);
        child.removeListener?.("close", onClose);
        if (termination === "abort") reject(new DOMException("medición main-health abortada", "AbortError"));
        else if (termination === "timeout") reject(new Error(`timeout midiendo main-health tras ${input.timeoutMs} ms`));
        else if (spawnError) reject(spawnError);
        else resolve();
      };
      child.once("error", onError);
      child.once("close", onClose);
      timeoutTimer = timers.setTimeout(() => { terminate("timeout"); }, input.timeoutMs);
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
}

export const runMainHealthMeasurement = createMainHealthMeasurementRunner();

export function defaultMainHealthRepoRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: () => string = homedir,
): string {
  return env.MAIN_HEALTH_REPO_ROOT ?? env.UNIT_GATE_MAIN_ROOT ?? join(home(), "code", "lkmx", "liebre");
}

export function createMainHealthWatcher(deps: MainHealthWatcherDeps): MainHealthWatcher {
  const repoDir = deps.repoDir ?? join;
  const script = deps.script ?? DEFAULT_SCRIPT;
  const timers = deps.timers ?? {
    setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const now = deps.now ?? Date.now;
  const auxiliaryLeaseMs = deps.auxiliaryLeaseMs ?? 30_000;
  const scheduleAuxiliaryStart = deps.scheduleAuxiliaryStart ?? queueMicrotask;
  const scheduleAuxiliaryDeadline = deps.scheduleAuxiliaryDeadline ?? ((callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return () => clearTimeout(handle);
  });
  interface MeasurementJob {
    repo: string;
    sha: string;
    measure: boolean;
    operational: boolean;
    terminalBaseline: boolean;
    rerunOperational: boolean;
    rerunMeasure: boolean;
    generation: number;
  }
  const pending = new Map<string, MeasurementJob>();
  const queue: MeasurementJob[] = [];
  const idleWaiters: Array<() => void> = [];
  type AuxiliaryKind = "heartbeat" | "fixer" | "comment";
  interface AuxiliaryRun {
    generation: number;
    kind: AuxiliaryKind;
    repo: string;
    incidentId?: string;
    started: boolean;
    controller: AbortController;
    cancelDeadline?: () => void;
  }
  const auxiliaryRuns = new Map<string, AuxiliaryRun>();
  const activeAuxiliaryRuns = new Set<AuxiliaryRun>();
  const auxiliaryEffects = new Set<Promise<void>>();
  interface NotificationTask {
    key: string;
    generation: number;
    effect: (signal: AbortSignal) => Promise<unknown>;
  }
  interface NotificationRun {
    key: string;
    generation: number;
    controller: AbortController;
    cancelDeadline?: () => void;
  }
  interface NotificationLane {
    generation: number;
    running: NotificationRun | null;
    queued: NotificationTask[];
  }
  const notificationLanes = new Map<string, NotificationLane>();
  const activeNotificationRuns = new Set<NotificationRun>();
  const notificationEffects = new Set<Promise<void>>();
  let pumping = false;
  let tickRun: Promise<void> | null = null;
  let evaluationTail: Promise<void> = Promise.resolve();
  let lifecycleGeneration = 0;
  let started = false;
  let stopping = false;
  let stopRun: Promise<void> | null = null;
  let activeMeasurement: { generation: number; controller: AbortController } | null = null;
  let measurementInterval: unknown;
  let heartbeatInterval: unknown;

  function safeRepo(repo: string): boolean {
    return repo.length <= 61
      && SAFE_REPO.test(repo)
      && !repo.includes("..")
      && !repo.endsWith(".")
      && !repo.toLowerCase().endsWith(".lock");
  }

  function repoRejection(settings: MainHealthSettings, repo: string): "disabled" | "repo-not-configured" | "repo-vetoed" | null {
    if (!settings.enabled) return "disabled";
    if (repo === VETOED_REPO) return "repo-vetoed";
    if (!safeRepo(repo) || !settings.repos.includes(repo)) return "repo-not-configured";
    return null;
  }

  function log(error: unknown): void {
    try {
      (deps.logError ?? ((value) => console.error("[main-health]", value)))(error);
    } catch {
      // Un logger roto no detiene ni la cola ni el intervalo.
    }
  }

  function launchAuxiliary(
    key: string,
    effect: (signal: AbortSignal) => Promise<unknown>,
    options: { kind: AuxiliaryKind; repo: string; incidentId?: string; guard?: () => boolean },
  ): void {
    if (stopping || auxiliaryRuns.has(key)) return;
    const run: AuxiliaryRun = {
      generation: lifecycleGeneration,
      kind: options.kind,
      repo: options.repo,
      incidentId: options.incidentId,
      started: false,
      controller: new AbortController(),
    };
    auxiliaryRuns.set(key, run);
    scheduleAuxiliaryStart(() => {
      if (stopping || auxiliaryRuns.get(key) !== run || run.generation !== lifecycleGeneration) return;
      if (options.guard && !options.guard()) {
        auxiliaryRuns.delete(key);
        return;
      }
      run.started = true;
      activeAuxiliaryRuns.add(run);
      run.cancelDeadline = scheduleAuxiliaryDeadline(() => {
        if (auxiliaryRuns.get(key) === run) {
          run.controller.abort();
          auxiliaryRuns.delete(key);
        }
      }, auxiliaryLeaseMs);
      let result: Promise<unknown>;
      try {
        result = Promise.resolve(effect(run.controller.signal));
      } catch (error) {
        log(error);
        run.cancelDeadline();
        activeAuxiliaryRuns.delete(run);
        if (auxiliaryRuns.get(key) === run) auxiliaryRuns.delete(key);
        return;
      }
      const terminal = result.then(
        () => undefined,
        (error) => { log(error); },
      ).finally(() => {
        run.cancelDeadline?.();
        activeAuxiliaryRuns.delete(run);
        auxiliaryEffects.delete(terminal);
        if (auxiliaryRuns.get(key) === run) auxiliaryRuns.delete(key);
      });
      auxiliaryEffects.add(terminal);
      void terminal;
    });
  }

  function incidentStillOpen(repo: string, incidentId: string): boolean {
    const current = deps.incidents.readIncident(repo);
    return current?.id === incidentId && current.closingAt === undefined && current.closedAt === undefined;
  }

  function cancelQueuedOpenAuxiliaries(repo: string, incidentId: string): void {
    for (const [key, run] of auxiliaryRuns) {
      if (!run.started && run.repo === repo && run.incidentId === incidentId) {
        run.cancelDeadline?.();
        auxiliaryRuns.delete(key);
      }
    }
  }

  function finishNotification(repo: string, lane: NotificationLane, run: NotificationRun): void {
    run.cancelDeadline?.();
    if (notificationLanes.get(repo) !== lane || lane.running !== run) return;
    lane.running = null;
    pumpNotifications(repo);
  }

  function pumpNotifications(repo: string): void {
    const lane = notificationLanes.get(repo);
    if (!lane || lane.running) return;
    let task = lane.queued.shift();
    while (task && task.generation !== lane.generation) task = lane.queued.shift();
    if (!task) {
      notificationLanes.delete(repo);
      return;
    }
    const run: NotificationRun = {
      key: task.key,
      generation: task.generation,
      controller: new AbortController(),
    };
    lane.running = run;
    activeNotificationRuns.add(run);
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(task.effect(run.controller.signal));
    } catch (error) {
      log(error);
      activeNotificationRuns.delete(run);
      finishNotification(repo, lane, run);
      return;
    }
    if (notificationLanes.get(repo) === lane && lane.running === run) {
      try {
        run.cancelDeadline = scheduleAuxiliaryDeadline(() => {
          if (notificationLanes.get(repo) !== lane || lane.running !== run) return;
          run.controller.abort();
          finishNotification(repo, lane, run);
        }, auxiliaryLeaseMs);
      } catch (error) {
        log(error);
        run.controller.abort();
        finishNotification(repo, lane, run);
      }
    }
    const terminal = result.then(
      () => undefined,
      (error) => { log(error); },
    ).finally(() => {
      activeNotificationRuns.delete(run);
      notificationEffects.delete(terminal);
      finishNotification(repo, lane, run);
    });
    notificationEffects.add(terminal);
    void terminal;
  }

  function enqueueNotification(repo: string, key: string, effect: (signal: AbortSignal) => Promise<unknown>): void {
    if (stopping) return;
    const current = notificationLanes.get(repo);
    const lane = current?.generation === lifecycleGeneration
      ? current
      : { generation: lifecycleGeneration, running: null, queued: [] };
    if (current !== lane) notificationLanes.set(repo, lane);
    if (lane.running?.key === key || lane.queued.some((task) => task.key === key)) return;
    lane.queued.push({ key, generation: lifecycleGeneration, effect });
    pumpNotifications(repo);
  }

  function cancelQueuedOpenNotification(repo: string, incidentId: string): boolean {
    const lane = notificationLanes.get(repo);
    if (!lane) return false;
    const key = `notify-open:${incidentId}`;
    const before = lane.queued.length;
    lane.queued = lane.queued.filter((task) => task.key !== key);
    return lane.queued.length !== before;
  }

  async function operationalMainStillCurrent(
    repo: string,
    measurement: MainHealthMeasurement,
    generation: number,
  ): Promise<boolean> {
    if (stopping || generation !== lifecycleGeneration) return false;
    if (repoRejection(deps.readSettings(), repo)) return false;
    const currentMain = await resolveMain(repo);
    return !stopping
      && generation === lifecycleGeneration
      && currentMain === measurement.sha;
  }

  async function confirmOperationalMain(
    repo: string,
    measurement: MainHealthMeasurement,
    generation: number,
  ): Promise<boolean> {
    if (!await operationalMainStillCurrent(repo, measurement, generation)) return false;
    deps.store.confirmOperationalMeasurement(repo, measurement.sha);
    return true;
  }

  async function evaluateCore(repo: string, measurement: MainHealthMeasurement, generation: number): Promise<void> {
    if (stopping || generation !== lifecycleGeneration) return;
    const settings = deps.readSettings();
    if (repoRejection(settings, repo)
      || measurement.repo !== repo
      || !CANONICAL_SHA.test(measurement.sha)) return;
    if (measurement.status === "red") {
      const existing = deps.incidents.readIncident(repo);
      if (existing) {
        if (!await confirmOperationalMain(repo, measurement, generation)) return;
        launchAuxiliary(
          `fixer:${repo}`,
          () => deps.incidents.ensureFixer(repo, repoDir(deps.repoRoot, repo)),
          { kind: "fixer", repo, incidentId: existing.id, guard: () => incidentStillOpen(repo, existing.id) },
        );
        return;
      }
      const report = await deps.attribute({
        repoDir: repoDir(deps.repoRoot, repo),
        red: measurement,
        measurements: deps.store.listMeasurements(repo),
      });
      if (stopping || generation !== lifecycleGeneration) return;
      if (!await confirmOperationalMain(repo, measurement, generation)) return;
      const failures = measurement.failed.length + measurement.errors.length;
      const incident = deps.incidents.openIncident({
        repo,
        firstRedSha: measurement.sha,
        summary: `main rojo: ${failures} prueba${failures === 1 ? "" : "s"} fallida${failures === 1 ? "" : "s"}`,
        attribution: report,
      });
      enqueueNotification(
        repo,
        `notify-open:${incident.id}`,
        (signal) => deps.notifier.opened(incident, signal),
      );
      if (settings.commentOnPr) {
        launchAuxiliary(
          `comment:${incident.id}`,
          (signal) => deps.commentPullRequest({
            repo,
            repoDir: repoDir(deps.repoRoot, repo),
            incident,
            attribution: report,
            signal,
          }),
          { kind: "comment", repo, incidentId: incident.id, guard: () => incidentStillOpen(repo, incident.id) },
        );
      }
      launchAuxiliary(
        `fixer:${repo}`,
        () => deps.incidents.ensureFixer(repo, repoDir(deps.repoRoot, repo)),
        { kind: "fixer", repo, incidentId: incident.id, guard: () => incidentStillOpen(repo, incident.id) },
      );
      return;
    }

    const open = deps.incidents.readIncident(repo);
    if (!await confirmOperationalMain(repo, measurement, generation)) return;
    if (!open) return;
    cancelQueuedOpenAuxiliaries(repo, open.id);
    const closed = await deps.incidents.closeIncident(repo, repoDir(deps.repoRoot, repo));
    if (stopping || generation !== lifecycleGeneration) return;
    if (closed) {
      const droppedOpen = cancelQueuedOpenNotification(repo, closed.id);
      if (!droppedOpen) {
        enqueueNotification(
          repo,
          `notify-close:${closed.id}:${closed.closedAt ?? "closed"}`,
          (signal) => deps.notifier.closed(closed, signal),
        );
      }
    }
  }

  function scheduleEvaluation(repo: string, measurement: MainHealthMeasurement): Promise<void> {
    if (stopping) return Promise.resolve();
    const generation = lifecycleGeneration;
    const run = evaluationTail.then(() => evaluateCore(repo, measurement, generation));
    evaluationTail = run.catch(() => undefined);
    return run;
  }

  async function evaluate(repo: string, measurement: MainHealthMeasurement): Promise<void> {
    if (stopping) return;
    const generation = lifecycleGeneration;
    const settings = deps.readSettings();
    if (repoRejection(settings, repo)
      || measurement.repo !== repo
      || !CANONICAL_SHA.test(measurement.sha)) return;
    const currentMain = await resolveMain(repo);
    if (stopping || generation !== lifecycleGeneration || currentMain !== measurement.sha) return;
    await scheduleEvaluation(repo, measurement);
  }

  async function runJob(job: MeasurementJob): Promise<void> {
    if (stopping || job.generation !== lifecycleGeneration) return;
    if (job.measure) {
      const config = deps.gateConfig(job.repo);
      const active = { generation: job.generation, controller: new AbortController() };
      activeMeasurement = active;
      try {
        await deps.measure({
          command: script,
          args: [job.repo, "--sha", job.sha],
          cwd: deps.repoRoot,
          env: { MAIN_HEALTH_REPO_ROOT: deps.repoRoot, ...config.env },
          timeoutMs: config.timeoutMs,
          signal: active.controller.signal,
        });
      } catch (error) {
        log(error);
      } finally {
        if (activeMeasurement === active) activeMeasurement = null;
      }
    }
    if (stopping || job.generation !== lifecycleGeneration) return;
    const result = deps.store.readMeasurement(job.repo, job.sha);
    if (!result || !isMainHealthMeasurement(result) || result.repo !== job.repo || result.sha !== job.sha) {
      job.terminalBaseline = true;
      return;
    }
    if (stopping || job.generation !== lifecycleGeneration) return;
    if (!job.operational) {
      job.terminalBaseline = true;
      return;
    }
    await scheduleEvaluation(job.repo, result);
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (stopping) break;
        const job = queue.shift();
        if (!job) break;
        const key = `${job.repo}@${job.sha}`;
        try {
          await runJob(job);
        } catch (error) {
          log(error);
        } finally {
          try {
            await deps.beforeJobFinalize?.(job.repo, job.sha);
          } catch (error) {
            log(error);
          }
          pending.delete(key);
          if (job.rerunOperational && !stopping && job.generation === lifecycleGeneration) {
            enqueue(job.repo, job.sha, job.rerunMeasure, true);
          }
        }
      }
    } finally {
      pumping = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
      // Una entrada puede llegar entre el último `shift` y este finally.
      if (!stopping && queue.length > 0) void pump();
    }
  }

  function enqueue(repo: string, sha: string, measure: boolean, operational: boolean): boolean {
    if (stopping) return false;
    const key = `${repo}@${sha}`;
    const existing = pending.get(key);
    if (existing) {
      if (operational && existing.terminalBaseline) {
        existing.rerunOperational = true;
        existing.rerunMeasure ||= measure;
      } else if (operational) {
        existing.operational = true;
      }
      return false;
    }
    const job = {
      repo,
      sha,
      measure,
      operational,
      terminalBaseline: false,
      rerunOperational: false,
      rerunMeasure: false,
      generation: lifecycleGeneration,
    };
    pending.set(key, job);
    queue.push(job);
    void pump();
    return true;
  }

  async function resolveMain(repo: string): Promise<string | null> {
    try {
      return await deps.git.lsRemoteMain(repoDir(deps.repoRoot, repo));
    } catch (error) {
      log(error);
      return null;
    }
  }

  async function ensureMeasured(repo: string, requestedSha?: string): Promise<EnsureMeasuredResult> {
    if (stopping) return { status: "ignored", reason: "stopping", repo };
    const generation = lifecycleGeneration;
    const settings = deps.readSettings();
    const rejection = repoRejection(settings, repo);
    if (rejection) return { status: "ignored", reason: rejection, repo };
    const operational = requestedSha === undefined;
    const sha = requestedSha ?? await resolveMain(repo);
    if (stopping || generation !== lifecycleGeneration) return { status: "ignored", reason: "stopping", repo };
    if (!sha) return { status: "unavailable", reason: "main-unavailable", repo };
    if (!CANONICAL_SHA.test(sha)) return { status: "unavailable", reason: "invalid-sha", repo };
    const cached = deps.store.readMeasurement(repo, sha);
    if (cached) {
      enqueue(repo, sha, false, operational);
      return { status: "cached", measurement: cached };
    }
    const error = deps.store.readError(repo, sha);
    const errorAge = error ? now() - error.at : -1;
    if (errorAge >= 0 && errorAge < 60 * 60_000) {
      return { status: "suppressed", reason: "recent-error", repo, sha };
    }
    return enqueue(repo, sha, true, operational)
      ? { status: "queued", repo, sha }
      : { status: "queued", repo, sha, deduplicated: true };
  }

  async function discover(): Promise<void> {
    if (stopping) return;
    const settings = deps.readSettings();
    if (!settings.enabled) return;
    for (const repo of settings.repos) {
      await ensureMeasured(repo);
      if (stopping) return;
    }
  }

  function heartbeatTick(): void {
    if (stopping) return;
    const settings = deps.readSettings();
    if (!settings.enabled) return;
    for (const repo of settings.repos) {
      if (repoRejection(settings, repo)) continue;
      launchAuxiliary(
        `heartbeat:${repo}`,
        () => deps.incidents.heartbeatOwner(repo),
        { kind: "heartbeat", repo },
      );
    }
  }

  function tick(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (tickRun) return tickRun;
    const run = discover().catch(log).finally(() => {
      if (tickRun === run) tickRun = null;
    });
    tickRun = run;
    return run;
  }

  async function idle(): Promise<void> {
    if (stopRun) return stopRun;
    if (tickRun) await tickRun;
    while (pumping || queue.length > 0) {
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    }
  }

  function start(): void {
    if (started || stopping) return;
    const settings = deps.readSettings();
    if (!settings.enabled) return;
    const measurementMs = settings.intervalMin * 60_000;
    const heartbeatMs = Math.min(measurementMs, Math.max(1_000, settings.leaseMin * 60_000 / 2));
    measurementInterval = timers.setInterval(() => { void tick(); }, measurementMs);
    heartbeatInterval = timers.setInterval(heartbeatTick, heartbeatMs);
    started = true;
    void tick();
    heartbeatTick();
  }

  async function waitForPump(): Promise<void> {
    while (pumping) await new Promise<void>((resolve) => idleWaiters.push(resolve));
  }

  function stop(): Promise<void> {
    if (stopRun) return stopRun;
    stopping = true;
    lifecycleGeneration += 1;
    for (const run of auxiliaryRuns.values()) {
      run.cancelDeadline?.();
      run.controller.abort();
    }
    for (const run of activeAuxiliaryRuns) {
      run.cancelDeadline?.();
      run.controller.abort();
    }
    auxiliaryRuns.clear();
    for (const lane of notificationLanes.values()) {
      lane.queued.length = 0;
      lane.running?.cancelDeadline?.();
      lane.running?.controller.abort();
    }
    for (const run of activeNotificationRuns) {
      run.cancelDeadline?.();
      run.controller.abort();
    }
    notificationLanes.clear();
    const externalEffects = [...auxiliaryEffects, ...notificationEffects];
    queue.length = 0;
    pending.clear();
    activeMeasurement?.controller.abort();
    if (started) {
      started = false;
      timers.clearInterval(measurementInterval);
      timers.clearInterval(heartbeatInterval);
      measurementInterval = undefined;
      heartbeatInterval = undefined;
    }
    const draining = (async () => {
      const activeTick = tickRun;
      if (activeTick) await activeTick.catch(log);
      await waitForPump();
      await evaluationTail.catch(log);
      await Promise.allSettled(externalEffects);
    })();
    const run = draining.finally(() => {
      if (stopRun !== run) return;
      stopping = false;
      stopRun = null;
    });
    stopRun = run;
    return run;
  }

  return { tick, ensureMeasured, evaluate, idle, start, stop };
}
