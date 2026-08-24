import { randomBytes, createHash } from "node:crypto";
import { copyFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { resolveCwd as defaultResolveCwd } from "../repos.js";
import { boundOutput, readCoverageFile, readJUnitFile, redactEvidence } from "./artifacts.js";
import type { HarnessStore } from "./config.js";
import {
  COMMAND_SUITES,
  clone,
  isTerminal,
  SUITES,
  type Batch,
  type Coverage,
  type Profile,
  type Run,
  type RunSelection,
  type RunStatus,
  type SuiteConfig,
  type TestSuite,
  type TestTotals,
} from "./model.js";
import { runCommand, type RunCommandHandle } from "./runner.js";

/**
 * Orquestación: convierte una selección declarada en corridas persistidas, las encola por repo
 * (FIFO, una a la vez por repo), ejecuta el proceso hijo con un entorno mínimo + variables del
 * perfil, copia los artefactos declarados a `test-artifacts/<runId>/`, los parsea y deja el
 * resultado redactado en el journal. La matriz se calcula SÓLO desde corridas terminales.
 */

export class HarnessError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "HarnessError";
  }
}

export interface ServiceOptions {
  store: HarnessStore;
  resolveCwd?: (repo: string) => { cwd: string; real: boolean };
  now?: () => Date;
  /** Variables del entorno padre que SÍ se heredan (PATH y locale; nada más). */
  inheritEnv?: readonly string[];
}

export type CellState = "unconfigured" | "never_run" | RunStatus;

export interface MatrixCell {
  suite: TestSuite;
  state: CellState;
  runId?: string;
  finishedAt?: string;
  durationMs?: number;
  totals?: TestTotals;
  coverage?: Coverage;
  reason?: string;
}

export interface MatrixRow {
  repo: string;
  configured: boolean;
  profiles: string[];
  cells: Record<TestSuite, MatrixCell>;
}

export interface StartResult {
  batchId?: string;
  runIds: string[];
}

const INHERIT_ENV_DEFAULT = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "USER"] as const;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export function createTestHarnessService(options: ServiceOptions) {
  const { store } = options;
  const resolveCwd = options.resolveCwd ?? defaultResolveCwd;
  const now = options.now ?? (() => new Date());
  const inherit = options.inheritEnv ?? INHERIT_ENV_DEFAULT;

  const queues = new Map<string, Promise<void>>();
  const active = new Map<string, RunCommandHandle>();
  const waiters = new Map<string, Array<() => void>>();

  function settle(runId: string): void {
    const list = waiters.get(runId) ?? [];
    waiters.delete(runId);
    for (const w of list) w();
  }

  function persist(run: Run): Run {
    store.upsertRun(run);
    if (isTerminal(run.status)) settle(run.runId);
    return run;
  }

  function blockedRun(base: Omit<Run, "runId" | "status" | "createdAt">, reason: string): Run {
    const at = now().toISOString();
    return persist({ ...base, runId: newId("run"), status: "blocked", createdAt: at, finishedAt: at, reason });
  }

  function childEnv(profile: Profile): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of inherit) if (process.env[key] !== undefined) env[key] = process.env[key]!;
    Object.assign(env, profile.variables);
    return env;
  }

  /** Resuelve la ruta declarada bajo el cwd real; rechaza escapes por `..` o symlink. */
  function resolveArtifact(cwdReal: string, declared: string): { file?: string; reason?: string } {
    const candidate = resolve(cwdReal, declared);
    if (!existsSync(candidate)) return { reason: `${basename(declared)} no encontrado` };
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      return { reason: `${basename(declared)} no legible` };
    }
    if (!within(cwdReal, real)) return { reason: `${declared} apunta fuera del repo` };
    return { file: real };
  }

  function copyArtifact(runId: string, file: string, label: string): string {
    const dir = store.artifactsDir(runId);
    const target = join(dir, `${label}-${basename(file)}`);
    copyFileSync(file, target);
    return target;
  }

  function fingerprintOf(run: Run): string | undefined {
    if (!run.failures?.length) return undefined;
    return createHash("sha1").update(run.failures.map((f) => `${f.classname ?? ""}::${f.name}`).sort().join("\n")).digest("hex").slice(0, 16);
  }

  /** Un artefacto de la corrida anterior nunca debe leerse como resultado de ésta. */
  function clearStaleArtifacts(cwdReal: string, suite: SuiteConfig): void {
    for (const declared of [suite.junitPath, suite.coberturaPath, suite.lcovPath]) {
      if (!declared) continue;
      const { file } = resolveArtifact(cwdReal, declared);
      if (file) rmSync(file, { force: true });
    }
  }

  async function execute(run: Run, suite: SuiteConfig, profile: Profile, cwdReal: string): Promise<void> {
    clearStaleArtifacts(cwdReal, suite);
    run.status = "running";
    run.startedAt = now().toISOString();
    persist(run);
    const handle = runCommand({ command: suite.command, cwd: cwdReal, env: childEnv(profile), timeoutMs: suite.timeoutMs });
    active.set(run.runId, handle);
    const result = await handle.done;
    active.delete(run.runId);

    const secrets = Object.values(profile.variables);
    run.finishedAt = result.finishedAt;
    run.exitCode = result.exitCode;
    run.stdout = boundOutput(redactEvidence(result.stdout, secrets));
    run.stderr = boundOutput(redactEvidence(result.stderr, secrets));
    run.artifacts = [];

    // Artefactos: se copian ANTES de parsear para que la evidencia histórica no dependa del repo.
    const junit = suite.junitPath ? resolveArtifact(cwdReal, suite.junitPath) : { reason: "sin junitPath declarado" };
    if (junit.reason) junit.reason = `JUnit ${junit.reason}`;
    if (junit.file) {
      const copy = copyArtifact(run.runId, junit.file, "junit");
      run.artifacts.push(copy);
      const parsed = readJUnitFile(copy);
      if (parsed.summary) {
        run.totals = parsed.summary.totals;
        run.failures = parsed.summary.failures.map((f) => ({ ...f, message: redactEvidence(f.message, secrets) }));
      } else run.totalsReason = parsed.reason;
    } else run.totalsReason = junit.reason;

    const covDeclared = suite.coberturaPath ? ({ path: suite.coberturaPath, format: "cobertura" } as const) : suite.lcovPath ? ({ path: suite.lcovPath, format: "lcov" } as const) : undefined;
    if (covDeclared) {
      const cov = resolveArtifact(cwdReal, covDeclared.path);
      if (cov.file) {
        const copy = copyArtifact(run.runId, cov.file, "coverage");
        run.artifacts.push(copy);
        run.coverage = readCoverageFile(copy, covDeclared.format);
      } else run.coverage = { status: "not_reported", reason: `cobertura ${cov.reason}` };
    } else {
      run.coverage = run.suite === "unit" ? { status: "not_reported", reason: "sin ruta de cobertura declarada" } : { status: "not_applicable" };
    }

    if (result.outcome === "timeout") run.status = "timeout";
    else if (result.outcome === "cancelled") run.status = "cancelled";
    else if (result.outcome === "error") run.status = "error";
    else if (result.exitCode === 0 && !(run.totals && run.totals.failed + run.totals.errors > 0)) run.status = "passed";
    else run.status = "failed";
    run.fingerprint = fingerprintOf(run);
    persist(run);
  }

  function enqueue(run: Run, suite: SuiteConfig, profile: Profile, cwdReal: string): void {
    const prev = queues.get(run.repo) ?? Promise.resolve();
    const next = prev.then(() => execute(run, suite, profile, cwdReal)).catch((error) => {
      run.status = "error";
      run.finishedAt = now().toISOString();
      run.stderr = boundOutput(String((error as Error).stack ?? error));
      persist(run);
    });
    queues.set(run.repo, next);
  }

  /** Crea (y encola o bloquea) una corrida repo×suite. Nunca lanza por configuración: bloquea. */
  function startSuite(repo: string, suiteKey: TestSuite, profileName: string, batchId?: string): Run {
    const harness = store.readRepo(repo);
    const base: Omit<Run, "runId" | "status" | "createdAt"> = { repo: harness.repo, suite: suiteKey, profile: profileName, ...(batchId ? { batchId } : {}) };
    const profile = harness.config.profiles.find((p) => p.name === profileName);
    if (!profile) return blockedRun(base, `perfil "${profileName}" no configurado en ${harness.repo}`);
    if (!(COMMAND_SUITES as readonly string[]).includes(suiteKey)) return blockedRun(base, `suite ${suiteKey} no ejecutable en este corte (sólo ${COMMAND_SUITES.join("/")})`);
    const suite = harness.config.suites[suiteKey];
    if (!suite) return blockedRun(base, `suite ${suiteKey} sin configurar: declara command/junitPath en Pruebas → ${harness.repo}`);
    const root = resolveCwd(harness.repo);
    if (!root.real) return blockedRun(base, `carpeta del repo ${harness.repo} no existe (repos.json)`);
    let cwdReal: string;
    try {
      const rootReal = realpathSync(root.cwd);
      cwdReal = realpathSync(resolve(rootReal, suite.cwd ?? "."));
      if (!within(rootReal, cwdReal)) return blockedRun(base, `cwd "${suite.cwd}" apunta fuera del repo`);
    } catch {
      return blockedRun(base, `cwd "${suite.cwd ?? "."}" no existe en ${root.cwd}`);
    }
    const run: Run = { ...base, runId: newId("run"), status: "queued", createdAt: now().toISOString(), command: clone(suite.command), cwd: cwdReal };
    persist(run);
    enqueue(run, suite, profile, cwdReal);
    return run;
  }

  function latestTerminal(repo: string, suite: TestSuite): Run | undefined {
    const runs = store.listRuns().filter((r) => r.repo === repo && r.suite === suite && isTerminal(r.status) && r.status !== "blocked");
    return runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }

  function reposWithProfile(profile: string): string[] {
    return store.listHarnessRepos().filter((r) => store.readRepo(r).configured);
  }

  async function start(selection: RunSelection): Promise<StartResult> {
    if (selection.kind === "suites") {
      if (!store.listHarnessRepos().includes(selection.repo)) throw new HarnessError(`repo desconocido: ${selection.repo}`, "REPO_NOT_FOUND", 404);
      return { runIds: selection.suites.map((s) => startSuite(selection.repo, s, selection.profile).runId) };
    }
    const batch: Batch = { batchId: newId("batch"), kind: selection.kind, profile: selection.profile, createdAt: now().toISOString(), runIds: [] };
    for (const repo of reposWithProfile(selection.profile)) {
      const cfg = store.readRepo(repo).config;
      const declared = SUITES.filter((s) => cfg.suites[s] && (COMMAND_SUITES as readonly string[]).includes(s));
      for (const suite of declared) {
        if (selection.kind === "failed") {
          const last = latestTerminal(repo, suite);
          if (!last || !["failed", "error", "timeout"].includes(last.status) || last.profile !== selection.profile) continue;
        }
        batch.runIds.push(startSuite(repo, suite, selection.profile, batch.batchId).runId);
      }
    }
    store.upsertBatch(batch);
    return { batchId: batch.batchId, runIds: batch.runIds };
  }

  function cancel(runId: string): boolean {
    const handle = active.get(runId);
    if (!handle) return false;
    handle.cancel();
    return true;
  }

  function waitFor(runId: string): Promise<void> {
    const run = store.getRun(runId);
    if (!run) return Promise.reject(new HarnessError(`run desconocido: ${runId}`, "RUN_NOT_FOUND", 404));
    if (isTerminal(run.status)) return Promise.resolve();
    return new Promise((resolveWait) => {
      const list = waiters.get(runId) ?? [];
      list.push(resolveWait);
      waiters.set(runId, list);
    });
  }

  async function waitForAll(runIds: string[]): Promise<void> {
    await Promise.all(runIds.map(waitFor));
  }

  function matrix(): MatrixRow[] {
    return store.listHarnessRepos().map((repo) => {
      const harness = store.readRepo(repo);
      const cells = {} as Record<TestSuite, MatrixCell>;
      for (const suite of SUITES) {
        const declared = harness.config.suites[suite];
        if (!declared) {
          cells[suite] = { suite, state: "unconfigured" };
          continue;
        }
        const last = latestTerminal(repo, suite);
        if (!last) {
          cells[suite] = { suite, state: "never_run" };
          continue;
        }
        const cell: MatrixCell = { suite, state: last.status, runId: last.runId, finishedAt: last.finishedAt };
        if (last.startedAt && last.finishedAt) cell.durationMs = Date.parse(last.finishedAt) - Date.parse(last.startedAt);
        if (last.totals) cell.totals = last.totals;
        if (last.coverage) cell.coverage = last.coverage;
        if (last.reason) cell.reason = last.reason;
        cells[suite] = cell;
      }
      return { repo, configured: harness.configured, profiles: harness.config.profiles.map((p) => p.name), cells };
    });
  }

  function listRuns(filter: { repo?: string; suite?: TestSuite; status?: RunStatus; limit?: number } = {}): Run[] {
    let runs = store.listRuns();
    if (filter.repo) runs = runs.filter((r) => r.repo === filter.repo);
    if (filter.suite) runs = runs.filter((r) => r.suite === filter.suite);
    if (filter.status) runs = runs.filter((r) => r.status === filter.status);
    runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return runs.slice(0, filter.limit ?? 200);
  }

  /** Ruta de artefacto legible por la API: sólo las copias registradas en el run. */
  function artifactPath(runId: string, name: string): string {
    const run = store.getRun(runId);
    if (!run) throw new HarnessError(`run desconocido: ${runId}`, "RUN_NOT_FOUND", 404);
    const match = (run.artifacts ?? []).find((a) => basename(a) === name);
    if (!match || relative(store.artifactsDir(runId), match).startsWith("..")) throw new HarnessError(`artefacto desconocido: ${name}`, "ARTIFACT_NOT_FOUND", 404);
    return match;
  }

  return {
    start,
    cancel,
    waitFor,
    waitForAll,
    matrix,
    listRuns,
    getRun: (runId: string) => store.getRun(runId),
    getBatch: (batchId: string) => store.getBatch(batchId),
    listBatches: () => store.listBatches(),
    artifactPath,
    readPublicConfig: () => store.readPublicConfig(),
    publicRepo: (repo: string) => store.publicRepo(repo),
    saveRepo: (repo: string, input: unknown) => {
      store.saveRepo(repo, input);
      return store.publicRepo(repo);
    },
    /** Retry = misma selección declarada de una corrida terminal (nunca reusa texto libre). */
    retry: (runId: string) => {
      const run = store.getRun(runId);
      if (!run) throw new HarnessError(`run desconocido: ${runId}`, "RUN_NOT_FOUND", 404);
      if (!isTerminal(run.status)) throw new HarnessError("la corrida sigue en curso", "RUN_IN_PROGRESS", 409);
      return start({ kind: "suites", repo: run.repo, profile: run.profile, suites: [run.suite] });
    },
  };
}

export type TestHarnessService = ReturnType<typeof createTestHarnessService>;
