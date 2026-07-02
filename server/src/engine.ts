import { AUTOSUBMIT, MODE } from "./config.js";
import { fetchClickUpDescription } from "./clickup.js";
import { recordEvent } from "./history.js";
import { resolveCwd } from "./repos.js";
import { cycleDirForSession, detectStage, ensureCycleDir, removeCycleDir } from "./stages.js";
import { writeCurlEnv } from "./curl-config.js";
import { getRepoStartCommand, getRepoVars } from "./repo-config.js";
import { getAction, getActions } from "./actions.js";
import { buildActionPrompt, buildResearchPrompt, buildVerifierPrompt, buildWorkerPrompt } from "./templates.js";
import { liveMapFor, resolveFlow, stepperFor, type WfStage } from "./workflow.js";
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
  sendText,
  tmuxAvailable,
} from "./tmux.js";
import type { CustomAction, Task, TaskStatus, Worker, WorkerState } from "./types.js";

function logEvent(type: "launch" | "complete" | "stop", task: Task): void {
  recordEvent({ type, key: task.key, title: task.title, source: task.source, repo: task.repo });
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
    logEvent("complete", task);
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
async function uniqueSession(base: string): Promise<string> {
  let name = `cowork-${base}`;
  for (let n = 2; await hasSession(name); n++) name = `cowork-${base}-${n}`;
  return name;
}

async function launchLive(taskId: string, stageKeys?: string[]): Promise<Worker | null> {
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

  ensureCycleDir(worker.cycle!);
  const vars = getRepoVars(task.repo); // per-repo test vars (merged into curl.env + {var:KEY} in the prompt)
  writeCurlEnv(task.repo, worker.cycle!, vars); // per-project dev creds + repo vars for the curl stage
  // Enrich the prompt with the full ticket description (best-effort, ClickUp only).
  if (task.source === "clickup" && !task.body) {
    const desc = await fetchClickUpDescription(task.id);
    if (desc) task.body = desc;
  }
  try {
    await createSession(session, cwd, getRepoStartCommand(task.repo));
    const prompt = buildWorkerPrompt(task, worker.cycle!, flow, vars);
    // Send once claude's input is actually ready (handles boot lag + dialogs).
    void sendWhenReady(session, prompt);
    worker.state = "idle";
    worker.stage = real
      ? AUTOSUBMIT
        ? "💬 enviando requerimiento…"
        : "💬 template en el prompt (revisa y Enter)"
      : "⚠️ repo no encontrado · cwd de respaldo";
  } catch {
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
    await createSession(session, cwd, getRepoStartCommand(task.repo));
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
    await createSession(session, cwd, getRepoStartCommand(task.repo));
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

async function stopLive(workerId: string): Promise<boolean> {
  const worker = findWorker(workerId);
  if (!worker) return false;
  if (worker.session) {
    stopTtyd(worker.session);
    await killSession(worker.session);
  }
  if (worker.cycle) removeCycleDir(worker.cycle);
  const task = findTask(worker.taskId);
  if (ownsBoard(worker) && task) {
    if (task.status !== "done") {
      task.status = "queued";
      task.workerId = undefined;
    }
    logEvent("stop", task);
  }
  workerFlow.delete(workerId);
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
  // Incluye el marcador -action-<key> cuando el padre es una acción, para que rediscoverSessions
  // lo detecte como desacoplado tras un reinicio (y no agarre el tablero).
  // Mismo esquema que launchActionLive (partes sanitizadas por separado) para que ambos caminos coincidan
  // y el marcador -action- sobreviva al truncado.
  const vbase =
    mainWorker.kind === "action" && mainWorker.actionKey
      ? `${sanitizeKey(task.key)}-action-${sanitizeKey(mainWorker.actionKey)}`
      : sanitizeKey(task.key);
  const session = await uniqueSession(`${vbase}-verify`);
  const cwd = mainWorker.cwd ?? resolveCwd(task.repo).cwd;
  const id = `v${Date.now().toString(36)}`;
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
    session,
    cwd, // no own cycle: reads/writes the main worker's cycle via absolute paths
  };
  verifierIds.add(id);
  workers.push(worker);
  emit();
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
      if (worker.cycle) removeCycleDir(worker.cycle);
      workerFlow.delete(worker.id);
      removeWorker(worker.id);
      changed = true;
      continue;
    }
    try {
      // Loop-stage sentinels take precedence: they reflect the real pipeline.
      // Fallback (worker rediscovered after a restart) resolves over the repo's workflow.
      const flow = workerFlow.get(worker.id) ?? resolveFlow(undefined, worker.repo);
      const stageKey = worker.cycle ? detectStage(worker.cycle, stepKeys(flow)) : null;
      const stage = stageKey ? liveMapFor(flow.stages, flow.verifyAfter).get(stageKey) : undefined;
      if (stage) {
        if (worker.stageKey !== stageKey) {
          worker.stageKey = stageKey ?? undefined;
          changed = true;
        }
        if (worker.state !== stage.worker || worker.stage !== stage.label) {
          const reachedDone = stage.worker === "done" && worker.state !== "done";
          worker.state = stage.worker;
          worker.stage = stage.label;
          if (ownsBoard(worker)) {
            const task = findTask(worker.taskId);
            if (task) {
              task.status = stage.task;
              if (reachedDone) logEvent("complete", task);
            }
          }
          changed = true;
        }
        if (worker.needsInput) {
          worker.needsInput = false; // progressing through the pipeline
          changed = true;
        }
        // verifyAfter stage reached on a main worker → spawn the verifier (once)
        if (stageKey && flow.verifyAfter && stageKey === flow.verifyAfter && !verifierIds.has(worker.id)) {
          void spawnVerifier(worker);
        }
        continue;
      }

      // No sentinel yet → fall back to the busy/idle pane heuristic.
      const pane = await capturePane(worker.session);
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
      cwd: task ? resolveCwd(task.repo).cwd : undefined,
      cycle: cycleDirForSession(session),
      stages: stepSteps(flow),
    };
    workerFlow.set(worker.id, flow); // research/action/global: pollLive usa el flow correcto tras reinicio
    workers.push(worker);
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

// ============================================================
//  PUBLIC API  (mode-dispatched)
// ============================================================

export async function launchTask(taskId: string, stageKeys?: string[]): Promise<Worker | null> {
  return activeMode === "live" ? launchLive(taskId, stageKeys) : launchSimulated(taskId);
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
    logEvent("stop", task);
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
  stageKeys?: string[]
): Promise<Worker | null> {
  const id = `custom-${Date.now().toString(36)}`;
  const title = text.split("\n").find((l) => l.trim())?.trim().slice(0, 70) || "petición";
  addTask({ id, key: id, title, body: text, repo, source: "custom", status: "running" });
  return launchTask(id, stageKeys);
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
    setInterval(() => {
      pollLive().catch(() => {});
    }, 2000);
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
