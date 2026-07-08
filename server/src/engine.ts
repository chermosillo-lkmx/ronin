import { basename } from "node:path";
import { AUTOSUBMIT, MODE } from "./config.js";
import { fetchClickUpDescription } from "./clickup.js";
import { recordEvent, truncate } from "./history.js";
import { listRepos, resolveCwd } from "./repos.js";
import {
  cycleDirForSession,
  detectStage,
  ensureCycleDir,
  markModelSwitched,
  markModelSwitchFailed,
  markVerifierSpawned,
  modelSwitched,
  modelSwitchFailed,
  readEvidence,
  readModelsInfo,
  readVerifyState,
  removeCycleDir,
  verifierSpawned,
  verifyPassed,
  writeModelsInfo,
  writeVerifyState,
} from "./stages.js";
import { runVerify, verifyOutcome, verifyRunDecision } from "./verify.js";
import { writeCurlEnv } from "./curl-config.js";
import { getRepoPlannerModel, getRepoStartCommand, getRepoVars, getRepoWorkerModel } from "./repo-config.js";
import {
  currentModelFromPane,
  isModelPickerOpen,
  launchSwitchEnabled,
  modelFamily,
  modelSwitchConfirmed,
  pickerOffersModel,
  sanitizeModel,
  withModel,
} from "./models.js";
import {
  addWorktree,
  branchForSession,
  isGitRepo,
  reconcileWorktrees,
  removeWorktree,
  worktreeExists,
  worktreePathForSession,
} from "./worktree.js";
import { getAction, getActions } from "./actions.js";
import { buildActionPrompt, buildResearchPrompt, buildVerifierPrompt, buildWorkerPrompt } from "./templates.js";
import {
  eligibleVerifyStages,
  gateHoldsDone,
  liveMapFor,
  resolveFlow,
  shouldSwitchModel,
  stepperFor,
  verifyGateCap,
  type WfStage,
} from "./workflow.js";
import { stopTtyd } from "./ttyd.js";
import { addTask, emit, findTask, findWorker, nextWorkerLabel, removeWorker, setMode, tasks, workers } from "./state.js";
import {
  capturePane,
  createSession,
  hasSession,
  isBusy,
  killSession,
  lastMeaningfulLine,
  listSessions,
  openTerminal,
  parseContextPressure,
  sendKeys,
  sendText,
  tmuxAvailable,
} from "./tmux.js";
import type { CustomAction, Task, TaskStatus, Worker, WorkerState } from "./types.js";

function logEvent(type: "launch" | "complete" | "stop", task: Task, evidence?: string): void {
  recordEvent({
    type, key: task.key, title: task.title, source: task.source, repo: task.repo,
    body: task.body ? truncate(task.body) : undefined,
    evidence: evidence || undefined,
  });
}

/** Snapshot compacto de la evidencia del worker (summary→verdict→research→curl). Nunca lanza. */
function captureEvidence(worker: Worker): string | undefined {
  if (!worker.cycle) return undefined;
  try {
    const ev = readEvidence(worker.cycle);
    const text = ev.summary ?? ev.verdict ?? ev.research ?? ev.curl;
    return text ? truncate(text) : undefined;
  } catch {
    return undefined;
  }
}

let activeMode: "simulated" | "live" = MODE;

// ============================================================
//  SIMULATED MODE  (Fase 0) — timer-driven pipeline
// ============================================================

interface Stage {
  key: string;
  label: string;
  task: TaskStatus;
  worker: WorkerState;
}

export const PIPELINE: Stage[] = [
  { key: "planning",     label: "📋 escribiendo plan",     task: "running", worker: "busy" },
  { key: "codex-plan",   label: "🔥 codex revisa el plan", task: "review",  worker: "review" },
  { key: "implementing", label: "⌨️ implementando (TDD)",   task: "running", worker: "busy" },
  { key: "codex-diff",   label: "🔥 codex revisa el diff", task: "review",  worker: "review" },
  { key: "kb-tests",     label: "✅ KB update + tests",     task: "running", worker: "busy" },
  { key: "curl",         label: "🌐 pruebas curl vs dev",  task: "review",  worker: "busy" },
  { key: "verify",       label: "🔎 verificando resultados", task: "review", worker: "review" },
  { key: "done",         label: "✓ completado",            task: "done",    worker: "done" },
];

const stageIndex = new Map<string, number>();
const TARGET_ACTIVE = 2;

// Stepper fijo del worker de investigación (no usa el workflow componible). verifyAfter=null ⇒ sin verificador.
const RESEARCH_STAGES: WfStage[] = [
  { key: "investigating", label: "Investigando", icon: "🔍" },
  { key: "plan",          label: "Plan",         icon: "📝" },
  { key: "done",          label: "Done",         icon: "✓"  },
];
const RESEARCH_FLOW: { stages: WfStage[]; verifyAfter: string | null } = { stages: RESEARCH_STAGES, verifyAfter: null };
// Per-worker resolved flow (the per-launch enabled stages). Drives that worker's
// prompt, stepper, stage detection and verifier. Missing → fall back to the global
// workflow (e.g. workers rediscovered after a restart).
const workerFlow = new Map<string, { stages: WfStage[]; verifyAfter: string | null }>();
const stepKeys = (f: { stages: WfStage[]; verifyAfter: string | null }) =>
  stepperFor(f.stages, f.verifyAfter).map((s) => s.key);
const stepSteps = (f: { stages: WfStage[]; verifyAfter: string | null }) =>
  stepperFor(f.stages, f.verifyAfter).map((s) => ({ key: s.key, label: s.label, icon: s.icon }));

// Un worker "posee" el tablero (muta task.workerId + task.status) sólo si es un worker de tarea
// normal. research Y action están DESACOPLADOS: nunca tocan el estado del tablero (Lanzar sigue
// disponible, los estados nunca se corrompen). El verificador hereda el kind de su padre (spawnVerifier).
const ownsBoard = (w: Worker): boolean => w.kind !== "research" && w.kind !== "action";
// Auto-seed + recycle the board only with mock data. With real tasks we still
// advance any worker the user launches, but we never churn their real statuses.
let autoChurn = false;

function applyStage(worker: Worker, idx: number): void {
  const stage = PIPELINE[idx];
  stageIndex.set(worker.id, idx);
  worker.stage = stage.label;
  worker.state = stage.worker;
  const task = findTask(worker.taskId);
  if (task) task.status = stage.task;
}

function launchSimulated(taskId: string): Worker | null {
  const task = findTask(taskId);
  if (!task) return null;
  if (task.workerId) return findWorker(task.workerId) ?? null;

  const worker: Worker = {
    id: `w${Date.now().toString(36)}${Math.floor(performance.now()) % 1000}`,
    label: nextWorkerLabel(),
    repo: task.repo,
    taskId: task.id,
    state: "starting",
    stage: "⏳ arrancando claude…",
    startedAt: Date.now(),
  };
  workers.push(worker);
  task.workerId = worker.id;
  stageIndex.set(worker.id, -1);
  logEvent("launch", task);
  emit();
  return worker;
}

function completeWorker(worker: Worker): void {
  const task = findTask(worker.taskId);
  if (task) {
    task.status = "done";
    task.workerId = undefined;
    logEvent("complete", task, captureEvidence(worker));
  }
  stageIndex.delete(worker.id);
  removeWorker(worker.id);
  if (autoChurn) {
    refillQueue();
    pumpWorkers();
  }
}

function refillQueue(): void {
  const hasWork = tasks.some((t) => t.status === "queued" || t.status === "triage");
  if (hasWork) return;
  const recyclable = tasks.find((t) => t.status === "done");
  if (recyclable) {
    recyclable.status = "queued";
    recyclable.workerId = undefined;
  }
}

function pumpWorkers(): void {
  while (workers.length < TARGET_ACTIVE) {
    const next = tasks.find((t) => t.status === "queued");
    if (!next) break;
    launchSimulated(next.id);
  }
}

function simTick(rng: () => number): void {
  let changed = false;
  for (const worker of [...workers]) {
    if (!ownsBoard(worker)) continue; // research/action no usan el PIPELINE simulado (desacoplados)
    const idx = stageIndex.get(worker.id) ?? -1;
    if (idx < 0) {
      applyStage(worker, 0);
      changed = true;
      continue;
    }
    if (idx >= PIPELINE.length - 1) {
      completeWorker(worker);
      changed = true;
      continue;
    }
    if (rng() < 0.45) {
      applyStage(worker, idx + 1);
      changed = true;
    }
  }
  if (changed) emit();
}

function seedInitialWorkers(): void {
  const seedable = tasks.filter((t) => t.status !== "done").slice(0, 2);
  seedable.forEach((t, i) => {
    const w = launchSimulated(t.id);
    if (w) applyStage(w, i === 0 ? 0 : 3);
  });
}

function startSimTick(): void {
  let seed = 1337;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  setInterval(() => simTick(rng), 2500);
}

// ============================================================
//  LIVE MODE  (Fase 1) — real tmux + claude, capture-pane driven
// ============================================================

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Dialogs that block input on boot (trust check, bypass-mode warning) — accept them.
const CONFIRM = /do you trust|trust the files|quick safety check|don't ask again|bypass permissions mode|i accept|press enter to continue|yes, proceed|continue\?/i;
// Signals that claude's main input is ready.
const READY = /for shortcuts|esc to interrupt|bypass permissions on|auto mode on|accept edits on|plan mode on/i;

/**
 * Send the prompt once claude is actually ready to receive it: poll the pane,
 * dismiss boot dialogs (trust / bypass warning), then type + submit.
 */
async function sendWhenReady(session: string, prompt: string): Promise<void> {
  for (let i = 0; i < 24; i++) {
    await delay(700);
    let pane = "";
    try {
      pane = await capturePane(session);
    } catch {
      continue;
    }
    if (CONFIRM.test(pane)) {
      await sendText(session, "", true).catch(() => {}); // Enter = accept default
      continue;
    }
    if (READY.test(pane)) {
      await sendText(session, prompt, AUTOSUBMIT).catch(() => {});
      return;
    }
  }
  await sendText(session, prompt, AUTOSUBMIT).catch(() => {}); // fallback
}

/** tmux session names can't contain dots/colons; keep it readable and unique. */
function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
}

/**
 * The session that OWNS a worktree: for a verifier (`<parent>-verify` / `<parent>-verify-2`)
 * it's the parent session (strip the suffix); for a normal worker it's the session itself.
 * Used so a rediscovered verifier reconstructs the PARENT's worktree path (P1g).
 */
export function owningSession(session: string): string {
  return session.replace(/-verify(?:-\d+)?$/, "");
}
async function uniqueSession(base: string): Promise<string> {
  let name = `cowork-${base}`;
  for (let n = 2; await hasSession(name); n++) name = `cowork-${base}-${n}`;
  return name;
}

/** Per-launch overrides (from the Lanzar modal). Sanitized server-side; local-only trust boundary. */
export interface LaunchOpts {
  plannerModel?: string;
  workerModel?: string;
}

async function launchLive(taskId: string, stageKeys?: string[], opts: LaunchOpts = {}): Promise<Worker | null> {
  const task = findTask(taskId);
  if (!task) return null;
  if (task.workerId) return findWorker(task.workerId) ?? null;

  const { cwd, real } = resolveCwd(task.repo);
  const id = `w${Date.now().toString(36)}`;
  const session = await uniqueSession(sanitizeKey(task.key));
  const flow = resolveFlow(stageKeys, task.repo); // per-launch stages, over the repo's workflow (or default)
  const worker: Worker = {
    id,
    label: nextWorkerLabel(),
    repo: task.repo,
    taskId: task.id,
    state: "starting",
    stage: "⏳ abriendo claude…",
    startedAt: Date.now(),
    session,
    cwd,
    cycle: cycleDirForSession(session),
    stages: stepSteps(flow),
  };
  workerFlow.set(id, flow);
  workers.push(worker);
  task.workerId = worker.id;
  task.status = "running";
  logEvent("launch", task);
  emit();

  // Fresh launch: wipe any stale cycle dir left by a prior crash reusing the same
  // deterministic session name (stale sentinels/latches would misreport the stage or
  // skip the plan→impl model switch — F3).
  removeCycleDir(worker.cycle!);
  ensureCycleDir(worker.cycle!);
  // F0: Planner model injected as --model over the repo's start command (existing --model wins).
  const plannerModel = sanitizeModel(opts.plannerModel || getRepoPlannerModel(task.repo));
  // Switch to the Worker model at plan→impl only for real implementer launches (never PR).
  writeModelsInfo(worker.cycle!, {
    worker: sanitizeModel(opts.workerModel || getRepoWorkerModel(task.repo)),
    switchEnabled: launchSwitchEnabled(task.source),
  });
  const vars = getRepoVars(task.repo); // per-repo test vars (merged into curl.env + {var:KEY} in the prompt)
  writeCurlEnv(task.repo, worker.cycle!, vars); // per-project dev creds + repo vars for the curl stage
  // Enrich the prompt with the full ticket description (best-effort, ClickUp only).
  if (task.source === "clickup" && !task.body) {
    const desc = await fetchClickUpDescription(task.id);
    if (desc) task.body = desc;
  }
  // P1: isolate this worker in an ephemeral git worktree so two workers over the same repo
  // don't collide. Fallback to the repo root (with a visible note) if the repo isn't git or
  // the worktree can't be created — never abort the launch.
  let launchCwd = cwd;
  let worktreeNote: string | null = null;
  if (real && (await isGitRepo(cwd))) {
    const wt = worktreePathForSession(cwd, session);
    try {
      await addWorktree(cwd, wt, branchForSession(session));
      worker.worktree = wt;
      worker.cwd = wt;
      launchCwd = wt;
    } catch {
      worktreeNote = "⚠️ worktree no disponible · repo raíz compartido";
    }
  }
  try {
    await createSession(session, launchCwd, withModel(getRepoStartCommand(task.repo), plannerModel));
    const prompt = buildWorkerPrompt(task, worker.cycle!, flow, vars);
    // Send once claude's input is actually ready (handles boot lag + dialogs).
    void sendWhenReady(session, prompt);
    worker.state = "idle";
    worker.stage =
      worktreeNote ??
      (real
        ? AUTOSUBMIT
          ? "💬 enviando requerimiento…"
          : "💬 template en el prompt (revisa y Enter)"
        : "⚠️ repo no encontrado · cwd de respaldo");
  } catch {
    // P1f: don't leak the worktree if the session failed to start.
    if (worker.worktree) {
      void removeWorktree(cwd, worker.worktree, branchForSession(session)).catch(() => {});
      worker.worktree = undefined;
    }
    worker.state = "idle";
    worker.stage = "✖ error al crear la sesión tmux";
  }
  emit();
  return worker;
}

async function launchResearchLive(taskId: string): Promise<Worker | null> {
  const task = findTask(taskId);
  if (!task) return null;
  const existing = workers.find((w) => w.taskId === task.id && w.kind === "research");
  if (existing) return existing; // dedup (no ocupamos task.workerId)

  const { cwd, real } = resolveCwd(task.repo);
  const id = `r${Date.now().toString(36)}`;
  const session = await uniqueSession(sanitizeKey(`${task.key}-research`));
  const flow = RESEARCH_FLOW;
  const worker: Worker = {
    id,
    label: nextWorkerLabel(),
    kind: "research",
    repo: task.repo,
    taskId: task.id,
    state: "starting",
    stage: "🔍 investigando…",
    startedAt: Date.now(),
    session,
    cwd,
    cycle: cycleDirForSession(session),
    stages: stepSteps(flow),
  };
  workerFlow.set(id, flow); // CRÍTICO: pollLive detecta investigating/plan/done vía este flow
  workers.push(worker);
  // NO se toca task.workerId ni task.status (decoupling — Lanzar sigue disponible).
  emit();

  ensureCycleDir(worker.cycle!); // read-only: sin writeCurlEnv/getRepoVars
  if (task.source === "clickup" && !task.body) {
    const desc = await fetchClickUpDescription(task.id);
    if (desc) task.body = desc;
  }
  try {
    // Research is read-only → stays on the Planner model the whole run (no plan→impl switch).
    await createSession(session, cwd, withModel(getRepoStartCommand(task.repo), sanitizeModel(getRepoPlannerModel(task.repo))));
    void sendWhenReady(session, buildResearchPrompt(task, worker.cycle!));
    worker.state = "idle";
    worker.stage = real ? "🔍 investigando el ticket…" : "⚠️ repo no encontrado · cwd de respaldo";
  } catch {
    worker.state = "idle";
    worker.stage = "✖ error al crear la sesión tmux";
  }
  emit();
  return worker;
}

function launchResearchSimulated(taskId: string): Worker | null {
  const task = findTask(taskId);
  if (!task) return null;
  const existing = workers.find((w) => w.taskId === task.id && w.kind === "research");
  if (existing) return existing;
  const worker: Worker = {
    id: `r${Date.now().toString(36)}${Math.floor(performance.now()) % 1000}`,
    label: nextWorkerLabel(),
    kind: "research",
    repo: task.repo,
    taskId: task.id,
    state: "idle",
    stage: "🔍 investigando… (simulado)",
    startedAt: Date.now(),
    stages: stepSteps(RESEARCH_FLOW),
  };
  workers.push(worker); // sin stageIndex ⇒ simTick lo salta
  emit();
  return worker;
}

export async function launchResearch(taskId: string): Promise<Worker | null> {
  return activeMode === "live" ? launchResearchLive(taskId) : launchResearchSimulated(taskId);
}

// ---- Acciones custom (desacopladas del tablero como research) ----

/**
 * Recupera la key de una acción desde el segmento sanitizado del nombre de sesión (tras "-action-",
 * ya sin el "-verify" del verificador). El segmento puede llevar un sufijo "-<n>" de uniqueSession
 * (colisión) que es indistinguible de un key que termina en dígito → se resuelve contra el registry:
 * match exacto, o el key más largo tal que seg empieza con `${key}-`. Fallback: el segmento crudo
 * (worker sigue kind:"action" ⇒ desacoplado; sólo cae al flow global para su stepper).
 */
function matchActionKey(seg: string): string {
  const keys = getActions().map((a) => a.key);
  const exact = keys.find((k) => k === seg);
  if (exact) return exact;
  const pref = keys.filter((k) => seg.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return pref ?? seg;
}

/** Flow de una acción: sus etapas propias, o el workflow global/por-repo si inheritWorkflow. */
function actionFlow(action: CustomAction, repo: string): { stages: WfStage[]; verifyAfter: string | null } {
  return action.inheritWorkflow
    ? resolveFlow(undefined, repo)
    : { stages: action.stages, verifyAfter: action.verifyAfter };
}

async function launchActionLive(taskId: string, actionKey: string): Promise<Worker | null> {
  const task = findTask(taskId);
  if (!task) return null; // 404 (tarea inexistente)
  const action = getAction(actionKey);
  if (!action) return null; // 404 (acción inexistente)
  // dedup por (taskId, kind:"action", actionKey): una tarea puede tener varias acciones + research + task worker
  const existing = workers.find((w) => w.taskId === task.id && w.kind === "action" && w.actionKey === action.key);
  if (existing) return existing; // NO ocupamos task.workerId

  const { cwd, real } = resolveCwd(task.repo);
  const id = `a${Date.now().toString(36)}`;
  // Sanitiza task.key y action.key POR SEPARADO (cada parte capada a 40) para que el marcador literal
  // "-action-" NUNCA se trunque — rediscover depende de él para clasificar el worker como desacoplado.
  const session = await uniqueSession(`${sanitizeKey(task.key)}-action-${sanitizeKey(action.key)}`);
  const flow = actionFlow(action, task.repo);
  const worker: Worker = {
    id,
    label: nextWorkerLabel(),
    kind: "action",
    actionKey: action.key,
    repo: task.repo,
    taskId: task.id,
    state: "starting",
    stage: `${action.icon} ${action.label}…`,
    startedAt: Date.now(),
    session,
    cwd,
    cycle: cycleDirForSession(session),
    stages: stepSteps(flow),
  };
  workerFlow.set(id, flow); // CRÍTICO: pollLive detecta etapas + dispara el verificador vía este flow
  workers.push(worker);
  // NO se toca task.workerId ni task.status (desacople — Lanzar sigue disponible).
  emit();

  ensureCycleDir(worker.cycle!);
  const vars = getRepoVars(task.repo); // {var:KEY}
  if (!action.readOnly) writeCurlEnv(task.repo, worker.cycle!, vars); // write-action → creds; read-only omite (como research)
  if (task.source === "clickup" && !task.body) {
    const desc = await fetchClickUpDescription(task.id);
    if (desc) task.body = desc;
  }
  try {
    // Custom actions start (like every launch) on the Planner model; no plan→impl switch (decoupled).
    await createSession(session, cwd, withModel(getRepoStartCommand(task.repo), sanitizeModel(getRepoPlannerModel(task.repo))));
    void sendWhenReady(session, buildActionPrompt(action, task, worker.cycle!, flow, vars));
    worker.state = "idle";
    worker.stage = real ? `${action.icon} ${action.label}` : "⚠️ repo no encontrado · cwd de respaldo";
  } catch {
    worker.state = "idle";
    worker.stage = "✖ error al crear la sesión tmux";
  }
  emit();
  return worker;
}

function launchActionSimulated(taskId: string, actionKey: string): Worker | null {
  const task = findTask(taskId);
  if (!task) return null;
  const action = getAction(actionKey);
  if (!action) return null;
  const existing = workers.find((w) => w.taskId === task.id && w.kind === "action" && w.actionKey === action.key);
  if (existing) return existing;
  const flow = actionFlow(action, task.repo);
  const worker: Worker = {
    id: `a${Date.now().toString(36)}${Math.floor(performance.now()) % 1000}`,
    label: nextWorkerLabel(),
    kind: "action",
    actionKey: action.key,
    repo: task.repo,
    taskId: task.id,
    state: "idle",
    stage: `${action.icon} ${action.label} (simulado)`,
    startedAt: Date.now(),
    stages: stepSteps(flow),
  };
  workers.push(worker); // sin stageIndex ⇒ simTick lo salta (guard #1 ownsBoard)
  emit();
  return worker;
}

export async function launchAction(taskId: string, actionKey: string): Promise<Worker | null> {
  return activeMode === "live" ? launchActionLive(taskId, actionKey) : launchActionSimulated(taskId, actionKey);
}

/** Current pane content of a worker's terminal (live mode). */
export async function workerPane(workerId: string): Promise<{ hasSession: boolean; pane: string } | null> {
  const worker = findWorker(workerId);
  if (!worker) return null;
  if (!worker.session) {
    return {
      hasSession: false,
      pane:
        `Modo simulado: este worker anima el loop, pero no hay terminal ni claude reales.\n` +
        `Etapa actual: ${worker.stage}\n\n` +
        `Para una terminal real (claude en el repo + evidencia), reinicia con:\n  npm run dev:live`,
    };
  }
  try {
    return { hasSession: true, pane: await capturePane(worker.session) };
  } catch {
    return { hasSession: false, pane: "(sesión no disponible)" };
  }
}

/**
 * P1 teardown: remove a worker's ephemeral worktree, honoring (a) the refcount — a verifier
 * shares the parent's worktree, so don't remove while another live worker sits in it — and
 * (b) the dirty guard inside removeWorktree (uncommitted/committed work is KEPT, not deleted).
 * The branch is derived from the worktree path leaf (== the OWNING session), which is correct
 * for both a task worker and a verifier that inherited the parent's worktree. Never throws.
 */
/** True if another live worker (e.g. the verifier) still sits in this worktree. */
export function worktreeReferencedByOthers(all: Worker[], workerId: string, worktree: string): boolean {
  return all.some((w) => w.id !== workerId && w.worktree === worktree);
}

async function cleanupWorktree(worker: Worker): Promise<void> {
  const wt = worker.worktree;
  if (!wt) return;
  if (worktreeReferencedByOthers(workers, worker.id, wt)) return; // still referenced (refcount)
  const repoRoot = resolveCwd(worker.repo).cwd;
  const res = await removeWorktree(repoRoot, wt, branchForSession(basename(wt))).catch(() => ({
    removed: false,
    kept: false,
  }));
  if (res.removed) worker.worktree = undefined;
  else if (res.kept) console.log(`[claude-cowork] worktree conservado (cambios sin commitear/commits): ${wt}`);
}

async function stopLive(workerId: string): Promise<boolean> {
  const worker = findWorker(workerId);
  if (!worker) return false;
  if (worker.session) {
    stopTtyd(worker.session);
    await killSession(worker.session); // kill the pane BEFORE removing the worktree (P1-10)
  }
  await cleanupWorktree(worker);
  const evidence = captureEvidence(worker);   // ANTES de borrar el cycle dir
  if (worker.cycle) removeCycleDir(worker.cycle);
  const task = findTask(worker.taskId);
  if (ownsBoard(worker) && task) {
    if (task.status !== "done") {
      task.status = "queued";
      task.workerId = undefined;
    }
    logEvent("stop", task, evidence);
  }
  workerFlow.delete(workerId);
  modelSwitchAttempts.delete(workerId);
  clearWorkerVerify(workerId);
  removeWorker(workerId);
  emit();
  return true;
}

const verifierFor = new Set<string>(); // main worker ids that already have a verifier
const verifierIds = new Set<string>(); // worker ids that ARE verifiers

/** Spawn an independent verifier (third pane) to check the curl results vs the objective. */
async function spawnVerifier(mainWorker: Worker): Promise<void> {
  if (verifierFor.has(mainWorker.id)) return;
  verifierFor.add(mainWorker.id);
  const task = findTask(mainWorker.taskId);
  if (!task || !mainWorker.cycle) return;
  // P1h: a prior process life already spawned the verifier (latch in the parent cycle dir) →
  // don't spawn a second one after a restart (verifierFor is empty on a fresh process).
  if (verifierSpawned(mainWorker.cycle)) return;
  const id = `v${Date.now().toString(36)}`;
  const cwd = mainWorker.cwd ?? resolveCwd(task.repo).cwd;
  // P1 pt3: reserve the verifier in workers[] SYNCHRONOUSLY (before the first await) with the
  // parent's worktree set, so a reachedDone cleanup that fires in this same window sees the
  // reference and won't remove the (possibly clean) worktree out from under the attaching verifier.
  // session is filled in after uniqueSession; an empty session is skipped by pollLive (falsy).
  const worker: Worker = {
    id,
    label: nextWorkerLabel(),
    kind: mainWorker.kind, // hereda el kind del padre: verificador de action/research → ownsBoard=false
    actionKey: mainWorker.actionKey,
    repo: task.repo,
    taskId: task.id,
    state: "starting",
    stage: "🔎 verificador arrancando…",
    startedAt: Date.now(),
    session: "", // placeholder; real name assigned below (pollLive skips empty-session workers)
    cwd, // no own cycle: reads/writes the main worker's cycle via absolute paths
    worktree: mainWorker.worktree, // P1-6: share the parent's worktree → refcount keeps it alive
  };
  verifierIds.add(id);
  workers.push(worker);
  emit();
  // Incluye el marcador -action-<key> cuando el padre es una acción, para que rediscoverSessions
  // lo detecte como desacoplado tras un reinicio (y no agarre el tablero).
  const vbase =
    mainWorker.kind === "action" && mainWorker.actionKey
      ? `${sanitizeKey(task.key)}-action-${sanitizeKey(mainWorker.actionKey)}`
      : sanitizeKey(task.key);
  const session = await uniqueSession(`${vbase}-verify`);
  worker.session = session;
  markVerifierSpawned(mainWorker.cycle); // persist so a restart won't spawn a second verifier
  try {
    // Verifier deliberately uses the default CLAUDE_CMD, not the repo's startCommand
    // (a repo whose startCommand is a required wrapper could make it fail — acceptable to defer).
    await createSession(session, cwd);
    void sendWhenReady(session, buildVerifierPrompt(task, mainWorker.cycle));
    worker.state = "idle";
    worker.stage = "🔎 verificando resultados curl";
  } catch {
    worker.state = "idle";
    worker.stage = "✖ error verificador";
  }
  emit();
}

// In-memory attempt counter for the plan→impl /model switch (bounded resend; the
// authoritative "done" latch lives in the cycle dir via markModelSwitched).
const modelSwitchAttempts = new Map<string, number>();

// ---- P2: per-stage verifyCmd gate execution ----
const verifyRunning = new Set<string>(); // `${workerId}:${stageKey}` currently executing
const verifyArmed = new Set<string>();   // retry allowed (armed when the worker worked again)

function clearWorkerVerify(workerId: string): void {
  for (const s of [...verifyRunning]) if (s.startsWith(`${workerId}:`)) verifyRunning.delete(s);
  for (const s of [...verifyArmed]) if (s.startsWith(`${workerId}:`)) verifyArmed.delete(s);
}

/**
 * Run a stage's verifyCmd off the poll loop. Pass → persist "passed" (advancement allowed next
 * poll). Fail with retries left → "pending" + re-prompt the worker (only when idle) to fix and
 * re-touch the sentinel. Fail with none left → "failed" (the gate cap holds the worker at this
 * stage forever — never a false-green). State persists in the cycle dir (survives restart).
 */
async function runVerifyStage(worker: Worker, gate: { key: string; verifyCmd: string; maxRetries: number }, prevAttempts: number): Promise<void> {
  const cwd = worker.worktree ?? worker.cwd;
  try {
    if (!worker.cycle || !cwd) return;
    const res = await runVerify(gate.verifyCmd, cwd);
    const outcome = verifyOutcome(res.ok, prevAttempts, gate.maxRetries);
    writeVerifyState(worker.cycle, gate.key, outcome);
    if (outcome.status === "pending" && worker.session) {
      // D1: re-prompt to fix, only when idle (never write into a busy pane). No sentinel deletion.
      const pane = await capturePane(worker.session).catch(() => "");
      if (!isBusy(pane)) {
        await sendText(
          worker.session,
          `⚠️ verifyCmd de la etapa "${gate.key}" falló (intento ${outcome.attempts}/${gate.maxRetries}). ` +
            `Corrige y vuelve a tocar el sentinel ${gate.key}. Salida:\n${truncate(res.output)}`,
          true
        ).catch(() => {});
      }
    }
    emit();
  } finally {
    verifyRunning.delete(`${worker.id}:${gate.key}`);
  }
}

/**
 * For each verifyCmd gate the worker has left, run the check — paced by the worker's own
 * busy/idle cycle: never runs while the pane is busy, and a RETRY requires the worker to have
 * worked (gone busy) since the last failed attempt (armed), so we don't burn through maxRetries
 * while the worker is still fixing. First attempt runs as soon as the worker leaves the stage.
 */
async function maybeRunVerifies(
  worker: Worker,
  flow: { stages: WfStage[]; verifyAfter: string | null },
  furthestReal: string | null
): Promise<void> {
  if (!worker.session || !worker.cycle || !worker.cwd) return;
  const eligible = eligibleVerifyStages(flow.stages, furthestReal, (k) => readVerifyState(worker.cycle!, k)?.status ?? null);
  if (!eligible.length) return;
  let pane = "";
  try {
    pane = await capturePane(worker.session);
  } catch {
    return;
  }
  const busy = isBusy(pane);
  for (const g of eligible) {
    const runKey = `${worker.id}:${g.key}`;
    if (verifyRunning.has(runKey)) continue;
    const state = readVerifyState(worker.cycle, g.key);
    const decision = verifyRunDecision(busy, state?.attempts ?? 0, verifyArmed.has(runKey));
    if (decision === "arm") verifyArmed.add(runKey); // worker is fixing → arm the next retry
    if (decision !== "run") continue;
    verifyRunning.add(runKey);
    verifyArmed.delete(runKey);
    void runVerifyStage(worker, g, state?.attempts ?? 0);
  }
}

/**
 * F0: at plan→impl, switch the pane to the Worker model with `/model`. Idempotent via a
 * persisted cycle-dir latch (survives restart). Fires only when: this launch enabled the
 * switch (implementer launch, not PR/research — see writeModelsInfo), the flow has an impl
 * stage, and the worker has reached it OR later (F2: tolerates a skipped `implementing`
 * poll). Never sends while the pane is busy — a slash command mid-turn is a silent no-op
 * (F1) — and verifies the switch applied before latching, retrying (bounded) otherwise.
 */
const MODEL_SWITCH_MAX_ATTEMPTS = 3;

async function maybeSwitchModel(
  worker: Worker,
  flow: { stages: WfStage[]; verifyAfter: string | null },
  stageKey: string
): Promise<void> {
  if (!worker.session || !worker.cycle) return;
  const info = readModelsInfo(worker.cycle);
  if (!info) return;
  // Already-done = success latch OR abandoned-after-retries latch (never re-fire either).
  const done = modelSwitched(worker.cycle) || modelSwitchFailed(worker.cycle);
  if (!shouldSwitchModel(info.switchEnabled, done, flow.stages, stageKey)) return;
  const model = sanitizeModel(info.worker);
  if (!model) {
    markModelSwitched(worker.cycle);             // nothing valid to switch to; don't retry forever
    return;
  }
  const target = modelFamily(model);
  // Confirmed by: the transient "Set model to <target>" confirmation line (current Claude sets
  // directly, no persistent banner), OR a persistent banner reading the target (older versions).
  const confirms = (p: string) => modelSwitchConfirmed(p, target) || currentModelFromPane(p) === target;

  let pane = "";
  try {
    pane = await capturePane(worker.session);
  } catch {
    return;
  }
  // Dedup: a prior poll may have already switched and the confirmation is still on screen → latch
  // without resending (this is what stops the observed 3× `/model sonnet` resend).
  if (confirms(pane)) {
    markModelSwitched(worker.cycle);
    modelSwitchAttempts.delete(worker.id);
    return;
  }
  if (isBusy(pane)) return;                       // F1: never send mid-turn — retry next poll

  await sendText(worker.session, "/model " + model, true).catch(() => {});
  const attempts = (modelSwitchAttempts.get(worker.id) ?? 0) + 1;
  modelSwitchAttempts.set(worker.id, attempts);

  // Poll a few times (~2.4s) for the confirmation to render — a single 800ms capture can miss it.
  // Also handle the picker path (other/older Claude versions that open a "Switch model?" confirm
  // instead of setting directly): confirm the pre-selected target with Enter, else dismiss.
  let applied = false;
  for (let i = 0; i < 3 && !applied; i++) {
    await delay(800);
    let after = await capturePane(worker.session).catch(() => "");
    if (isModelPickerOpen(after)) {
      if (pickerOffersModel(after, target)) {
        await sendKeys(worker.session, "Enter").catch(() => {});
        await delay(800);
        after = await capturePane(worker.session).catch(() => "");
      } else {
        await sendKeys(worker.session, "Escape").catch(() => {});
      }
    }
    applied = confirms(after);
  }

  if (applied) {
    markModelSwitched(worker.cycle);
    modelSwitchAttempts.delete(worker.id);
    return;
  }
  if (attempts >= MODEL_SWITCH_MAX_ATTEMPTS) {
    // Give up WITHOUT claiming success: visible note + a distinct latch so we stop retrying
    // but never silently pretend the (expensive Planner) model was swapped (point 1).
    markModelSwitchFailed(worker.cycle);
    worker.stage = `⚠️ no pude cambiar a "${model}" · usa /model en el pane`;
    worker.needsInput = true;
    modelSwitchAttempts.delete(worker.id);
  }
}

/**
 * P4: set/clear worker.contextPressure from the pane, change-gated (only reports a real change so
 * SSE doesn't churn and the log isn't spammed). Returns true when the value changed.
 */
export function applyContextPressure(worker: Worker, pane: string): boolean {
  const next = parseContextPressure(pane);
  const prev = worker.contextPressure;
  const same =
    (!next && !prev) || (!!next && !!prev && next.note === prev.note && next.tokens === prev.tokens);
  if (same) return false;
  worker.contextPressure = next ?? undefined;
  return true;
}

async function pollLive(): Promise<void> {
  let changed = false;
  for (const worker of [...workers]) {
    if (!worker.session) continue;
    if (!(await hasSession(worker.session))) {
      // user closed/exited the terminal → return the task to the queue
      const task = findTask(worker.taskId);
      if (ownsBoard(worker) && task && task.status !== "done") {
        task.status = "queued";
        task.workerId = undefined;
      }
      await cleanupWorktree(worker); // P1: remove the worktree (dirty-guarded, refcounted)
      if (worker.cycle) removeCycleDir(worker.cycle);
      workerFlow.delete(worker.id);
      modelSwitchAttempts.delete(worker.id);
      clearWorkerVerify(worker.id);
      removeWorker(worker.id);
      changed = true;
      continue;
    }
    try {
      // Loop-stage sentinels take precedence: they reflect the real pipeline.
      // Fallback (worker rediscovered after a restart) resolves over the repo's workflow.
      const flow = workerFlow.get(worker.id) ?? resolveFlow(undefined, worker.repo);
      // P4: capture the pane once per poll and detect context pressure (change-gated, no log spam).
      // Reused by the busy/idle fallback below so we don't double-capture.
      let paneSnapshot: string | null = null;
      try {
        paneSnapshot = await capturePane(worker.session);
      } catch {
        /* transient */
      }
      if (paneSnapshot !== null && applyContextPressure(worker, paneSnapshot)) changed = true;
      let stageKey = worker.cycle ? detectStage(worker.cycle, stepKeys(flow)) : null;
      // P2: run any eligible verifyCmd gates, then CAP the displayed stage at an unpassed gate so
      // the board never reaches `done` on a false green (B2). The cap consults the persisted
      // pass/fail state synchronously — no reliance on sentinel timing.
      if (ownsBoard(worker) && worker.cycle) {
        const furthestReal = detectStage(worker.cycle, flow.stages.map((s) => s.key));
        await maybeRunVerifies(worker, flow, furthestReal);
        const cap = verifyGateCap(flow.stages, furthestReal, (k) => verifyPassed(worker.cycle!, k));
        if (cap) stageKey = cap;
      }
      const stage = stageKey ? liveMapFor(flow.stages, flow.verifyAfter).get(stageKey) : undefined;
      if (stage) {
        // P2 (B2 — including a TERMINAL gate): if the RESOLVED stage carries a verifyCmd that
        // hasn't PASSED (pending, running, or failed), it is NOT done — force review/busy and
        // never fire reachedDone/logEvent("complete"). Otherwise use the normal board mapping.
        // Guarding only on `failed` was a false-green: a gate on the last stage maps to `done`
        // while the check is still `pending` in-flight → complete would fire irreversibly.
        const gateStage = stageKey ? flow.stages.find((s) => s.key === stageKey && s.verifyCmd) : undefined;
        const gstate = gateStage && worker.cycle ? readVerifyState(worker.cycle, stageKey!) : null;
        const gateFailed = gstate?.status === "failed";
        const gateUnpassed = gateHoldsDone(!!gateStage, gstate?.status ?? null); // pending/absent/failed
        const gateStuck = gateUnpassed && !gateFailed && (gstate?.attempts ?? 0) > 0; // worker ignoring the re-prompt
        const tWorker: WorkerState = gateUnpassed ? "review" : stage.worker;
        const tTask: TaskStatus = gateUnpassed ? "review" : stage.task;
        const tLabel = gateFailed
          ? `✖ verifyCmd falló · ${stage.label}`
          : gateStuck
          ? `⚠️ gate "${stage.label}" pendiente (intento ${gstate?.attempts}) · corrige y re-toca`
          : gateUnpassed
          ? `⏳ verificando "${stage.label}"…`
          : stage.label;
        if (gateFailed && stageKey) {
          worker.verifyFailure = { stageKey, output: `${gstate?.attempts ?? 0} intento(s) fallido(s)` };
        } else if (worker.verifyFailure) {
          worker.verifyFailure = undefined;
          changed = true;
        }
        if (worker.stageKey !== stageKey) {
          worker.stageKey = stageKey ?? undefined;
          changed = true;
        }
        if (worker.state !== tWorker || worker.stage !== tLabel) {
          const reachedDone = tWorker === "done" && worker.state !== "done";
          worker.state = tWorker;
          worker.stage = tLabel;
          if (ownsBoard(worker)) {
            const task = findTask(worker.taskId);
            if (task) {
              task.status = tTask;
              if (reachedDone) logEvent("complete", task, captureEvidence(worker));
            }
          }
          // P1e: worker completed with its session still alive → reclaim the worktree now
          // (dirty-guarded: a worktree with commits/uncommitted work is kept, so real work
          // survives for inspection; only a genuinely no-op worktree is removed).
          if (reachedDone) void cleanupWorktree(worker);
          changed = true;
        }
        // Point 3: a failed OR stuck-pending gate needs operator attention → surface it (the UI
        // already highlights needsInput). A cleanly-progressing worker clears it.
        const wantNeedsInput = gateFailed || gateStuck;
        if (worker.needsInput !== wantNeedsInput) {
          worker.needsInput = wantNeedsInput;
          changed = true;
        }
        // F0: plan→impl reached → switch the pane to the Worker model (once, idle-only).
        if (stageKey) await maybeSwitchModel(worker, flow, stageKey);
        // verifyAfter stage reached on a main worker → spawn the verifier (once). Gate on the
        // per-main-worker set AND the persisted latch (the old `verifierIds.has(worker.id)` guard
        // was ineffective — worker is the PARENT, never in verifierIds — so a restart re-spawned).
        if (
          stageKey &&
          flow.verifyAfter &&
          stageKey === flow.verifyAfter &&
          !verifierFor.has(worker.id) &&
          !(worker.cycle && verifierSpawned(worker.cycle))
        ) {
          void spawnVerifier(worker);
        }
        continue;
      }

      // No sentinel yet → fall back to the busy/idle pane heuristic (reuse the P4 snapshot).
      const pane = paneSnapshot ?? (await capturePane(worker.session));
      const busy = isBusy(pane);
      const hint = lastMeaningfulLine(pane);
      const newState: WorkerState = busy ? "busy" : "idle";
      const newStage = busy ? `⚙️ ${hint || "trabajando…"}` : `💤 ${hint || "esperando input"}`;
      const task = findTask(worker.taskId);
      if (worker.state !== newState || worker.stage !== newStage) {
        worker.state = newState;
        worker.stage = newStage;
        if (ownsBoard(worker) && task) task.status = busy ? "running" : "review";
        changed = true;
      }
      // idle while the task isn't done → waiting for the user to respond
      const ni = !busy && !!task && task.status !== "done";
      if (worker.needsInput !== ni) {
        worker.needsInput = ni;
        changed = true;
      }
    } catch {
      /* transient capture error */
    }
  }
  if (changed) emit();
}

/**
 * Rebuild the worker list from tmux sessions that survived a server restart.
 * The tmux sessions are the source of truth for live terminals, so the dashboard
 * re-attaches to them instead of "forgetting" them.
 */
async function rediscoverSessions(): Promise<void> {
  const sessions = (await listSessions()).filter((s) => s.startsWith("cowork-"));
  let changed = false;
  for (const session of sessions) {
    if (workers.some((w) => w.session === session)) continue;
    const task = tasks.find(
      (t) => session === `cowork-${sanitizeKey(t.key)}` || session.startsWith(`cowork-${sanitizeKey(t.key)}-`)
    );
    // Clasifica SOLO el remanente tras quitar el prefijo cowork-<sanitizeKey(task.key)> (evita falsos
    // positivos por substring: un task key como "fix-action-bar"/"research-notes"/"verify-login" ya NO
    // se confunde con un worker desacoplado). Los marcadores van anclados a la cola, con el sufijo -<n>
    // opcional de uniqueSession. Sin task no hay tablero que agarrar → clasificación best-effort para el badge.
    const prefix = task ? `cowork-${sanitizeKey(task.key)}` : null;
    const rest = prefix && session.startsWith(prefix) ? session.slice(prefix.length) : session;
    const isVerify = /-verify(?:-\d+)?$/.test(rest);
    const isAction = rest.startsWith("-action-");
    const isResearch = !isAction && /^-research(?:-\d+)?$/.test(rest);
    // action key: quita un -verify final (verificador) y resuelve contra el registry por prefijo más largo,
    // en vez de asumir que un -<dígitos> final es sufijo de dedup (un key real puede terminar en dígito).
    const actionSeg = isAction ? rest.slice("-action-".length).replace(/-verify(?:-\d+)?$/, "") : "";
    const actionKey = isAction ? matchActionKey(actionSeg) : undefined;
    const action = actionKey ? getAction(actionKey) : null;
    const kind: Worker["kind"] = isResearch ? "research" : isAction ? "action" : undefined;
    // verify de padre desacoplado (marcador -action-) o de tarea (kind undefined + isVerify) → no agarra tablero:
    const decoupled = kind !== undefined || isVerify;
    const flow = isResearch
      ? RESEARCH_FLOW
      : action && !action.inheritWorkflow
      ? { stages: action.stages, verifyAfter: action.verifyAfter }
      : resolveFlow(undefined, task?.repo);
    // P1-1/P1g: reconstruct the worktree cwd from the deterministic path. Only task workers
    // (kind undefined) and their verifiers get worktrees; a verifier's own session is
    // `<parent>-verify`, so derive the OWNING session (strip the verify suffix) to find the
    // parent's worktree — restoring isolation AND letting the refcount see the verifier hold it.
    const root = task ? resolveCwd(task.repo).cwd : undefined;
    let worktree: string | undefined;
    let cwd = root;
    if (root && kind === undefined) {
      const wt = worktreePathForSession(root, isVerify ? owningSession(session) : session);
      if (worktreeExists(wt)) {
        worktree = wt;
        cwd = wt;
      }
    }
    const worker: Worker = {
      id: `w${Date.now().toString(36)}${workers.length}`,
      label: nextWorkerLabel(),
      kind,
      actionKey,
      repo: task?.repo ?? "?",
      taskId: task?.id ?? session,
      state: "idle",
      stage: isResearch
        ? "🔍 investigación (redescubierta)"
        : isAction
        ? "⚡ acción (redescubierta)"
        : "↻ redescubierto",
      startedAt: Date.now(),
      session,
      cwd,
      worktree,
      cycle: cycleDirForSession(session),
      stages: stepSteps(flow),
    };
    workerFlow.set(worker.id, flow); // research/action/global: pollLive usa el flow correcto tras reinicio
    workers.push(worker);
    // P1h: a live `-verify` session means the parent already has its verifier → set the latch on
    // the parent's cycle dir so the rediscovered parent doesn't spawn a second one.
    if (isVerify) markVerifierSpawned(cycleDirForSession(owningSession(session)));
    if (!decoupled && task && !task.workerId) {
      task.workerId = worker.id;
      if (task.status === "queued" || task.status === "triage") task.status = "running";
    }
    changed = true;
  }
  if (changed) {
    console.log(`[claude-cowork] redescubiertas ${workers.length} sesión(es) cowork-* tras reinicio`);
    emit();
  }
}

/**
 * P1-5: on startup, remove worktrees whose tmux session no longer exists (a crash left them
 * behind), across the known repo roots. Dirty-guarded (uncommitted/committed work is kept).
 * Best-effort — never throws, runs once after rediscovery.
 */
async function reconcileLeakedWorktrees(): Promise<void> {
  const live = new Set((await listSessions()).filter((s) => s.startsWith("cowork-")));
  const roots = new Set<string>();
  for (const repo of listRepos()) {
    const { cwd, real } = resolveCwd(repo);
    if (real) roots.add(cwd);
  }
  for (const root of roots) {
    if (!(await isGitRepo(root))) continue;
    const n = await reconcileWorktrees(root, live).catch(() => 0);
    if (n) console.log(`[claude-cowork] limpiadas ${n} worktree(s) huérfana(s) en ${root}`);
  }
}

// ============================================================
//  PUBLIC API  (mode-dispatched)
// ============================================================

export async function launchTask(taskId: string, stageKeys?: string[], opts: LaunchOpts = {}): Promise<Worker | null> {
  return activeMode === "live" ? launchLive(taskId, stageKeys, opts) : launchSimulated(taskId);
}

export async function stopWorker(workerId: string): Promise<boolean> {
  if (activeMode === "live") return stopLive(workerId);
  const worker = findWorker(workerId);
  if (!worker) return false;
  const task = findTask(worker.taskId);
  if (ownsBoard(worker) && task) {
    if (task.status !== "done") {
      task.status = "queued";
      task.workerId = undefined;
    }
    logEvent("stop", task, captureEvidence(worker));
  }
  stageIndex.delete(workerId);
  removeWorker(workerId);
  emit();
  return true;
}

export async function attachWorker(workerId: string): Promise<boolean> {
  const worker = findWorker(workerId);
  if (!worker?.session) return false;
  await openTerminal(worker.session);
  return true;
}

/** Create + launch an ad-hoc task (DM/mention). complex → /tmux-worker-loop. */
export async function launchAdhoc(text: string, title?: string, repo = "monorepo", complex = false): Promise<Worker | null> {
  const id = `adhoc-${Date.now().toString(36)}`;
  const t = (title ?? "").trim() || text.split("\n").find((l) => l.trim())?.slice(0, 70) || "ad-hoc";
  addTask({ id, key: id, title: t, body: text, repo, source: "adhoc", complex, status: "running" });
  return launchTask(id);
}

/** Create + launch a free-text request that runs the composable workflow loop. */
export async function launchCustom(
  text: string,
  repo = "monorepo",
  stageKeys?: string[],
  opts: LaunchOpts = {}
): Promise<Worker | null> {
  const id = `custom-${Date.now().toString(36)}`;
  const title = text.split("\n").find((l) => l.trim())?.trim().slice(0, 70) || "petición";
  addTask({ id, key: id, title, body: text, repo, source: "custom", status: "running" });
  return launchTask(id, stageKeys, opts);
}

/** Create + launch a PR review task. Verifies the PR vs the task; curl in dev after merge. */
export async function launchPrReview(
  prUrl: string,
  taskUrl?: string,
  title?: string,
  repo = "ant-liebre-api"
): Promise<Worker | null> {
  const id = `pr-${Date.now().toString(36)}`;
  const t = (title ?? "").trim() || `PR review: ${prUrl.split("/").slice(-2).join("/")}`;
  addTask({ id, key: id, title: t, body: prUrl, url: taskUrl || undefined, repo, source: "pr", status: "running" });
  return launchTask(id);
}

/** Type a response into the worker's pane (answer its question). */
export async function workerInput(workerId: string, text: string): Promise<boolean> {
  const worker = findWorker(workerId);
  if (!worker?.session) return false;
  await sendText(worker.session, text, true);
  return true;
}

export async function start(taskSource: string): Promise<"simulated" | "live"> {
  if (MODE === "live") {
    if (!(await tmuxAvailable())) {
      console.warn("[claude-cowork] tmux no disponible → cayendo a modo simulado");
      activeMode = "simulated";
      setMode(activeMode);
      maybeSimulate(taskSource);
      return activeMode;
    }
    activeMode = "live";
    setMode(activeMode);
    await rediscoverSessions(); // re-attach to tmux sessions still running after a restart
    await reconcileLeakedWorktrees(); // P1-5: prune worktrees whose session died in a crash
    // G1: recursive setTimeout (not setInterval) so a poll that runs past 2s — capturePane,
    // hasSession, verifyCmd are all awaited — never overlaps the next tick over the same workers[].
    const loop = () => {
      pollLive()
        .catch(() => {})
        .finally(() => setTimeout(loop, 2000));
    };
    setTimeout(loop, 2000);
    return activeMode;
  }
  activeMode = "simulated";
  setMode(activeMode);
  maybeSimulate(taskSource);
  return activeMode;
}

/**
 * Only churn the board with the demo simulator when the data is mock.
 * With real ClickUp/Jira tasks, leave their real statuses untouched so the
 * board reflects (and can be ordered by) the source of truth.
 */
function maybeSimulate(taskSource: string): void {
  autoChurn = taskSource === "mock";
  if (autoChurn) {
    seedInitialWorkers(); // demo: a couple of workers already in flight
  } else {
    console.log("[claude-cowork] datos reales → sin auto-seed; un worker que lances avanza por el loop");
  }
  startSimTick(); // always: lets manually-launched workers progress
}
