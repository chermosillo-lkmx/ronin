export type TmuxDiagnosticCode = "TMUX_NOT_FOUND" | "TMUX_SERVER_UNREACHABLE" | "TMUX_INVENTORY_FAILED";

export interface TmuxDiagnostic {
  code: TmuxDiagnosticCode;
  detail: string;
}

export interface TmuxInventoryResult {
  sessions: TmuxSessionInfo[];
  diagnostic: TmuxDiagnostic | null;
}

// Espejo de server/src/types.ts (T2). El detalle persistido de una adopción; la autoridad
// real vive en tmux (@cowork-adopted), esto sólo informa a la UI.
export interface AdoptionRecord {
  version: 1;
  session: string;
  repo: string;
  cwd: string;
  paneId: string;
  sessionCreatedAt: number;
  adoptedAt: number;
  workflow: WorkflowConfig;
}

// Espejo de server/src/types.ts (que a su vez re-exporta PaneRole/PaneStatus de tmux.ts, donde
// PANE_ROLES es constante en runtime). Aquí se declaran literales porque el espejo es manual.
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

export interface WorkflowCatalogItem {
  id: string;
  name: string;
  config: WorkflowConfig;
  updatedAt: number;
}

export interface WorkflowCatalog {
  version: 1;
  items: WorkflowCatalogItem[];
}

export interface PromptTemplate {
  key: string;
  label: string;
  template: string;          // texto efectivo (override o default)
  isDefault: boolean;
  placeholders: string[];
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

export interface TrustedRoots {
  roots: string[];
  source: "env" | "settings";
}

export interface RepoOverrideConfig {
  workflow: WorkflowConfig | null;   // null = hereda el default global
  vars: Record<string, string>;
  startCommand: string;              // "" = usa CLAUDE_CMD
  plannerModel: string;              // "" = hereda COWORK_PLANNER_MODEL
  workerModel: string;               // "" = hereda COWORK_WORKER_MODEL
  usesDefaultWorkflow: boolean;
  skills: SkillRef[];
}

export type SkillRoot = "global" | "repo-claude" | "repo-skills";
export interface SkillRef {
  root: SkillRoot;
  name: string;
  sourceRepo?: string;
}
export interface SkillSummary {
  ref: SkillRef;
  name: string;
  description: string;
  valid: boolean;
  error?: string;
}
export interface SkillDocument extends SkillSummary {
  content: string;
  valid: true;
}

// ---- Inventario tmux + preflight (F1). Espejo MANUAL de server/src/types.ts ----
// El desajuste sería silencioso: viaja como JSON sin validación en la frontera. Si cambias uno,
// cambia el otro en el mismo commit.

export interface TmuxPaneInfo {
  id: string;
  windowIndex: number;
  command: string;
  title: string;
  role: string | null;
  active: boolean;
}

/** Etiqueta local para operar una sesión sin alterar su identificador real en tmux. */
export interface SessionPresentation {
  title: string;
  repo: string | null;
}

export interface TmuxSessionInfo {
  name: string;
  kind: "managed" | "foreign";
  windows: number;
  panes: TmuxPaneInfo[];
  createdAt: number;
  attached: boolean;
  adopted: boolean; // derivado de @cowork-adopted en el inventario (T3)
  presentation?: SessionPresentation;
  request?: string;
}

export type CheckLevel = "ok" | "warn" | "fail";

export interface PreflightCheck {
  key: string;
  label: string;
  level: CheckLevel;
  detail: string;
  note?: string;
}

// ---- Test harness (espejo de server/src/test-harness/model.ts + service.ts; sólo formas PÚBLICAS) ----

export type TestSuite = "unit" | "e2e" | "api" | "browser";
export type TestRunStatus = "queued" | "running" | "passed" | "failed" | "error" | "timeout" | "cancelled" | "blocked";
export type TestCellState = "unconfigured" | "never_run" | TestRunStatus;

export interface TestCommandSpec {
  program: string;
  args: string[];
}

export interface TestSuiteConfig {
  command: TestCommandSpec;
  cwd?: string;
  timeoutMs: number;
  junitPath?: string;
  coberturaPath?: string;
  lcovPath?: string;
}

/** Perfil tal como lo publica el server: NOMBRES de variable, nunca valores. */
export interface TestPublicProfile {
  name: string;
  variables: string[];
  apiBaseUrl?: string;
  allowedOrigins: string[];
  allowMutations: boolean;
}

export interface TestRepoConfig {
  repo: string;
  configured: boolean;
  profiles: TestPublicProfile[];
  suites: Partial<Record<TestSuite, TestSuiteConfig>>;
}

export interface TestCoverage {
  status: "reported" | "not_reported" | "invalid" | "not_applicable";
  lines?: number;
  branches?: number;
  reason?: string;
}

export interface TestTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
}

export interface TestRun {
  runId: string;
  batchId?: string;
  repo: string;
  suite: TestSuite;
  profile: string;
  status: TestRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  command?: TestCommandSpec;
  cwd?: string;
  totals?: TestTotals;
  totalsReason?: string;
  coverage?: TestCoverage;
  failures?: { name: string; classname?: string; message: string }[];
  stdout?: string;
  stderr?: string;
  artifacts?: string[];
  reason?: string;
}

export interface TestMatrixCell {
  suite: TestSuite;
  state: TestCellState;
  runId?: string;
  finishedAt?: string;
  durationMs?: number;
  totals?: TestTotals;
  coverage?: TestCoverage;
  reason?: string;
}

export interface TestMatrixRow {
  repo: string;
  configured: boolean;
  profiles: string[];
  cells: Record<TestSuite, TestMatrixCell>;
}

export type TestSelection =
  | { kind: "suites"; repo: string; profile: string; suites: TestSuite[] }
  | { kind: "all"; profile: string }
  | { kind: "failed"; profile: string };

export interface TestStartResult {
  batchId?: string;
  runIds: string[];
}

// ---- Workflow insights (espejo de server/src/workflow-insights/model.ts) ----
export type ProposalStatus = "proposed" | "accepted" | "dismissed";

export interface WorkflowProposal {
  id: string;
  analysisId: string;
  name: string;
  rationale: string;
  evidence: string[];
  config: WorkflowConfig;
  status: ProposalStatus;
  createdAt: string;
  catalogId?: string;          // sólo al aceptar
}

export interface WorkflowAnalysis {
  id: string;
  from: string;                // ISO
  to: string;                  // ISO
  status: "running" | "done" | "error";
  createdAt: string;
  finishedAt?: string;
  proposalIds: string[];
  discarded: { name?: string; reason: string }[];
  error?: string;
  signals: { tasks: number; commits: number; evidenceFiles: number };
}
