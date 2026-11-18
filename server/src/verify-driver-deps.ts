import { deliverPromptWhenReady } from "./engine.js";
import type { GitPort, RepoHead } from "./gate-cache.js";
import { getRepoGate, type RepoGate } from "./repo-config.js";
import { readLaunchRecord, readTmuxInventory } from "./sessions.js";
import { readGateSettings, type GateSettings } from "./settings.js";
import { cycleDirForSession, detectStage, readFlow } from "./stages.js";
import { realGateDeps, type DriverDeps, type GateStage, type LaunchInfo } from "./verify-driver.js";
import { resolveFlow } from "./workflow.js";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, resolve, sep } from "node:path";

type InventorySession = {
  name: string;
  kind: "managed" | "foreign";
  attention?: { level?: string };
  panes?: Array<{ id: string; windowIndex: number; role: string | null }>;
};

/**
 * El pane conductor de una sesión, como `%N`: el `driver` del arreglo de 4 panes si existe; si no,
 * el ÚNICO pane de la ventana 0 (la que creó Ronin; las demás las abre el conductor para delegar).
 * `%N` es estable mientras el pane viva y tmux no lo reutiliza; `-t <sesión>` iría al pane activo,
 * que puede ser otro agente. null si no hay uno inequívoco.
 */
export function conductorPane(session: InventorySession | undefined): string | null {
  const panes = session?.panes ?? [];
  const driver = panes.filter((pane) => pane.role === "driver");
  if (driver.length === 1) return driver[0]!.id;
  const ventana0 = panes.filter((pane) => pane.windowIndex === 0);
  return ventana0.length === 1 ? ventana0[0]!.id : null;
}

export interface VerifyDriverDepSources {
  readTmuxInventory(): Promise<{ sessions: InventorySession[]; diagnostic: unknown | null }>;
  readLaunch(name: string): unknown | null | undefined;
  readFlow(cycle: string): { stages: GateStage[] } | null;
  resolveFlow(stageKeys: undefined, repo: string): { stages: GateStage[]; verifyAfter: string[] };
  cycleDirForSession(name: string): string;
  detectStage(cycle: string, order: string[]): string | null;
  gateSettings(): GateSettings;
  repoGate(repo: string): RepoGate;
  /** Escribe un prompt en ese pane (`%N`) cuando su CLI está lista; false/throw = no llegó. */
  deliverPrompt(target: string, text: string): Promise<boolean>;
  /** Integración opcional: sólo se cablea cuando el watcher de main-health ya existe. */
  ensureMainMeasured?(repo: string, sha: string): unknown;
  /** Frontera de filesystem para verificar que ningún symlink saque el subrepo del worktree. */
  realPath?(path: string): string;
}

/** Carpeta propia de reportes del gate de Ronin, relativa al worktree (la lee unit-gate.sh). */
export const GATE_REPORTS_DIR = "reports/ronin-gate";

/** Timeout y entorno del gate: el override del repo gana; xdist y el cupo global llegan al script. */
export function gateConfigFrom(global: GateSettings, repo: RepoGate): { timeoutMs: number; env: Record<string, string> } {
  return {
    timeoutMs: (repo.timeoutMin ?? global.timeoutMin) * 60_000,
    env: {
      UNIT_GATE_REPORTS_DIR: GATE_REPORTS_DIR,
      UNIT_GATE_MAX_SUITES: String(global.maxConcurrent),
      ...(repo.xdist ? { UNIT_GATE_XDIST: String(repo.xdist) } : {}),
    },
  };
}

function launchInfo(raw: unknown): LaunchInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { mode, repo, worktree } = raw as { mode?: unknown; repo?: unknown; worktree?: unknown };
  if ((mode !== "workflow" && mode !== "terminal") || typeof repo !== "string") return null;
  return typeof worktree === "string" ? { mode, repo, worktree } : { mode, repo };
}

const CANONICAL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeRepo(repo: string): boolean {
  return repo.length <= 61
    && SAFE_REPO.test(repo)
    && !repo.includes("..")
    && !repo.endsWith(".")
    && !repo.toLowerCase().endsWith(".lock");
}

function canonicalRepoFromRemote(remote: string): string | null {
  const value = remote.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!value || /[\r\n\0]/.test(value)) return null;
  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf(":"));
  const tail = value.slice(separator + 1);
  const repo = tail.replace(/\.git$/i, "");
  return safeRepo(repo) ? repo : null;
}

interface MainMergeBaseExecOptions {
  cwd: string;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeout: number;
}

type MainMergeBaseExecFile = (
  command: string,
  args: string[],
  options: MainMergeBaseExecOptions,
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

export interface MainMergeBaseGitPortDeps {
  execFile?: MainMergeBaseExecFile;
  env?: Readonly<NodeJS.ProcessEnv>;
  timeoutMs?: number;
}

/** Git acotado y no interactivo, aislado del puerto que usa el resto del gate. */
export function createMainMergeBaseGitPort(deps: MainMergeBaseGitPortDeps = {}): GitPort {
  const runExec: MainMergeBaseExecFile = deps.execFile ?? ((command, args, options, callback) => {
    execFile(command, args, options, (error, stdout) => callback(error, String(stdout ?? "")));
  });
  const timeoutMs = deps.timeoutMs ?? 30_000;
  return {
    run(args, cwd) {
      const inherited = deps.env ?? process.env;
      const env: NodeJS.ProcessEnv = {
        ...inherited,
        GIT_TERMINAL_PROMPT: "0",
        ...(inherited.GIT_SSH_COMMAND === undefined && inherited.GIT_SSH === undefined
          ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" }
          : {}),
      };
      return new Promise((resolveResult) => {
        try {
          runExec("git", args, { cwd, encoding: "utf8", env, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }, (error, stdout) => {
            resolveResult({ ok: !error, out: String(stdout ?? "") });
          });
        } catch {
          resolveResult({ ok: false, out: "" });
        }
      });
    },
  };
}

export const mainMergeBaseGitPort = createMainMergeBaseGitPort();

/** Resuelve el main común usando sólo el puerto Git; todo dato dudoso falla cerrado. */
export async function resolveMainMergeBase(
  worktree: string,
  head: RepoHead,
  git: GitPort = mainMergeBaseGitPort,
  realPath: (path: string) => string = realpathSync,
): Promise<{ repo: string; sha: string } | null> {
  if (!safeRepo(head.repo) || !CANONICAL_SHA.test(head.sha)) return null;
  try {
    const lexicalRoot = resolve(worktree);
    const lexicalCwd = basename(lexicalRoot) === head.repo ? lexicalRoot : resolve(lexicalRoot, head.repo);
    const root = resolve(realPath(lexicalRoot));
    const cwd = resolve(realPath(lexicalCwd));
    if (cwd !== root && !cwd.startsWith(`${root}${sep}`)) return null;
    const fetched = await git.run(["fetch", "-q", "origin", "main"], cwd);
    if (!fetched.ok) return null;
    const remote = await git.run(["remote", "get-url", "origin"], cwd);
    if (!remote.ok) return null;
    const repo = canonicalRepoFromRemote(remote.out);
    if (!repo) return null;
    const base = await git.run(["merge-base", head.sha, "origin/main"], cwd);
    const sha = base.out.trim();
    if (!base.ok || !CANONICAL_SHA.test(sha)) return null;
    return { repo, sha };
  } catch {
    return null;
  }
}

/** Arma el driver real, dejando las fronteras de tmux y disco inyectables para pruebas. */
export function createVerifyDriverDeps(sources: VerifyDriverDepSources): DriverDeps {
  return {
    listSessions: async () => {
      const inventory = await sources.readTmuxInventory();
      if (inventory.diagnostic) return [];
      return inventory.sessions
        .filter((session) => session.kind === "managed")
        .map((session) => ({ name: session.name, busy: session.attention?.level === "working" }));
    },
    launchOf: (session) => {
      try {
        return launchInfo(sources.readLaunch(session));
      } catch {
        return null;
      }
    },
    flowFor: (session, repo) => sources.readFlow(sources.cycleDirForSession(session))?.stages ?? sources.resolveFlow(undefined, repo).stages,
    cycleFor: sources.cycleDirForSession,
    detect: sources.detectStage,
    ...realGateDeps,
    mainMergeBase: (worktree, head) => resolveMainMergeBase(worktree, head, mainMergeBaseGitPort, sources.realPath ?? realpathSync),
    ...(sources.ensureMainMeasured ? { ensureMainMeasured: sources.ensureMainMeasured } : {}),
    // Se lee en cada llamada: un cambio en settings.json o repo-config.json aplica sin reiniciar.
    gateConfig: (repo) => gateConfigFrom(sources.gateSettings(), sources.repoGate(repo)),
    maxConcurrent: () => sources.gateSettings().maxConcurrent,
    maxConcurrentLight: () => sources.gateSettings().maxConcurrentLight,
    // El veredicto del gate de merge al pane conductor, resuelto en vivo. Cualquier fallo —sin
    // conductor inequívoco, tmux ilegible, CLI ausente— es `false`: el driver lo anota como
    // `notify: "failed"` y no reintenta. Nunca cae al pane activo de la sesión.
    notify: async (session, text) => {
      try {
        const inventory = await sources.readTmuxInventory();
        if (inventory.diagnostic) return false;
        const target = conductorPane(inventory.sessions.find((entry) => entry.name === session && entry.kind === "managed"));
        if (!target) return false;
        return (await sources.deliverPrompt(target, text)) === true;
      } catch {
        return false;
      }
    },
    logError: (error) => console.error("[claude-cowork]", error),
  };
}

export const realVerifyDriverDeps = createVerifyDriverDeps({
  readTmuxInventory,
  readLaunch: readLaunchRecord,
  readFlow,
  resolveFlow,
  cycleDirForSession,
  detectStage,
  gateSettings: () => readGateSettings(),
  repoGate: getRepoGate,
  // Captura y envío usan el mismo `%N`: deliverPromptWhenReady apunta todo a ese target.
  deliverPrompt: (target, text) => deliverPromptWhenReady(target, text),
});
