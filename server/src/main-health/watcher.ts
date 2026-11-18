import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AttributionInput, MainHealthAttribution } from "./attribution.js";
import type { Incident, OpenIncidentInput } from "./incident.js";
import type { MainHealthNotifier } from "./notify.js";
import { isMainHealthMeasurement, type MainHealthMeasurement, type MainHealthStore } from "./store.js";
import type { MainHealthSettings } from "../settings.js";

const FULL_SHA = /^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/;
const INPUT_SHA = /^[A-Fa-f0-9]{7,64}$/;
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
}

export interface MainHealthIncidentPort {
  readIncident(repo: string): Incident | null;
  openIncident(input: OpenIncidentInput): Incident;
  ensureFixer(repo: string, repoDir: string): Promise<unknown>;
  closeIncident(repo: string, repoDir?: string): Promise<Incident | null>;
}

export interface PullRequestCommentInput {
  repo: string;
  repoDir: string;
  incident: Incident;
  attribution: MainHealthAttribution;
}

export interface MainHealthTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

type WatcherStore = Pick<MainHealthStore,
  "readMeasurement" | "readError" | "listMeasurements"
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
  now?: () => number;
  logError?: (error: unknown) => void;
}

export type EnsureMeasuredResult =
  | { status: "cached"; measurement: MainHealthMeasurement }
  | { status: "queued"; repo: string; sha: string; deduplicated?: true }
  | { status: "suppressed"; reason: "recent-error"; repo: string; sha: string }
  | { status: "ignored"; reason: "repo-not-configured"; repo: string }
  | { status: "unavailable"; reason: "main-unavailable" | "invalid-sha"; repo: string };

export interface MainHealthWatcher {
  tick(): Promise<void>;
  ensureMeasured(repo: string, sha?: string): Promise<EnsureMeasuredResult>;
  evaluate(repo: string, measurement: MainHealthMeasurement): Promise<void>;
  /** Espera el tick vigente y toda la cola; sólo existe para coordinación y apagado limpio. */
  idle(): Promise<void>;
  start(): void;
  stop(): void;
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
          resolve(FULL_SHA.test(first) ? first.toLowerCase() : null);
        });
      });
    },
  };
}

/**
 * Runner real de la medición. Un rc 1 (main rojo) y rc 2 (error registrado) son desenlaces
 * normales: quien decide es el JSON que el watcher relee al cerrar el proceso.
 */
export function runMainHealthMeasurement(input: MeasurementRunInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      stdio: "ignore",
    });
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`timeout midiendo main-health tras ${input.timeoutMs} ms`));
    }, input.timeoutMs);
    child.once("error", (error) => finish(error));
    child.once("close", () => finish());
  });
}

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
  const pending = new Set<string>();
  const queue: Array<{ repo: string; sha: string }> = [];
  const idleWaiters: Array<() => void> = [];
  let pumping = false;
  let tickRun: Promise<void> | null = null;
  let interval: unknown;

  function log(error: unknown): void {
    try {
      (deps.logError ?? ((value) => console.error("[main-health]", value)))(error);
    } catch {
      // Un logger roto no detiene ni la cola ni el intervalo.
    }
  }

  async function safe(effect: () => Promise<unknown>): Promise<void> {
    try {
      await effect();
    } catch (error) {
      log(error);
    }
  }

  async function evaluate(repo: string, measurement: MainHealthMeasurement): Promise<void> {
    if (measurement.status === "red") {
      if (deps.incidents.readIncident(repo)) return;
      const report = await deps.attribute({
        repoDir: repoDir(deps.repoRoot, repo),
        red: measurement,
        measurements: deps.store.listMeasurements(repo),
      });
      const failures = measurement.failed.length + measurement.errors.length;
      const incident = deps.incidents.openIncident({
        repo,
        firstRedSha: measurement.sha,
        summary: `main rojo: ${failures} prueba${failures === 1 ? "" : "s"} fallida${failures === 1 ? "" : "s"}`,
        attribution: report,
      });
      await safe(() => deps.notifier.opened(incident));
      if (deps.readSettings().commentOnPr) {
        await safe(() => deps.commentPullRequest({
          repo,
          repoDir: repoDir(deps.repoRoot, repo),
          incident,
          attribution: report,
        }));
      }
      await safe(() => deps.incidents.ensureFixer(repo, repoDir(deps.repoRoot, repo)));
      return;
    }

    if (!deps.incidents.readIncident(repo)) return;
    const closed = await deps.incidents.closeIncident(repo, repoDir(deps.repoRoot, repo));
    if (closed) await safe(() => deps.notifier.closed(closed));
  }

  async function runJob(job: { repo: string; sha: string }): Promise<void> {
    const config = deps.gateConfig(job.repo);
    try {
      await deps.measure({
        command: script,
        args: [job.repo, "--sha", job.sha],
        cwd: deps.repoRoot,
        env: { MAIN_HEALTH_REPO_ROOT: deps.repoRoot, ...config.env },
        timeoutMs: config.timeoutMs,
      });
    } catch (error) {
      log(error);
    }
    const result = deps.store.readMeasurement(job.repo, job.sha);
    if (!result || !isMainHealthMeasurement(result) || result.repo !== job.repo || result.sha !== job.sha) return;
    await evaluate(job.repo, result);
  }

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = queue.shift();
        if (!job) break;
        const key = `${job.repo}@${job.sha}`;
        try {
          await runJob(job);
        } catch (error) {
          log(error);
        } finally {
          pending.delete(key);
        }
      }
    } finally {
      pumping = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
      // Una entrada puede llegar entre el último `shift` y este finally.
      if (queue.length > 0) void pump();
    }
  }

  function enqueue(repo: string, sha: string): boolean {
    const key = `${repo}@${sha}`;
    if (pending.has(key)) return false;
    pending.add(key);
    queue.push({ repo, sha });
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
    const settings = deps.readSettings();
    if (!settings.repos.includes(repo)) return { status: "ignored", reason: "repo-not-configured", repo };
    const sha = requestedSha ?? await resolveMain(repo);
    if (!sha) return { status: "unavailable", reason: "main-unavailable", repo };
    if (!INPUT_SHA.test(sha)) return { status: "unavailable", reason: "invalid-sha", repo };
    const cached = deps.store.readMeasurement(repo, sha);
    if (cached) return { status: "cached", measurement: cached };
    const error = deps.store.readError(repo, sha);
    const errorAge = error ? now() - error.at : -1;
    if (errorAge >= 0 && errorAge < 60 * 60_000) {
      return { status: "suppressed", reason: "recent-error", repo, sha };
    }
    return enqueue(repo, sha)
      ? { status: "queued", repo, sha }
      : { status: "queued", repo, sha, deduplicated: true };
  }

  async function discover(): Promise<void> {
    const settings = deps.readSettings();
    if (!settings.enabled) return;
    for (const repo of settings.repos) await ensureMeasured(repo);
  }

  function tick(): Promise<void> {
    if (tickRun) return tickRun;
    const run = discover().catch(log).finally(() => {
      if (tickRun === run) tickRun = null;
    });
    tickRun = run;
    return run;
  }

  async function idle(): Promise<void> {
    if (tickRun) await tickRun;
    while (pumping || queue.length > 0) {
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    }
  }

  function start(): void {
    if (interval !== undefined) return;
    const settings = deps.readSettings();
    if (!settings.enabled) return;
    void tick();
    interval = timers.setInterval(() => { void tick(); }, settings.intervalMin * 60_000);
  }

  function stop(): void {
    if (interval === undefined) return;
    timers.clearInterval(interval);
    interval = undefined;
  }

  return { tick, ensureMeasured, evaluate, idle, start, stop };
}
