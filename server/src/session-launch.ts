import { writeJsonAtomic } from "./atomic.js";
import { recordEvent } from "./history.js";
import { CLAUDE_TERMINAL_CMD, CODEX_CMD } from "./config.js";
import { sendWhenReady } from "./engine.js";
import { getRepoSetupCommand } from "./repo-config.js";
import { provisionWorktree } from "./provision.js";
import { listRepos, resolveCwd } from "./repos.js";
import { isSafeSessionName } from "./session-name.js";
import { cycleDirForSession, ensureCycleDir, removeCycleDir, writeFlow } from "./stages.js";
import { buildWorkflowRequestPrompt } from "./templates.js";
import { createSession, hasSession, killSession } from "./tmux.js";
import { findWorkflowCatalogItem, type WorkflowCatalogItem } from "./workflow-catalog.js";
import { addWorktree, removeWorktree, worktreePathForSession } from "./worktree.js";

export type SessionLaunchErrorCode =
  | "REPO_UNKNOWN"
  | "REPO_UNAVAILABLE"
  | "WORKFLOW_NOT_FOUND"
  | "MODE_INVALID"
  | "AGENT_INVALID"
  | "INVALID_SESSION"
  | "MANAGED_SESSION_PREFIX_REQUIRED"
  | "SESSION_ALREADY_EXISTS";

export class SessionLaunchError extends Error {
  constructor(readonly code: SessionLaunchErrorCode, message: string) {
    super(message);
  }
}

export interface ManagedSessionLaunchInput {
  repo: string;
  workflowId?: string;
  name: string;
  // The request boundary is untrusted; validation below narrows these to the public unions.
  mode?: string;
  agent?: string;
  request?: string;
}

export type SessionLaunchMode = "workflow" | "terminal";
export type TerminalAgent = "claude" | "codex";

/** Resolve the CLI only from server configuration; callers never supply shell commands. */
export function normalTerminalCommand(
  agent: TerminalAgent,
  commands = { claude: CLAUDE_TERMINAL_CMD, codex: CODEX_CMD },
): string {
  return commands[agent];
}

export interface ManagedSessionLaunchResult {
  name: string;
  repo: string;
  mode: SessionLaunchMode;
  workflowId?: string;
  agent?: TerminalAgent;
  cwd: string;
  worktree?: string;
  branch?: string;
}

export interface ManagedSessionLaunchDeps {
  listRepos: typeof listRepos;
  resolveCwd: typeof resolveCwd;
  hasSession: typeof hasSession;
  findWorkflowCatalogItem: typeof findWorkflowCatalogItem;
  worktreePathForSession: typeof worktreePathForSession;
  addWorktree: typeof addWorktree;
  removeWorktree: typeof removeWorktree;
  createSession: typeof createSession;
  killSession: typeof killSession;
  cycleDirForSession: typeof cycleDirForSession;
  ensureCycleDir: typeof ensureCycleDir;
  removeCycleDir: typeof removeCycleDir;
  writeFlow: typeof writeFlow;
  writeJsonAtomic: typeof writeJsonAtomic;
  deliverPrompt?: (session: string, prompt: string) => Promise<void>;
  /** Comando que arma el entorno del worktree; null → este repo no provisiona. */
  setupCommandFor?: (repo: string) => string | null;
  provision?: (cycle: string, cwd: string, cmd: string) => Promise<unknown>;
  logError?: (error: unknown) => void;
  /** Sólo para inspeccionar la escritura desde pruebas unitarias. */
  readWrite?: (file: string) => unknown;
}

const launchDeps: ManagedSessionLaunchDeps = {
  listRepos, resolveCwd, hasSession, findWorkflowCatalogItem, worktreePathForSession,
  addWorktree, removeWorktree, createSession, killSession, cycleDirForSession,
  ensureCycleDir, removeCycleDir, writeFlow, writeJsonAtomic, deliverPrompt: sendWhenReady,
  setupCommandFor: getRepoSetupCommand, provision: provisionWorktree,
  logError: (error) => console.error("[claude-cowork] no se pudo entregar la petición inicial", error),
};

export function validateManagedSessionLaunch(input: ManagedSessionLaunchInput, deps: Pick<ManagedSessionLaunchDeps, "listRepos"> = launchDeps): void {
  if (!deps.listRepos().includes(input.repo)) {
    throw new SessionLaunchError("REPO_UNKNOWN", "el repositorio seleccionado no está configurado");
  }
  if (!isSafeSessionName(input.name)) {
    throw new SessionLaunchError("INVALID_SESSION", "el nombre de sesión no es seguro");
  }
  if (!input.name.startsWith("cowork-")) {
    throw new SessionLaunchError("MANAGED_SESSION_PREFIX_REQUIRED", "las sesiones gestionadas deben iniciar con cowork-");
  }
  const mode = input.mode ?? "workflow";
  if (mode !== "workflow" && mode !== "terminal") {
    throw new SessionLaunchError("MODE_INVALID", "el modo de sesión no es válido");
  }
  if (mode === "terminal") {
    if (input.agent !== "claude" && input.agent !== "codex") {
      throw new SessionLaunchError("AGENT_INVALID", "elige Claude o Codex para la terminal normal");
    }
    return;
  }
  if (!input.workflowId?.trim()) {
    throw new SessionLaunchError("WORKFLOW_NOT_FOUND", "selecciona un workflow");
  }
}

function launchRecord(input: ManagedSessionLaunchInput, workflow: WorkflowCatalogItem, cwd: string, worktree: string, branch: string) {
  return { version: 1, ...input, mode: "workflow" as const, workflowName: workflow.name, cwd, worktree, branch, createdAt: Date.now() };
}

function terminalLaunchRecord(input: ManagedSessionLaunchInput, cwd: string, agent: TerminalAgent) {
  return { version: 1, repo: input.repo, name: input.name, mode: "terminal" as const, agent, cwd, createdAt: Date.now() };
}

/**
 * Create a managed tmux session whose selected workflow is frozen in the cycle directory.
 * The renderer never supplies arbitrary cwd/commands: repository resolution and the base branch
 * remain a server-side authority. Every created resource is rolled back on a later failure.
 */
export async function launchManagedSession(input: ManagedSessionLaunchInput, injected: Partial<ManagedSessionLaunchDeps> = {}): Promise<ManagedSessionLaunchResult> {
  const deps = { ...launchDeps, ...injected };
  validateManagedSessionLaunch(input, deps);
  const resolved = deps.resolveCwd(input.repo);
  if (!resolved.real) throw new SessionLaunchError("REPO_UNAVAILABLE", "el repositorio configurado no existe en disco");
  if (await deps.hasSession(input.name)) throw new SessionLaunchError("SESSION_ALREADY_EXISTS", "ya existe una sesión tmux con ese nombre");

  const mode = input.mode ?? "workflow";
  if (mode === "terminal") return launchNormalTerminalSession(input, resolved.cwd, input.agent as TerminalAgent, deps);

  const workflow = deps.findWorkflowCatalogItem(input.workflowId!);
  if (!workflow) throw new SessionLaunchError("WORKFLOW_NOT_FOUND", "el workflow seleccionado ya no existe");

  const branch = `ronin/${input.name}`;
  const worktree = deps.worktreePathForSession(resolved.cwd, input.name);
  const cycle = deps.cycleDirForSession(input.name);
  let worktreeCreated = false;
  let tmuxCreated = false;
  let cycleCreated = false;
  try {
    await deps.addWorktree(resolved.cwd, worktree, branch, "main");
    worktreeCreated = true;
    await deps.createSession(input.name, worktree);
    tmuxCreated = true;
    deps.ensureCycleDir(cycle);
    cycleCreated = true;
    deps.writeFlow(cycle, workflow.config);
    deps.writeJsonAtomic(`${cycle}/launch.json`, launchRecord(input, workflow, resolved.cwd, worktree, branch));
    // El worktree nace pelado (.venv y node_modules están gitignorados): sin esto, la copia de la
    // sesión no puede correr sus propias pruebas. Va en SEGUNDO PLANO —instalar dependencias son
    // minutos— y su fallo se reporta sin tumbar el lanzamiento, igual que la entrega del prompt.
    const setup = deps.setupCommandFor?.(input.repo);
    if (setup && deps.provision) {
      void deps.provision(cycle, worktree, setup).catch((error) => deps.logError?.(error));
    }

    const request = input.request?.trim();
    if (request && deps.deliverPrompt) {
      const title = request.split(/\r?\n/, 1)[0].slice(0, 70);
      void deps.deliverPrompt(input.name, buildWorkflowRequestPrompt({ workflow: workflow.config, cycle, repo: input.repo, request, title, key: input.name }))
        .catch((error) => deps.logError?.(error));
    }
    recordEvent({ type: "launch", key: input.name, title: input.request?.split(/\r?\n/, 1)[0] || input.name, repo: input.repo, source: "session", request: input.request });
    return { name: input.name, repo: input.repo, mode: "workflow", workflowId: workflow.id, cwd: resolved.cwd, worktree, branch };
  } catch (error) {
    if (tmuxCreated) await deps.killSession(input.name);
    if (cycleCreated) deps.removeCycleDir(cycle);
    if (worktreeCreated) await deps.removeWorktree(resolved.cwd, worktree, branch);
    throw error;
  }
}

/** Launch a managed, independent CLI terminal in the selected repository (no worktree/flow). */
async function launchNormalTerminalSession(
  input: ManagedSessionLaunchInput,
  cwd: string,
  agent: TerminalAgent,
  deps: ManagedSessionLaunchDeps,
): Promise<ManagedSessionLaunchResult> {
  const cycle = deps.cycleDirForSession(input.name);
  let tmuxCreated = false;
  let cycleCreated = false;
  try {
    await deps.createSession(input.name, cwd, normalTerminalCommand(agent));
    tmuxCreated = true;
    // The cycle dir marks the terminal as managed, enabling the same Attach/pane controls.
    deps.ensureCycleDir(cycle);
    cycleCreated = true;
    deps.writeJsonAtomic(`${cycle}/launch.json`, terminalLaunchRecord(input, cwd, agent));
    recordEvent({ type: "launch", key: input.name, title: input.request?.split(/\r?\n/, 1)[0] || input.name, repo: input.repo, source: "session", request: input.request });
    return { name: input.name, repo: input.repo, mode: "terminal", agent, cwd };
  } catch (error) {
    if (tmuxCreated) await deps.killSession(input.name);
    if (cycleCreated) deps.removeCycleDir(cycle);
    throw error;
  }
}
