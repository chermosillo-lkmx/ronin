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
  lastSentinelAt,
  modelSwitched,
  modelSwitchFailed,
  readEvidence,
  parseParkedLimit,
  readDriverInfo,
  readModelsInfo,
  readSentinelsTail,
  readVerifyState,
  removeCycleDir,
  verifierSpawned,
  verifyPassed,
  writeDriverInfo,
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
  sanitizeReviewTool,
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
import { buildActionPrompt, buildDriverPrompt, buildResearchPrompt, buildVerifierPrompt, buildWorkerPrompt } from "./templates.js";
import {
  eligibleVerifyStages,
  gateHoldsDone,
  liveMapFor,
  resolveFlow,
  DRIVER_FLOW,
  DRIVER_STAGES,
  shouldSwitchModel,
  stepperFor,
  verifyGateCap,
  type WfStage,
} from "./workflow.js";
import { stopTtyd } from "./ttyd.js";
import { addTask, emit, findTask, findWorker, nextWorkerLabel, removeWorker, setMode, tasks, workers } from "./state.js";
import {
  applyZoom,
  capturePane,
  capturePaneSafe,
  claudeAlive,
  createDriverWindow,
  createSession,
  hasSession,
  isBusy,
  killSession,
  lastMeaningfulLine,
  listSessions,
  openTerminal,
  paneStatus,
  parseContextPressure,
  parsePaneId,
  pastePrompt,
  promptPending,
  readPaneRoles,
  readSessionReviewTool,
  readZoomState,
  sendKeys,
  sendText,
  setSessionReviewTool,
  tmuxAvailable,
  PANE_ROLES,
  type PaneRole,
  type ZoomOutcome,
} from "./tmux.js";
import type { CustomAction, DriverPanes, PaneView, Task, TaskStatus, Worker, WorkerState } from "./types.js";

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
  // TODO prompt inicial (driver Y scripted) se entrega por bracketed paste + pausa antes del
  // Enter. Con send-keys -l + Enter inmediato, el Enter llega mientras la caja de input sigue
  // componiendo los trozos pegados y se lo TRAGA: el prompt queda escrito pero sin enviar,
  // indefinidamente. Medido en vivo: falla reproducible a 13KB, funciona con paste. Los prompts
  // scripted son más cortos y hoy no lo disparan, pero el modo de falla es el mismo si crecen
  // (una descripción de ticket larga basta), y es silencioso — el worker simplemente nunca
  // arranca. `sendText` NO cambia: los slash commands (/model), el Enter de los diálogos y las
  // respuestas cortas del operador siguen por el camino de siempre.
  const deliver = async () => {
    await pastePrompt(session, prompt, AUTOSUBMIT).catch(() => {});
    if (AUTOSUBMIT) await ensureSubmitted(session);
  };
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
      await deliver();
      return;
    }
  }
  await deliver(); // fallback
}

/**
 * Segunda capa tras un paste largo: verificar que el prompt SALIÓ en vez de asumirlo. Si el pane
 * sigue idle con texto compuesto en la caja, reenvía Enter de forma acotada. Un Enter de más
 * sobre una caja vacía es inocuo; un prompt que nunca se envía deja el ciclo colgado para siempre.
 */
async function ensureSubmitted(target: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await delay(1500);
    const pane = await capturePane(target).catch(() => "");
    if (!pane || !promptPending(pane)) return; // ocupado o sin nada pendiente ⇒ entró
    await sendKeys(target, "Enter").catch(() => {});
  }
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
  mode?: "scripted" | "driver";
  reviewTool?: "codex" | "agent";
}

// ---- Bloques compartidos por launchLive y launchDriverLive. Extraídos SIN cambiar
// comportamiento ni orden (extract-method mecánico): launchLive los llama en la misma
// secuencia de siempre, así el camino scripted no gana un solo condicional. ----

/** El worker toma el tablero: se registra, marca la tarea como corriendo y publica. */
function registerTaskWorker(task: Task, worker: Worker): void {
  workers.push(worker);
  task.workerId = worker.id;
  task.status = "running";
  logEvent("launch", task);
  emit();
}

/**
 * Fresh launch: wipe any stale cycle dir left by a prior crash reusing the same
 * deterministic session name (stale sentinels/latches would misreport the stage or
 * skip the plan→impl model switch — F3).
 */
function freshCycleDir(worker: Worker): void {
  removeCycleDir(worker.cycle!);
  ensureCycleDir(worker.cycle!);
}

/** Vars por repo ({var:KEY} en el prompt) + creds de curl del proyecto en el cycle dir. */
function writeLaunchArtifacts(task: Task, cycle: string): Record<string, string> {
  const vars = getRepoVars(task.repo);
  writeCurlEnv(task.repo, cycle, vars);
  return vars;
}

/** Enrich the prompt with the full ticket description (best-effort, ClickUp only). */
async function enrichTaskBody(task: Task): Promise<void> {
  if (task.source === "clickup" && !task.body) {
    const desc = await fetchClickUpDescription(task.id);
    if (desc) task.body = desc;
  }
}

/**
 * P1: isolate this worker in an ephemeral git worktree so two workers over the same repo
 * don't collide. Fallback to the repo root (with a visible note) if the repo isn't git or
 * the worktree can't be created — never abort the launch.
 */
async function acquireWorktree(
  worker: Worker,
  cwd: string,
  real: boolean,
  session: string
): Promise<{ launchCwd: string; note: string | null }> {
  let launchCwd = cwd;
  let note: string | null = null;
  if (real && (await isGitRepo(cwd))) {
    const wt = worktreePathForSession(cwd, session);
    try {
      await addWorktree(cwd, wt, branchForSession(session));
      worker.worktree = wt;
      worker.cwd = wt;
      launchCwd = wt;
    } catch {
      note = "⚠️ worktree no disponible · repo raíz compartido";
    }
  }
  return { launchCwd, note };
}

/** P1f: don't leak the worktree if the session failed to start. Fire-and-forget, nunca lanza. */
function rollbackWorktree(worker: Worker, repoRoot: string, session: string): void {
  if (worker.worktree) {
    void removeWorktree(repoRoot, worker.worktree, branchForSession(session)).catch(() => {});
    worker.worktree = undefined;
  }
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
  registerTaskWorker(task, worker);

  freshCycleDir(worker);
  // F0: Planner model injected as --model over the repo's start command (existing --model wins).
  const plannerModel = sanitizeModel(opts.plannerModel || getRepoPlannerModel(task.repo));
  // Switch to the Worker model at plan→impl only for real implementer launches (never PR).
  writeModelsInfo(worker.cycle!, {
    worker: sanitizeModel(opts.workerModel || getRepoWorkerModel(task.repo)),
    switchEnabled: launchSwitchEnabled(task.source),
  });
  const vars = writeLaunchArtifacts(task, worker.cycle!);
  await enrichTaskBody(task);
  const { launchCwd, note: worktreeNote } = await acquireWorktree(worker, cwd, real, session);
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
    rollbackWorktree(worker, cwd, session);
    worker.state = "idle";
    worker.stage = "✖ error al crear la sesión tmux";
  }
  emit();
  return worker;
}

/**
 * Modo Driver: una ventana tmux de 4 panes con un Claude DRIVER real que orquesta a los otros
 * tres corriendo /tmux-worker-loop en modo provisioned-panes. Los slots son posiciones, no roles:
 * worker=Implementer (sonnet), review=Reviewer (opus/codex), verify=Brain (opus). El mapeo está
 * en el skill (references/provisioned-panes.md) y el driver lo escribe en <CYCLE_DIR>/panes.env.
 *
 * Comparte con launchLive todos los helpers de preparación (registro, cycle dir, curl.env,
 * enriquecimiento, worktree + rollback), así que ninguno de esos bloques está duplicado — que
 * era el riesgo real de tener dos caminos de lanzamiento.
 */
async function launchDriverLive(taskId: string, opts: LaunchOpts = {}): Promise<Worker | null> {
  const task = findTask(taskId);
  if (!task) return null;
  // Mismo guard que launchLive: un ticket con worker vivo no se relanza. Consecuencia visible
  // en la UI: para pasar de Driver a rápido (o al revés) hay que parar el worker primero.
  if (task.workerId) return findWorker(task.workerId) ?? null;

  const { cwd, real } = resolveCwd(task.repo);
  const id = `d${Date.now().toString(36)}`;
  const session = await uniqueSession(`${sanitizeKey(task.key)}-driver`);
  const reviewTool = sanitizeReviewTool(opts.reviewTool);
  const worker: Worker = {
    id,
    label: nextWorkerLabel(),
    repo: task.repo,
    taskId: task.id,
    state: "starting",
    stage: "⏳ abriendo 4 panes…",
    startedAt: Date.now(),
    session,
    cwd,
    cycle: cycleDirForSession(session),
    stages: stepSteps(DRIVER_FLOW),
    mode: "driver",
    reviewTool,
  };
  workerFlow.set(id, DRIVER_FLOW);
  registerTaskWorker(task, worker);

  freshCycleDir(worker);
  // Dos neutralizaciones PERSISTIDAS: tras un reinicio worker.mode aún no existe cuando el
  // poller corre, así que los guards en memoria no bastan. models.json apaga el /model (que
  // se teclearía en el pane activo, posiblemente el de codex) y el latch de verificador evita
  // que se lance un 5º claude en una sesión aparte.
  // worker:"" apaga el switch, NO descarta el modelo del Implementer: en modo Driver cada rol
  // arranca con su propio --model y ese valor viaja por el prompt (buildDriverPrompt), no por
  // models.json. Ver el bloque de modelos más abajo.
  writeModelsInfo(worker.cycle!, { worker: "", switchEnabled: false });
  markVerifierSpawned(worker.cycle!);
  writeDriverInfo(worker.cycle!, { reviewTool });
  const vars = writeLaunchArtifacts(task, worker.cycle!);
  await enrichTaskBody(task);
  const { launchCwd, note } = await acquireWorktree(worker, cwd, real, session);
  try {
    const plannerModel = sanitizeModel(opts.plannerModel || getRepoPlannerModel(task.repo));
    // El workerModel NO se pierde por escribir models.json vacío arriba: en modo Driver no hay
    // switch plan→impl que lo consuma, así que viaja al prompt y el driver lo aplica como
    // `--model` al arrancar el pane del Implementer. Sin esto, un override por repo/UI se
    // ignoraría en silencio aquí y sólo funcionaría en modo rápido.
    const workerModel = sanitizeModel(opts.workerModel || getRepoWorkerModel(task.repo));
    const panes = await createDriverWindow(
      session,
      launchCwd,
      withModel(getRepoStartCommand(task.repo), plannerModel)
    );
    worker.panes = panes;
    await setSessionReviewTool(session, reviewTool);
    // Se apunta al pane DRIVER, no a la sesión: tras los splits el pane activo es otro.
    void sendWhenReady(
      panes.driver,
      buildDriverPrompt(task, worker.cycle!, panes, reviewTool, vars, {
        planner: plannerModel,
        worker: workerModel,
      })
    );
    worker.state = "idle";
    worker.stage = note ?? (real ? "🖥️ 4 panes · driver arrancando…" : "⚠️ repo no encontrado · cwd de respaldo");
  } catch {
    rollbackWorktree(worker, cwd, session);
    // Nunca dejar media ventana viva: el prompt del driver referencia panes que quizá no existen.
    await killSession(session);
    worker.state = "idle";
    worker.stage = "✖ error al crear la sesión driver";
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

/**
 * Current pane content of a worker's terminal (live mode). `role` (sólo modo driver) elige QUÉ
 * pane; sin él se lee el pane del driver.
 *
 * Antes se leía `capturePane(worker.session)`, o sea el pane ACTIVO — que con `mouse on` cambia
 * cada vez que el operador hace click dentro del iframe. Ya era incorrecto para modo driver, y con
 * el zoom (que también cambia el pane activo) pasaría a estar mal casi siempre.
 */
export async function workerPane(
  workerId: string,
  role?: PaneRole | null
): Promise<{ hasSession: boolean; pane: string } | null> {
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
  const target = role ? resolvePaneTarget(worker, role) : (paneTargetFor(worker) ?? worker.session);
  if (!target) return { hasSession: true, pane: "(no se pudo resolver ese pane: layout degradado)" };
  try {
    return { hasSession: true, pane: await capturePane(target) };
  } catch {
    return { hasSession: false, pane: "(sesión no disponible)" };
  }
}

// Ventana de la caché de capturas por pane. Corta a propósito: la vista pollea a 1.5s, así que
// esto sólo colapsa las ráfagas simultáneas (varias pestañas) sin volver rancio lo que se muestra.
const PANES_TTL_MS = 1000;
const panesCache = new Map<string, { at: number; inflight: Promise<PanesResult> }>();

export function clearPaneCache(workerId: string): void {
  panesCache.delete(workerId);
}

export interface PanesResult {
  panes: PaneView[];
  zoomed: PaneRole | null;
}

/** Los 4 panes con su estado + qué rol está zoomeado. null: sin worker/sesión; "degraded": sin panes. */
export async function workerPanes(workerId: string): Promise<PanesResult | null | "degraded"> {
  const worker = findWorker(workerId);
  if (!worker?.session) return null;
  if (worker.mode !== "driver" || !worker.panes) return "degraded";
  return memoTTL(panesCache, workerId, PANES_TTL_MS, () => collectPanes(worker.session!, worker.panes!));
}

/**
 * Captura los 4 panes y deriva su estado. Toda la heurística se reusa de tmux.ts (paneStatus,
 * lastMeaningfulLine, parseContextPressure): el dashboard no reimplementa la lógica de los skills,
 * sólo pinta lo que el server ya calculó.
 *
 * El estado NO se persiste en el Worker ni viaja en el Snapshot: es un cálculo barato y guardarlo
 * sólo arriesgaría mostrarlo rancio — el mismo criterio que ya rige driverDown/parked/stalled.
 */
async function collectPanes(session: string, panes: DriverPanes): Promise<PanesResult> {
  const zoom = await readZoomState(session);
  const views = await Promise.all(
    PANE_ROLES.map(async (role): Promise<PaneView> => {
      const paneId = panes[role];
      const text = await capturePaneSafe(paneId);
      return {
        role,
        paneId,
        status: paneStatus(text),
        hint: text ? lastMeaningfulLine(text) : "",
        contextPressure: text ? (parseContextPressure(text) ?? undefined) : undefined,
      };
    })
  );
  // El zoom se lee de tmux en cada llamada, nunca se memoriza: es estado compartido y cualquier
  // otro cliente (u otra pestaña) puede cambiarlo sin avisarnos.
  const zoomedRole =
    zoom?.zoomed ? (PANE_ROLES.find((r) => panes[r] === zoom.active) ?? null) : null;
  return { panes: views, zoomed: zoomedRole };
}

/**
 * Resultado tipado en vez de booleano: "no hay sesión", "el layout está degradado" y "tmux no
 * aplicó el zoom" piden mensajes distintos al operador, y un boolean los colapsa en un 404
 * engañoso.
 */
export type FocusResult = "ok" | "noop" | "no-session" | "degraded" | "tmux-failed";

/**
 * La I/O de tmux/Terminal.app, inyectable. Mismo patrón que el `now` de memoTTL: el repo no usa
 * framework de mocking, así que la costura es un parámetro con default. Existe para poder probar
 * que attachWorker ABORTA cuando el zoom no se confirmó — la garantía entera de esa feature.
 */
export interface FocusDeps {
  zoom: (session: string, target: string | null, driverPane: string) => Promise<ZoomOutcome>;
  terminal: (session: string) => Promise<void>;
}
const REAL_FOCUS: FocusDeps = { zoom: applyZoom, terminal: openTerminal };

/** Zoomea un rol (o `null` para volver al 2×2). El zoom es GLOBAL a la ventana: lo ven todos. */
export async function focusPane(
  workerId: string,
  role: PaneRole | null,
  deps: FocusDeps = REAL_FOCUS
): Promise<FocusResult> {
  const worker = findWorker(workerId);
  if (!worker?.session) return "no-session";
  const driverPane = resolvePaneTarget(worker, "driver");
  if (!driverPane) return "degraded";
  const target = role ? resolvePaneTarget(worker, role) : null;
  if (role && !target) return "degraded";
  const outcome = await deps.zoom(worker.session, target, driverPane);
  if (outcome === "ok" || outcome === "noop") return outcome;
  console.warn(`[claude-cowork] zoom en ${worker.session} → ${role ?? "4 panes"}: ${outcome}`);
  return "tmux-failed";
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
  clearDriverHealth(workerId);
  clearPaneCache(workerId);
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
      const pane = await capturePane(paneTargetFor(worker) ?? worker.session).catch(() => "");
      if (!isBusy(pane)) {
        await sendText(
          paneTargetFor(worker) ?? worker.session,
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
  // Modo driver: el switch de modelos es del skill. Además `/model` se enviaría con sendKeys al
  // pane ACTIVO de la ventana — que puede ser el de codex, o un shell desnudo donde el texto se
  // EJECUTA. El guard va aquí (no en el call site) para cubrir cualquier llamador futuro.
  if (worker.mode === "driver") return;
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

// ============================================================
//  Modo Driver — salud del pane driver (helpers PUROS)
// ============================================================

/**
 * Target de pane para TODA la I/O del servidor. En modo driver es el pane DRIVER: un `-t
 * <session>` pelado resuelve al pane ACTIVO, y con `mouse on` cada click del operador dentro
 * del iframe lo cambia — leyendo/escribiendo el pane equivocado. Scripted no cambia.
 */
export function paneTargetFor(w: {
  mode?: "scripted" | "driver";
  panes?: DriverPanes;
  session?: string;
}): string | undefined {
  return (w.mode === "driver" ? w.panes?.driver : undefined) ?? w.session;
}

/**
 * Rol pedido por el CLIENTE → el `%N` de ese pane. Deliberadamente más estricta que paneTargetFor:
 * ahí el fallback al nombre de sesión es aceptable (es I/O del propio server sobre un worker
 * scripted), pero aquí el rol viene de fuera y un `-t <session>` resuelve al pane ACTIVO — que el
 * mouse del operador cambia. Pedir el pane "worker" y recibir el que estuviera activo es peor que
 * un error: no se nota. Todo lo que no se resuelva con certeza es null ⇒ degradar visible.
 */
export function resolvePaneTarget(
  // Acepta `session` para tener la MISMA forma que paneTargetFor y dejar explícito que aquí no se
  // usa como fallback: es justo la diferencia entre las dos funciones.
  w: { mode?: "scripted" | "driver"; panes?: DriverPanes; session?: string },
  role: string
): string | null {
  if (w.mode !== "driver" || !w.panes) return null;
  if (!(PANE_ROLES as readonly string[]).includes(role)) return null;
  if (!Object.hasOwn(w.panes, role)) return null;
  // parsePaneId revalida la forma %N: un registro corrupto no debe llegar a un `-t` de tmux.
  return parsePaneId(w.panes[role as PaneRole] ?? "");
}

/**
 * Memoiza por clave con TTL corto. Guarda la promesa EN VUELO, no el valor resuelto: con una caché
 * de sólo-valor, N pestañas que abran la vista a la vez encuentran el hueco vacío y disparan N×4
 * `capture-pane` simultáneos — justo la amplificación que la caché venía a evitar, y en el peor
 * momento. Un rechazo no se cachea (si no, un blip de tmux rompería la vista durante todo el TTL).
 * `now` es inyectable para poder testear el TTL sin dormir.
 */
export function memoTTL<T>(
  cache: Map<string, { at: number; inflight: Promise<T> }>,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const hit = cache.get(key);
  if (hit && now() - hit.at <= ttlMs) return hit.inflight;
  const inflight = fn();
  cache.set(key, { at: now(), inflight });
  void inflight.catch(() => {
    if (cache.get(key)?.inflight === inflight) cache.delete(key);
  });
  return inflight;
}

// Polls consecutivos sin chrome de claude antes de declarar caído el driver (~6s a 2s/poll).
// Un `capture-pane` puede caer justo en un repintado, así que un solo fallo no basta.
const DRIVER_DOWN_POLLS = 3;
// Umbral de la señal blanda de atasco: por encima del turno típico de un Claude trabajando
// (que además marca el pane busy y resetea el contador) y muy por debajo de un ciclo completo.
const STALL_MS = 15 * 60_000;
const STALL_IDLE_POLLS = 2;

/** Minutos sin avance si aplica la señal blanda de atasco; null si no. */
export function stallNote(msSinceProgress: number, idlePolls: number): { minutes: number } | null {
  if (idlePolls < STALL_IDLE_POLLS || msSinceProgress < STALL_MS) return null;
  return { minutes: Math.floor(msSinceProgress / 60_000) };
}

export interface DriverHealth {
  driverDown?: boolean;
  parked?: { resetAt?: string };
  stalled?: { minutes: number };
  stage?: string;      // etiqueta que sustituye a worker.stage cuando algo va mal
  needsInput: boolean; // driverDown/parked piden acción; stalled es sólo una nota
}

/**
 * Resuelve los 3 estados de salud con precedencia driverDown > parked > stalled, en un solo
 * lugar y testeable sin tmux. Se mantienen separados (y separados de needsInput) porque piden
 * acciones OPUESTAS del operador: caído → relanzar; parqueado → esperar el reset y mandar
 * RESUME; atascado → quizá sólo falta un `touch` del sentinel.
 */
export function driverHealth(input: {
  paneHasClaude: boolean;
  claudeSeen: boolean;
  downPolls: number;
  parked: { resetAt?: string } | null;
  idlePolls: number;
  msSinceProgress: number;
}): DriverHealth {
  // claudeSeen es el latch de arranque: mientras claude nunca haya pintado su TUI en este pane
  // no se puede afirmar que "murió" — simplemente todavía no arrancó (sendWhenReady tolera ~17s).
  if (input.claudeSeen && !input.paneHasClaude && input.downPolls >= DRIVER_DOWN_POLLS) {
    return {
      driverDown: true,
      stage: "✖ driver caído · los panes hermanos pueden seguir corriendo",
      needsInput: true,
    };
  }
  if (input.parked) {
    const at = input.parked.resetAt;
    return {
      parked: input.parked,
      stage: `⏸ worker parqueado por cuota${at ? ` · reset ~${at}` : ""}`,
      needsInput: true,
    };
  }
  const stalled = stallNote(input.msSinceProgress, input.idlePolls);
  if (stalled) {
    return {
      stalled,
      stage: `⏳ sin avance desde hace ${stalled.minutes}m · ¿sentinel olvidado?`,
      needsInput: false,
    };
  }
  return { needsInput: false };
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

// Estado por worker para las 3 señales de salud del modo driver (§ driverHealth).
const claudeSeen = new Set<string>();            // el pane driver YA mostró la TUI de claude (latch de arranque)
const driverDownPolls = new Map<string, number>(); // polls consecutivos sin chrome de claude
const idlePolls = new Map<string, number>();       // polls consecutivos con el pane idle
const lastProgressAt = new Map<string, number>();  // último cambio de etapa o pane ocupado

export function clearDriverHealth(workerId: string): void {
  claudeSeen.delete(workerId);
  driverDownPolls.delete(workerId);
  idlePolls.delete(workerId);
  lastProgressAt.delete(workerId);
}

/**
 * Las 3 señales de salud del modo driver, sobre el snapshot del pane que pollLive ya capturó
 * (sin captura extra). Corre ANTES de la rama de sentinels a propósito: esa rama hace
 * `continue`, así que un chequeo puesto en el fallback busy/idle nunca vería a un driver que ya
 * escribió su primer sentinel — justo el caso que importa.
 * Devuelve true si cambió algo publicable.
 */
export function applyDriverHealth(worker: Worker, pane: string | null, stageChanged: boolean): boolean {
  if (worker.mode !== "driver" || !worker.cycle) return false;
  const now = Date.now();
  // Una captura fallida NO es una observación: no toca claudeSeen (armaría el latch de arranque
  // sin haber visto nunca la TUI) ni los contadores (un blip reseteaba la cuenta de caídas, y
  // "no pude leer" se contaba como idle). Simplemente no se concluye nada este poll.
  const observed = pane !== null;
  const alive = observed && claudeAlive(pane!);
  if (observed) {
    if (alive) {
      claudeSeen.add(worker.id);
      driverDownPolls.delete(worker.id);
    } else {
      driverDownPolls.set(worker.id, (driverDownPolls.get(worker.id) ?? 0) + 1);
    }
  }
  const busy = observed && isBusy(pane!);
  if (observed) idlePolls.set(worker.id, busy ? 0 : (idlePolls.get(worker.id) ?? 0) + 1);
  // En el PRIMER poll de un worker, `stageChanged` no significa nada: no hay observación previa
  // contra la cual comparar (un worker redescubierto llega con stageKey ya sembrado, pero si
  // alguien lo omite el comparador fabrica un "avanzó" falso). Así que el primer poll siempre
  // siembra del sentinel más reciente y IGNORA stageChanged — es lo que impide que un reinicio
  // del server borre un atasco real de horas, sin depender de que el llamador lo haga bien.
  const firstPoll = !lastProgressAt.has(worker.id);
  if (firstPoll) {
    lastProgressAt.set(worker.id, lastSentinelAt(worker.cycle, stepKeys(DRIVER_FLOW)) ?? now);
  } else if (stageChanged || busy) {
    lastProgressAt.set(worker.id, now);
  }

  const parked = parseParkedLimit(readSentinelsTail(worker.cycle)) ?? parkedFromPane(pane);
  const health = driverHealth({
    // Sin observación no se puede afirmar que murió → se pasa "vivo" para que driverDown no
    // dispare; los downPolls quedan intactos, así que 3 fallos REALES seguidos sí lo disparan.
    paneHasClaude: observed ? alive : true,
    claudeSeen: claudeSeen.has(worker.id),
    downPolls: driverDownPolls.get(worker.id) ?? 0,
    parked,
    idlePolls: idlePolls.get(worker.id) ?? 0,
    msSinceProgress: now - (lastProgressAt.get(worker.id) ?? now),
  });

  let changed = false;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (worker.driverDown !== health.driverDown) { worker.driverDown = health.driverDown; changed = true; }
  if (!same(worker.parked, health.parked)) { worker.parked = health.parked; changed = true; }
  if (!same(worker.stalled, health.stalled)) { worker.stalled = health.stalled; changed = true; }
  if (health.stage && worker.stage !== health.stage) { worker.stage = health.stage; changed = true; }
  if (health.needsInput && !worker.needsInput) { worker.needsInput = true; changed = true; }
  return changed;
}

/** Respaldo por pane cuando el sentinels.log no existe (el contrato pide archivo + impresión). */
function parkedFromPane(pane: string | null): { resetAt?: string } | null {
  if (!pane) return null;
  const m = pane.match(/===WORKER-PARKED-LIMIT:(.*?)===/);
  if (!m) return null;
  const at = m[1].trim();
  return at ? { resetAt: at } : {};
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
      stopTtyd(worker.session); // sin esto, cada sesión que muere sola filtra un ttyd + su puerto
      await cleanupWorktree(worker); // P1: remove the worktree (dirty-guarded, refcounted)
      if (worker.cycle) removeCycleDir(worker.cycle);
      workerFlow.delete(worker.id);
      modelSwitchAttempts.delete(worker.id);
      clearWorkerVerify(worker.id);
      clearDriverHealth(worker.id);
      clearPaneCache(worker.id);
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
        // En modo driver se lee el pane DRIVER: `-t <session>` resuelve al pane ACTIVO y con
        // `mouse on` cada click del operador dentro del iframe lo cambiaría.
        paneSnapshot = await capturePane(paneTargetFor(worker) ?? worker.session);
      } catch {
        /* transient */
      }
      if (paneSnapshot !== null && applyContextPressure(worker, paneSnapshot)) changed = true;
      let stageKey = worker.cycle ? detectStage(worker.cycle, stepKeys(flow)) : null;
      // Salud del driver antes de la rama de sentinels (que hace `continue`).
      // `?? undefined` NO es cosmético: detectStage devuelve null y worker.stageKey es undefined,
      // así que `null !== undefined` daría "avanzó" en CADA poll mientras no haya ningún sentinel
      // — justo el caso (driver que murió antes de escribir el primero) donde más falta hace la
      // señal de atasco. Normalizar ambos lados es lo que la deja funcionar.
      if (applyDriverHealth(worker, paneSnapshot, (stageKey ?? undefined) !== worker.stageKey)) changed = true;
      const driverUnhealthy = !!(worker.driverDown || worker.parked);
      // P2: run any eligible verifyCmd gates, then CAP the displayed stage at an unpassed gate so
      // the board never reaches `done` on a false green (B2). The cap consults the persisted
      // pass/fail state synchronously — no reliance on sentinel timing.
      // Modo driver: los gates son maquinaria de "el engine es el driver" — aquí el driver es
      // dueño de sus propias revisiones, y un re-prompt caería en el pane equivocado.
      if (ownsBoard(worker) && worker.cycle && worker.mode !== "driver") {
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
        if (worker.state !== tWorker || (worker.stage !== tLabel && !driverUnhealthy)) {
          const reachedDone = tWorker === "done" && worker.state !== "done";
          worker.state = tWorker;
          // Un driver caído o parqueado ya puso su propia etiqueta: no la pisamos con la etapa
          // del stepper, que sería justo la información engañosa que el badge viene a corregir.
          if (!driverUnhealthy) worker.stage = tLabel;
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
          // En modo driver NO: el refcount sólo cuenta registros Worker, y los panes
          // worker/review/verify no lo son → se borraría (rm -rf) el cwd de 3 procesos vivos.
          // Ahí el worktree se reclama sólo en stopLive o al morir la sesión (4 panes muertos).
          if (reachedDone && worker.mode !== "driver") void cleanupWorktree(worker);
          changed = true;
        }
        // Point 3: a failed OR stuck-pending gate needs operator attention → surface it (the UI
        // already highlights needsInput). A cleanly-progressing worker clears it.
        const wantNeedsInput = gateFailed || gateStuck || driverUnhealthy;
        if (worker.needsInput !== wantNeedsInput) {
          worker.needsInput = wantNeedsInput;
          changed = true;
        }
        // F0: plan→impl reached → switch the pane to the Worker model (once, idle-only).
        if (stageKey) await maybeSwitchModel(worker, flow, stageKey);
        // verifyAfter stage reached on a main worker → spawn the verifier (once). Gate on the
        // per-main-worker set AND the persisted latch (the old `verifierIds.has(worker.id)` guard
        // was ineffective — worker is the PARENT, never in verifierIds — so a restart re-spawned).
        // Modo driver: el verificador es un PANE de la misma ventana, no una sesión aparte.
        if (
          stageKey &&
          worker.mode !== "driver" &&
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
      const pane = paneSnapshot ?? (await capturePane(paneTargetFor(worker) ?? worker.session));
      const busy = isBusy(pane);
      const hint = lastMeaningfulLine(pane);
      const newState: WorkerState = busy ? "busy" : "idle";
      const newStage = busy ? `⚙️ ${hint || "trabajando…"}` : `💤 ${hint || "esperando input"}`;
      const task = findTask(worker.taskId);
      if (worker.state !== newState || (worker.stage !== newStage && !driverUnhealthy)) {
        worker.state = newState;
        if (!driverUnhealthy) worker.stage = newStage;
        if (ownsBoard(worker) && task) task.status = busy ? "running" : "review";
        changed = true;
      }
      // idle while the task isn't done → waiting for the user to respond.
      // Modo driver: el driver queda idle en CADA frontera de turno, así que un solo poll
      // dispararía una tormenta de notificaciones del navegador → se exige idle sostenido.
      const idleEnough = worker.mode === "driver" ? (idlePolls.get(worker.id) ?? 0) >= 2 : true;
      const ni = driverUnhealthy || (!busy && idleEnough && !!task && task.status !== "done");
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
    // Marcador de modo driver, anclado a la cola como los demás. Es la clasificación primaria:
    // sobrevive aunque el cycle dir se haya borrado.
    const isDriver = !isAction && !isVerify && /^-driver(?:-\d+)?$/.test(rest);
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
      : isDriver
      ? DRIVER_FLOW // CRÍTICO: sin esto detectStage buscaría las keys del workflow global
      : action && !action.inheritWorkflow
      ? { stages: action.stages, verifyAfter: action.verifyAfter }
      : resolveFlow(undefined, task?.repo);
    // Modo driver: los panes se re-consultan a tmux (fuente de verdad); reviewTool sale de la
    // opción de sesión, con driver.json de respaldo. tmux guarda el valor VERBATIM sin validar,
    // así que se re-sanitiza siempre.
    let panes: DriverPanes | undefined;
    let reviewTool: "codex" | "agent" | undefined;
    if (isDriver) {
      panes = (await readPaneRoles(session)) ?? undefined;
      const raw =
        (await readSessionReviewTool(session)) ||
        readDriverInfo(cycleDirForSession(session))?.reviewTool ||
        "";
      reviewTool = sanitizeReviewTool(raw);
    }
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
        : isDriver
        ? panes
          ? "↻ driver (redescubierto)"
          : "⚠ driver redescubierto sin panes · targets degradados"
        : "↻ redescubierto",
      startedAt: Date.now(),
      session,
      cwd,
      worktree,
      cycle: cycleDirForSession(session),
      stages: stepSteps(flow),
      // Sembrar la etapa YA detectada, como haría el primer poll. Sin esto, ese primer poll
      // compara stageKey (real, del disco) contra undefined y fabrica un "avanzó" que no ocurrió
      // — lo que reseteaba el reloj de atasco en CADA reinicio del server, justo el caso que la
      // señal de "sin avance" existe para cubrir.
      stageKey: detectStage(cycleDirForSession(session), stepKeys(flow)) ?? undefined,
      ...(isDriver ? { mode: "driver" as const, reviewTool, panes } : {}),
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
  // Modo driver sólo tiene sentido en live (en simulado no hay tmux); la UI además deshabilita
  // el toggle, así que aquí basta con caer al camino simulado de siempre.
  if (activeMode !== "live") return launchSimulated(taskId);
  return opts.mode === "driver" ? launchDriverLive(taskId, opts) : launchLive(taskId, stageKeys, opts);
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
  clearPaneCache(workerId); // por simetría: un worker simulado no tiene panes, pero el próximo que
  removeWorker(workerId);   // toque esto no debería tener que razonarlo
  emit();
  return true;
}

/**
 * Abre una Terminal.app attachada a la sesión. Con `role` (modo driver) zoomea ANTES ese pane, para
 * que la terminal nativa abra mostrándolo a pantalla completa en vez de los 4 comprimidos.
 *
 * Si el zoom no se pudo aplicar, ABORTA sin abrir nada: una Terminal que muestra los 4 panes
 * cuando pediste "abrir el pane worker" es peor que un error, porque parece que funcionó. El
 * chequeo sólo vale porque focusPane verifica de verdad (relee el estado), no porque haya
 * encontrado un %N.
 *
 * `openTerminal` sigue recibiendo SÓLO `worker.session`: su argumento se interpola en un AppleScript
 * que Terminal.app ejecuta como shell, así que ningún dato derivado del cliente puede llegar ahí.
 */
export async function attachWorker(
  workerId: string,
  role?: PaneRole | null,
  deps: FocusDeps = REAL_FOCUS
): Promise<FocusResult> {
  const worker = findWorker(workerId);
  if (!worker?.session) return "no-session";
  if (role) {
    const r = await focusPane(workerId, role, deps);
    if (r !== "ok" && r !== "noop") return r;
  }
  await deps.terminal(worker.session);
  return "ok";
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
  // Modo driver: responder desde la UI debe llegar al pane del DRIVER, no al que el mouse
  // haya dejado activo (que puede ser el de codex, o un shell donde el texto se ejecutaría).
  await sendText(paneTargetFor(worker) ?? worker.session, text, true);
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
