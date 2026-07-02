import { MODE } from "./config.js";
import { currentOrder } from "./order.js";
import { currentPins } from "./today.js";
import { getStepperStages } from "./workflow.js";
import type { Integration, Snapshot, Task, TaskSource, Worker } from "./types.js";

/**
 * In-memory store for Fase 0. Single source of truth for the dashboard.
 * Fase 1+ will swap the mutation functions for real tmux / ClickUp side effects,
 * but the snapshot + subscriber contract stays the same.
 */

let workerSeq = 1;

// Generic fallback used only when there is neither a ClickUp token nor a seed file.
export const MOCK_TASKS: Task[] = [
  { id: "t1", key: "CU-4821", title: "fix(app) login crash en Safari", repo: "ant-liebre-app", source: "clickup", status: "running" },
  { id: "t2", key: "CU-4830", title: "feat(api) export CFDI por lote", repo: "ant-liebre-api", source: "clickup", status: "review" },
  { id: "t3", key: "CU-4799", title: "sentry: NullPointer en journal entry", repo: "ant-liebre-api", source: "clickup", status: "triage" },
  { id: "t4", key: "CU-4842", title: "refactor(permissions) cache de RBAC", repo: "ant-ms-permissions", source: "clickup", status: "queued" },
  { id: "t5", key: "CU-4851", title: "feat(i18n) catálogo de errores DUPLICATE_ENTRY", repo: "ant-ms-i18n", source: "clickup", status: "queued" },
  { id: "t6", key: "CU-4860", title: "chore(cfdis) bump dependencias", repo: "ant-ms-cfdis", source: "clickup", status: "queued" },
];

// Live board state — populated at startup by the task provider.
export const tasks: Task[] = [];

export const workers: Worker[] = [];

/**
 * Replace the task list in place (keeps the exported array reference stable).
 * Preserves the worker link + status of any task that currently has an active
 * worker, so a background ClickUp refresh never clobbers in-flight work.
 */
export function setTasks(next: Task[]): void {
  const linked = new Map(
    tasks.filter((t) => t.workerId).map((t) => [t.id, { workerId: t.workerId, status: t.status }])
  );
  const merged = next.map((t) => {
    const keep = linked.get(t.id);
    return keep ? { ...t, workerId: keep.workerId, status: keep.status } : t;
  });
  tasks.splice(0, tasks.length, ...merged);
  emit();
}

export const integrations: Integration[] = [
  { name: "ClickUp", status: "connected" },
  { name: "Jira", status: "pilot" },
  { name: "GitLab", status: "roadmap" },
];

export function setIntegrations(next: Integration[]): void {
  integrations.splice(0, integrations.length, ...next);
}

// Effective mode — starts at the configured value but may fall back to
// "simulated" at runtime (e.g. tmux unavailable in live mode).
let currentMode: Snapshot["mode"] = MODE;
export function setMode(m: Snapshot["mode"]): void {
  currentMode = m;
}

let currentTaskSource: TaskSource = "mock";
export function setTaskSource(s: TaskSource): void {
  currentTaskSource = s;
}

let lastSync: number | null = null;
export function setLastSync(ts: number): void {
  lastSync = ts;
}

export function snapshot(): Snapshot {
  return {
    tasks: tasks.map((t) => ({ ...t })),
    workers: workers.map((w) => ({ ...w })),
    integrations: integrations.map((i) => ({ ...i })),
    mode: currentMode,
    taskSource: currentTaskSource,
    lastSync,
    pins: currentPins(),
    order: currentOrder(),
    stages: getStepperStages().map((s) => ({ key: s.key, label: s.label, icon: s.icon })),
  };
}

// ---- subscribers (SSE) ----
type Listener = (s: Snapshot) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(): void {
  const s = snapshot();
  for (const fn of listeners) fn(s);
}

// ---- mutations ----
export function nextWorkerLabel(): string {
  return `worker #${workerSeq++}`;
}

export function findTask(id: string): Task | undefined {
  return tasks.find((t) => t.id === id);
}

/** Add a task to the board (used for ad-hoc tasks). */
export function addTask(task: Task): void {
  tasks.push(task);
  emit();
}

export function findWorker(id: string): Worker | undefined {
  return workers.find((w) => w.id === id);
}

export function removeWorker(id: string): void {
  const idx = workers.findIndex((w) => w.id === id);
  if (idx >= 0) workers.splice(idx, 1);
}
