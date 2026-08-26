import { writeJsonAtomic } from "./atomic.js";
import { CLAUDE_TERMINAL_CMD, CODEX_CMD } from "./config.js";
import { listRepos, resolveCwd } from "./repos.js";
import { isSafeSessionName } from "./session-name.js";
import { cycleDirForSession, ensureCycleDir, removeCycleDir, writeFlow } from "./stages.js";
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

export function validateManagedSessionLaunch(input: ManagedSessionLaunchInput): void {
  if (!listRepos().includes(input.repo)) {
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
export async function launchManagedSession(input: ManagedSessionLaunchInput): Promise<ManagedSessionLaunchResult> {
  validateManagedSessionLaunch(input);
  const resolved = resolveCwd(input.repo);
  if (!resolved.real) throw new SessionLaunchError("REPO_UNAVAILABLE", "el repositorio configurado no existe en disco");
  if (await hasSession(input.name)) throw new SessionLaunchError("SESSION_ALREADY_EXISTS", "ya existe una sesión tmux con ese nombre");

  const mode = input.mode ?? "workflow";
  if (mode === "terminal") return launchNormalTerminalSession(input, resolved.cwd, input.agent as TerminalAgent);

  const workflow = findWorkflowCatalogItem(input.workflowId!);
  if (!workflow) throw new SessionLaunchError("WORKFLOW_NOT_FOUND", "el workflow seleccionado ya no existe");

  const branch = `ronin/${input.name}`;
  const worktree = worktreePathForSession(resolved.cwd, input.name);
  const cycle = cycleDirForSession(input.name);
  let worktreeCreated = false;
  let tmuxCreated = false;
  let cycleCreated = false;
  try {
    await addWorktree(resolved.cwd, worktree, branch, "main");
    worktreeCreated = true;
    await createSession(input.name, worktree);
    tmuxCreated = true;
    ensureCycleDir(cycle);
    cycleCreated = true;
    writeFlow(cycle, workflow.config);
    writeJsonAtomic(`${cycle}/launch.json`, launchRecord(input, workflow, resolved.cwd, worktree, branch));
    return { name: input.name, repo: input.repo, mode: "workflow", workflowId: workflow.id, cwd: resolved.cwd, worktree, branch };
  } catch (error) {
    if (tmuxCreated) await killSession(input.name);
    if (cycleCreated) removeCycleDir(cycle);
    if (worktreeCreated) await removeWorktree(resolved.cwd, worktree, branch);
    throw error;
  }
}

/** Launch a managed, independent CLI terminal in the selected repository (no worktree/flow). */
async function launchNormalTerminalSession(
  input: ManagedSessionLaunchInput,
  cwd: string,
  agent: TerminalAgent,
): Promise<ManagedSessionLaunchResult> {
  const cycle = cycleDirForSession(input.name);
  let tmuxCreated = false;
  let cycleCreated = false;
  try {
    await createSession(input.name, cwd, normalTerminalCommand(agent));
    tmuxCreated = true;
    // The cycle dir marks the terminal as managed, enabling the same Attach/pane controls.
    ensureCycleDir(cycle);
    cycleCreated = true;
    writeJsonAtomic(`${cycle}/launch.json`, terminalLaunchRecord(input, cwd, agent));
    return { name: input.name, repo: input.repo, mode: "terminal", agent, cwd };
  } catch (error) {
    if (tmuxCreated) await killSession(input.name);
    if (cycleCreated) removeCycleDir(cycle);
    throw error;
  }
}
