export type Source = "clickup" | "jira" | "gitlab" | "adhoc" | "pr" | "custom";
export type TaskStatus = "queued" | "triage" | "running" | "review" | "done";
export type WorkerState = "starting" | "busy" | "review" | "idle" | "done";
export type Priority = "urgent" | "high" | "normal" | "low" | "none";

export interface Task {
  id: string;
  key: string;
  title: string;
  repo: string;
  source: Source;
  status: TaskStatus;
  statusLabel?: string;
  priority?: Priority;
  dateCreated?: number;
  listId?: string;
  url?: string;
  body?: string;         // adhoc/custom: mensaje disparador; clickup/jira: descripción del ticket; pr: url
  workerId?: string;
}

export interface Worker {
  id: string;
  label: string;
  kind?: "task" | "research" | "action";
  actionKey?: string;    // set cuando kind === "action" (qué CustomAction lo lanzó)
  repo: string;
  taskId: string;
  state: WorkerState;
  stage: string;
  startedAt: number;
  session?: string;
  cwd?: string;
  worktree?: string;     // P1: ephemeral git worktree path (informativo)
  stageKey?: string;
  needsInput?: boolean;
  stages?: WfStep[];
  verifyFailure?: { stageKey: string; output: string }; // P2: gate verifyCmd agotó reintentos
  contextPressure?: { tokens?: number; note: string };  // P4: pane bajo presión de contexto
  // ---- Modo Driver (espejo de server/src/types.ts; el desajuste aquí es SILENCIOSO, es JSON) ----
  mode?: "scripted" | "driver";   // ausente = scripted
  reviewTool?: "codex" | "agent"; // sólo si mode === "driver"
  panes?: DriverPanes;
  driverDown?: boolean;           // driver caído → relanzar
  parked?: { resetAt?: string };  // parqueado por cuota → esperar al reset y mandar RESUME
  stalled?: { minutes: number };  // sin avance → quizá un sentinel olvidado (señal blanda)
}

export interface DriverPanes {
  driver: string;
  worker: string;
  review: string;
  verify: string;
}

// Espejo de server/src/types.ts (que a su vez re-exporta PaneRole/PaneStatus de tmux.ts, donde
// PANE_ROLES es constante en runtime). Aquí se declaran literales porque el espejo es manual.
export type PaneRole = "driver" | "worker" | "review" | "verify";
/** shell = el pane está en un shell desnudo: "sin arrancar", NO "caído" (review/verify nacen así). */
export type PaneStatus = "working" | "idle" | "shell" | "gone";

/** Estado de un pane de la ventana driver. No viaja en el Snapshot: tiene su propio endpoint. */
export interface PaneView {
  role: PaneRole;
  paneId: string;
  status: PaneStatus;
  hint: string;
  contextPressure?: { tokens?: number; note: string };
}

export interface CustomAction {
  key: string;
  label: string;
  icon: string;
  prompt: string;
  stages: WfStage[];
  verifyAfter: string | null;
  inheritWorkflow: boolean;
  readOnly: boolean;
  showOn: ("row" | "preview")[];
}

export interface Integration {
  name: string;
  status: "connected" | "pilot" | "roadmap";
}

export type TaskSource = "clickup-live" | "clickup-seed" | "mock";

export interface Snapshot {
  tasks: Task[];
  workers: Worker[];
  integrations: Integration[];
  mode: "simulated" | "live";
  taskSource: TaskSource;
  lastSync: number | null;
  pins: string[];
  order: string[];
  stages: WfStep[];
}

export interface WfStep {
  key: string;
  label: string;
  icon: string;
}

export interface WfStage extends WfStep {
  instruction?: string;
  role?: "impl";               // marca la etapa de implementación (dispara el switch de modelo)
  verifyCmd?: string;          // P2: gate pass/fail (solo override por-repo; ejecuta shell)
  maxRetries?: number;         // P2: reintentos antes de marcar la etapa como fallida
}

export interface WorkflowConfig {
  stages: WfStage[];
  verifyAfter: string | null;
}

export interface PromptTemplate {
  key: string;
  label: string;
  template: string;          // texto efectivo (override o default)
  isDefault: boolean;
  placeholders: string[];
}

export interface HistoryEvent {
  ts: number;
  type: "launch" | "complete" | "stop";
  key: string;
  title: string;
  source: string;
  repo: string;
}

export interface ReportMeta {
  name: string;                    // daily-2026-07-02 | weekly-2026-W27
  kind: "daily" | "weekly";
  date: string;                    // periodo (fecha o AAAA-Www)
  ts: number;                      // mtime ms
  size: number;
}

export interface ReposConfig {
  defaultPath: string;
  repos: { key: string; path: string }[];
}

export interface RepoOverrideConfig {
  workflow: WorkflowConfig | null;   // null = hereda el default global
  vars: Record<string, string>;
  startCommand: string;              // "" = usa CLAUDE_CMD
  plannerModel: string;              // "" = hereda COWORK_PLANNER_MODEL
  workerModel: string;               // "" = hereda COWORK_WORKER_MODEL
  usesDefaultWorkflow: boolean;
}

export interface ConnectorSettings {
  clickup: { hasToken: boolean; teamId: string; listIds: string[] };
  jira: { hasToken: boolean; baseUrl: string; email: string; jql: string };
  gitlab: { hasToken: boolean; baseUrl: string; project: string };
}

export interface ConnectorSettingsInput {
  clickup?: { token?: string; teamId?: string; listIds?: string };
  jira?: { token?: string; baseUrl?: string; email?: string; jql?: string };
  gitlab?: { token?: string; baseUrl?: string; project?: string };
}
