import type { WfStage } from "./workflow.js"; // type-only (workflow.ts sólo importa tipos de aquí → ciclo inofensivo)

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
  cycle?: string;         // cycle dir (sentinels + evidence), keyed by session
  stageKey?: string;      // current pipeline stage key (planning/implementing/curl/verify/done)
  needsInput?: boolean;   // idle while the task isn't done → waiting for the user
  stages?: WfStep[];      // this worker's resolved stepper steps (per-launch subset)
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
