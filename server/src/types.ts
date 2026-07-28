import type { WfStage } from "./workflow.js"; // type-only (workflow.ts sólo importa tipos de aquí → ciclo inofensivo)
import type { PaneRole, PaneStatus } from "./tmux.js"; // type-only (tmux.ts no importa este archivo)

export type Source = "clickup" | "jira" | "gitlab" | "adhoc" | "pr" | "custom";

export type TaskStatus = "queued" | "triage" | "running" | "review" | "done";

export type WorkerState = "starting" | "busy" | "review" | "idle" | "done";

export type Priority = "urgent" | "high" | "normal" | "low" | "none";

export interface Task {
  id: string;
  key: string;            // CU-4821, JIRA-12, etc.
  title: string;
  repo: string;
  source: Source;
  status: TaskStatus;     // internal 5-state category (board logic, color, sort)
  statusLabel?: string;   // raw status as shown in the source (English in ClickUp/Jira)
  priority?: Priority;    // urgent / high / normal / low / none
  dateCreated?: number;   // ms epoch (live). Absent in seed → key is the order proxy
  listId?: string;        // ClickUp list id (used for the NightShift visibility rule)
  body?: string;          // ad-hoc tasks: the full pasted text (DM / question); PR tasks: the PR url
  complex?: boolean;      // ad-hoc complex DM → orchestrate via /tmux-worker-loop
  url?: string;           // deep link back to ClickUp/Jira/GitLab
  workerId?: string;
}

export interface Worker {
  id: string;
  label: string;          // "worker #1"
  kind?: "task" | "research" | "action"; // default (undefined) = task; "research"/"action" = desacoplados del tablero
  actionKey?: string;     // set cuando kind === "action" (qué CustomAction lo lanzó)
  repo: string;
  taskId: string;
  state: WorkerState;
  stage: string;          // human label of current stage
  startedAt: number;
  session?: string;       // tmux session name (live mode)
  cwd?: string;           // working directory of the pane (live mode)
  worktree?: string;      // P1: ephemeral git worktree path (live task workers); absent → shares repo root
  cycle?: string;         // cycle dir (sentinels + evidence), keyed by session
  stageKey?: string;      // current pipeline stage key (planning/implementing/curl/verify/done)
  needsInput?: boolean;   // idle while the task isn't done → waiting for the user
  stages?: WfStep[];      // this worker's resolved stepper steps (per-launch subset)
  verifyFailure?: { stageKey: string; output: string }; // P2: a stage's verifyCmd gate exhausted its retries
  contextPressure?: { tokens?: number; note: string };  // P4: pane under context pressure (auto-compact / /clear)
  // ---- Modo Driver: ventana tmux de 4 panes orquestada por un Claude driver real ----
  mode?: "scripted" | "driver"; // default (undefined) = scripted; mismo patrón opcional que kind
  reviewTool?: "codex" | "agent"; // sólo si mode === "driver": qué corre en el pane de review
  panes?: DriverPanes;            // ids %N de tmux por rol; la fuente de verdad es tmux
  // Salud del driver. Excluyentes por precedencia (driverDown > parked > stalled): las tres
  // piden acciones OPUESTAS del operador, por eso no se colapsan en needsInput.
  driverDown?: boolean;           // el claude del pane driver murió; los hermanos pueden seguir corriendo
  parked?: { resetAt?: string };  // el worker se auto-parqueó por límite de uso (===WORKER-PARKED-LIMIT===)
  stalled?: { minutes: number };  // idle sin sentinel nuevo desde hace N minutos (señal blanda)
}

/** Ids de pane tmux (%N) de la ventana driver, por rol. Estables mientras viva el pane. */
export interface DriverPanes {
  driver: string;
  worker: string;
  review: string;
  verify: string;
}

// PANE_ROLES vive en tmux.ts (es una constante en runtime, no sólo un tipo). Se re-exportan los
// tipos desde aquí para que el par espejado server/web tenga una sola lista de roles. Type-only ⇒
// sin ciclo (tmux.ts no importa este archivo).
export type { PaneRole, PaneStatus };

/**
 * Estado de UN pane de la ventana driver, para la lista por pane de la vista ⌘ Sessions. No vive
 * en el Worker ni en el Snapshot: se deriva bajo demanda (igual que driverDown/parked/stalled) y
 * viaja por su propio endpoint, porque `hint` cambia en cada poll y engordaría el stream de SSE.
 */
export interface PaneView {
  role: PaneRole;
  paneId: string;         // %N — informativo para la UI; el cliente NUNCA lo manda de vuelta
  status: PaneStatus;     // working | idle | shell ("sin arrancar", NO caído) | gone
  hint: string;           // última línea significativa del pane
  contextPressure?: { tokens?: number; note: string };
}

/**
 * Acción/flujo definido por el usuario (opción A). Cada acción = un botón en las tareas
 * con su prompt custom, etapas propias (o inheritWorkflow → workflow global/por-repo) y flags.
 * Store editable en data/actions.json (server/src/actions.ts). Desacoplada del tablero como research.
 */
export interface CustomAction {
  key: string;                     // slug único
  label: string;                   // texto del botón
  icon: string;                    // emoji
  prompt: string;                  // prompt propio (placeholders {title}{key}{repo}{body}{url}{ref}{cycle}{ev}{steps}{verifier}{var:KEY})
  stages: WfStage[];               // etapas propias (ignoradas si inheritWorkflow)
  verifyAfter: string | null;
  inheritWorkflow: boolean;        // true → usa el workflow global/por-repo (resolveFlow)
  readOnly: boolean;               // reforzado por el prompt; el flag es informativo (label)
  showOn: ("row" | "preview")[];   // dónde aparece el botón (default ambos)
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
  pins: string[];         // task ids pinned as "today's plan"
  order: string[];        // manual ordering of tasks (secondary sort within priority)
  stages: WfStep[];       // composable workflow steps (drives the visual stepper)
}

export interface WfStep {
  key: string;
  label: string;
  icon: string;
}
