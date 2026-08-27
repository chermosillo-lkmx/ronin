import type { TestMatrixRow, TestRepoConfig, TestRun, TestSelection, TestStartResult, TestSuite, PreflightCheck, PromptTemplate, RepoOverrideConfig, ReportMeta, ReposConfig, SessionPresentation, SkillDocument, SkillRef, SkillSummary, TmuxInventoryResult, TmuxSessionInfo, ProposalStatus, TrustedRoots, WorkflowAnalysis, WorkflowCatalog, WorkflowCatalogItem, WorkflowConfig, WorkflowProposal } from "./types";

/** Carries the server's {path, code} (T11/T13) so a save failure can be shown per-field, or as
 *  a clear "someone is mid-flight on this stage" message (STAGE_IN_FLIGHT, T13), not just text. */
export class WorkflowSaveError extends Error {
  readonly path?: string;
  readonly code?: string;
  constructor(message: string, path?: string, code?: string) {
    super(message);
    this.name = "WorkflowSaveError";
    this.path = path;
    this.code = code;
  }
}

export async function getWorkflow(): Promise<WorkflowConfig | null> {
  const r = await fetch("/api/workflow");
  return r.ok ? r.json() : null;
}

export async function saveWorkflow(cfg: WorkflowConfig): Promise<WorkflowConfig> {
  const r = await fetch("/api/workflow", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new WorkflowSaveError(e.error || "no se pudo guardar el workflow", e.path, e.code);
  }
  return r.json();
}

export async function getWorkflowCatalog(): Promise<WorkflowCatalog | null> {
  const r = await fetch("/api/workflows");
  return r.ok ? r.json() : null;
}

export async function createWorkflow(name: string, config: WorkflowConfig): Promise<WorkflowCatalogItem> {
  const r = await fetch("/api/workflows", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, config }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new WorkflowSaveError(e.error || "no se pudo crear el workflow", e.path, e.code);
  }
  return r.json();
}

export async function updateWorkflow(id: string, input: { name?: string; config?: WorkflowConfig }): Promise<WorkflowCatalogItem> {
  const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new WorkflowSaveError(e.error || "no se pudo guardar el workflow", e.path, e.code);
  }
  return r.json();
}

export async function deleteWorkflow(id: string): Promise<void> {
  const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new WorkflowSaveError(e.error || "no se pudo eliminar el workflow", undefined, e.code);
  }
}

export async function listLocalSkills(): Promise<SkillSummary[]> {
  const r = await fetch("/api/skills");
  return r.ok ? ((await r.json()).skills ?? []) : [];
}

function skillQuery(ref: SkillRef): string {
  const params = new URLSearchParams({ root: ref.root, name: ref.name });
  if (ref.sourceRepo) params.set("sourceRepo", ref.sourceRepo);
  return params.toString();
}

async function skillResult<T>(response: Response | Promise<Response>): Promise<T> {
  const r = await response;
  if (r.ok) return r.json();
  const error = await r.json().catch(() => ({}));
  throw new Error(error.error || "no se pudo operar la skill");
}

export async function readLocalSkill(ref: SkillRef): Promise<SkillDocument> {
  return skillResult(fetch(`/api/skills/read?${skillQuery(ref)}`));
}
export async function createLocalSkill(ref: SkillRef, content: string): Promise<SkillDocument> {
  return skillResult(fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ref, content }) }));
}
export async function saveLocalSkill(ref: SkillRef, content: string): Promise<SkillDocument> {
  return skillResult(fetch("/api/skills", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...ref, content }) }));
}
export async function downloadLocalSkill(ref: SkillRef): Promise<Blob> {
  const r = await fetch(`/api/skills/archive?${skillQuery(ref)}`);
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || "no se pudo empaquetar la skill");
  }
  return r.blob();
}
export async function saveRepoSkillAssociations(repo: string, skills: SkillRef[]): Promise<RepoOverrideConfig> {
  return skillResult(fetch(`/api/repo-config/${encodeURIComponent(repo)}/skills`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skills }),
  }));
}

export interface WorkflowFieldError {
  path: string;
  code: string;
  message: string;
}
export type WorkflowValidateResult = { ok: true; config: WorkflowConfig } | { ok: false; error: WorkflowFieldError };

/** T12/T14: trial-validate WITHOUT persisting — for live, per-field feedback in the editor. */
export async function validateWorkflow(cfg: WorkflowConfig): Promise<WorkflowValidateResult> {
  const r = await fetch("/api/workflow/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  return r.json();
}

/** Same trial-validation, routed to a repo override (verifyCmd honored — gitignored, per-repo). */
export async function validateRepoWorkflow(repo: string, cfg: WorkflowConfig): Promise<WorkflowValidateResult> {
  const r = await fetch(`/api/repo-config/${encodeURIComponent(repo)}/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workflow: cfg }),
  });
  return r.json();
}

export async function getPrompts(): Promise<PromptTemplate[] | null> {
  const r = await fetch("/api/prompts");
  return r.ok ? r.json() : null;
}

export async function savePrompt(key: string, template: string): Promise<PromptTemplate[]> {
  const r = await fetch(`/api/prompts/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ template }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo guardar el prompt");
  }
  return r.json();
}

export async function resetPrompt(key: string): Promise<PromptTemplate[]> {
  const r = await fetch(`/api/prompts/${encodeURIComponent(key)}/reset`, { method: "POST" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo restablecer el prompt");
  }
  return r.json();
}


export type SessionTerminalResult = { url: string; error: null } | { url: null; error: string };

/** URL de ttyd de una sesión tmux, o el motivo legible para mostrar en la superficie de respaldo. */
export async function getSessionTerminalUrl(name: string): Promise<SessionTerminalResult> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(name)}/term`, { method: "POST" });
  if (r.ok) return { url: (await r.json()).url, error: null };
  const e = await r.json().catch(() => ({}));
  return { url: null, error: e.error || "no se pudo conectar la terminal" };
}

/** Abre Terminal.app adjunta a la sesión, conservando ttyd como superficie embebida principal. */
export async function attachSessionTerminal(name: string): Promise<void> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(name)}/attach`, { method: "POST" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo abrir la terminal");
  }
}


export async function getRepos(): Promise<string[]> {
  const r = await fetch("/api/repos");
  if (!r.ok) return ["monorepo"];
  const data = (await r.json()) as { repos?: string[] };
  return data.repos?.length ? data.repos : ["monorepo"];
}

export async function getReposConfig(): Promise<ReposConfig | null> {
  const r = await fetch("/api/repos-config");
  return r.ok ? r.json() : null;
}

export async function saveReposConfig(cfg: ReposConfig): Promise<ReposConfig> {
  const r = await fetch("/api/repos-config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo guardar la config de repos");
  }
  return r.json();
}

export async function getTrustedRoots(): Promise<TrustedRoots> {
  const r = await fetch("/api/trusted-roots");
  if (!r.ok) throw new Error("no se pudieron leer las raíces de confianza");
  return r.json();
}

export async function saveTrustedRoots(roots: string[]): Promise<TrustedRoots> {
  const r = await fetch("/api/trusted-roots", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roots }) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudieron guardar las raíces de confianza");
  }
  return r.json();
}

export async function getRepoConfig(repo: string): Promise<RepoOverrideConfig | null> {
  const r = await fetch(`/api/repo-config/${encodeURIComponent(repo)}`);
  return r.ok ? r.json() : null;
}

export async function saveRepoConfig2(
  repo: string,
  cfg: {
    workflow: WorkflowConfig | null;
    vars: Record<string, string>;
    startCommand: string;
    plannerModel: string;
    workerModel: string;
    inheritWorkflow: boolean;
  }
): Promise<RepoOverrideConfig> {
  const r = await fetch(`/api/repo-config/${encodeURIComponent(repo)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new WorkflowSaveError(e.error || "no se pudo guardar la config del repo", e.path, e.code);
  }
  return r.json();
}

export async function generateReport(kind: "daily" | "weekly", date?: string): Promise<{ name: string; markdown: string }> {
  const r = await fetch("/api/reports/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(date ? { kind, date } : { kind }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo generar el reporte");
  }
  return r.json();
}

export async function listReports(): Promise<ReportMeta[]> {
  const r = await fetch("/api/reports");
  return r.ok ? r.json() : [];
}

export async function getReport(name: string): Promise<{ name: string; markdown: string } | null> {
  const r = await fetch(`/api/reports/${encodeURIComponent(name)}`);
  return r.ok ? r.json() : null;
}

/**
 * Inventario tmux completo. Sigue el contrato de los demás GET de este archivo: NO lanza.
 * `null` = el server no contestó o contestó mal; `[]` = contestó y no hay sesiones. La barra de
 * estado necesita distinguirlos para poder decir "server sin respuesta" en vez de "0 sesiones",
 * que es una afirmación distinta y falsa.
 */
export async function getTmuxInventory(): Promise<TmuxInventoryResult | null> {
  try {
    const r = await fetch("/api/sessions");
    if (!r.ok) return null;
    const body = await r.json() as Partial<TmuxInventoryResult>;
    return Array.isArray(body.sessions) ? { sessions: body.sessions, diagnostic: body.diagnostic ?? null } : null;
  } catch {
    return null; // fetch rechaza cuando el server está caído
  }
}

/** Legacy convenience for older surfaces; new Electron UI uses getTmuxInventory for diagnostics. */
export async function getSessions(): Promise<TmuxSessionInfo[] | null> {
  return (await getTmuxInventory())?.sessions ?? null;
}

/** Mata sólo la sesión tmux indicada. La confirmación se vuelve a exigir en el servidor. */
export async function closeTmuxSession(session: string): Promise<ApiErrorBody | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    return r.ok ? null : ((await r.json().catch(() => null)) as ApiErrorBody | null) ?? { error: "fallo desconocido", code: "UNKNOWN" };
  } catch {
    return { error: "el server no respondió", code: "NETWORK_ERROR" };
  }
}

export async function saveSessionPresentation(session: string, presentation: SessionPresentation): Promise<SessionPresentation> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/presentation`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(presentation),
  });
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || "no se pudo guardar la etiqueta de sesión");
  }
  return r.json();
}

export interface ManagedSessionLaunch {
  repo: string;
  workflowId?: string;
  name: string;
  mode: "workflow" | "terminal";
  agent?: "claude" | "codex";
  request?: string;
}
export async function launchManagedTmuxSession(input: ManagedSessionLaunch): Promise<{ name: string; mode: "workflow" | "terminal"; workflowId?: string; agent?: "claude" | "codex"; session: TmuxSessionInfo | null }> {
  const r = await fetch("/api/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!r.ok) {
    const error = await r.json().catch(() => ({}));
    throw new Error(error.error || "no se pudo crear la sesión");
  }
  return r.json();
}

export async function getPreflight(): Promise<PreflightCheck[] | null> {
  try {
    const r = await fetch("/api/preflight");
    // Mismo `?? null` que `getSessions` y por el mismo motivo: un 200 sin `checks` en el cuerpo
    // da `undefined`, no `null` ni array, y `PreflightScreen` compara contra `null`.
    return r.ok ? ((await r.json()).checks ?? null) : null;
  } catch {
    return null;
  }
}

// ---- F2/T5 — adopción y terminal por pane. La cabecera de capability la inyecta el PROXY
// (Electron/Vite, T0.2b) — este cliente nunca la declara. ----

export interface PaneCaptureResponse {
  status: "ok" | "gone";
  content: string | null;
  cursor?: { x: number; y: number };
  size?: { cols: number; rows: number };
}

export async function capturePane(session: string, paneId: string): Promise<PaneCaptureResponse | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/panes/${encodeURIComponent(paneId)}/capture`);
    if (!r.ok) return null;
    return (await r.json()) as PaneCaptureResponse;
  } catch {
    return null;
  }
}

export interface ApiErrorBody {
  error: string;
  code: string;
}

/** Activa ventana+pane en tmux para que la terminal ttyd los muestre. Devuelve el error tipado o null. */
export async function focusSessionPane(session: string, paneId: string): Promise<ApiErrorBody | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/panes/${encodeURIComponent(paneId)}/focus`, { method: "POST" });
    return r.ok ? null : ((await r.json().catch(() => null)) as ApiErrorBody | null) ?? { error: "fallo desconocido", code: "UNKNOWN" };
  } catch {
    return { error: "sin conexión con el backend", code: "NETWORK" };
  }
}

export async function sendPaneKeys(session: string, paneId: string, text: string, submit = false): Promise<ApiErrorBody | null> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/panes/${encodeURIComponent(paneId)}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, submit }),
    });
    return r.ok ? null : ((await r.json().catch(() => null)) as ApiErrorBody | null) ?? { error: "fallo desconocido", code: "UNKNOWN" };
  } catch {
    return { error: "el server no respondió", code: "NETWORK_ERROR" };
  }
}

export interface AdoptRequest {
  confirm: true;
  repo: string;
  paneId?: string;
  expectedSessionCreatedAt: number;
}

export interface AdoptResponse {
  session: string;
  cycleDir: string;
  paneId: string;
  repo: string;
  adoptedAt: number;
}

export async function adoptSessionRequest(session: string, body: AdoptRequest): Promise<{ ok: true; result: AdoptResponse } | { ok: false; error: ApiErrorBody }> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: (parsed as ApiErrorBody) ?? { error: "fallo desconocido", code: "UNKNOWN" } };
    return { ok: true, result: parsed as AdoptResponse };
  } catch {
    return { ok: false, error: { error: "el server no respondió", code: "NETWORK_ERROR" } };
  }
}

export async function releaseAdoptionRequest(session: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(session)}/adopt`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// ---- Test harness (/api/tests). El cliente manda identificadores; el server valida la forma. ----

async function harnessJson<T>(r: Response, fallback: string): Promise<T> {
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || fallback);
  }
  return r.json();
}

export async function getTestsConfig(): Promise<TestRepoConfig[] | null> {
  try {
    const r = await fetch("/api/tests/config");
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

export async function getTestsMatrix(): Promise<TestMatrixRow[] | null> {
  try {
    const r = await fetch("/api/tests/matrix");
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

export async function getTestsRuns(filter: { repo?: string; suite?: TestSuite; limit?: number } = {}): Promise<TestRun[]> {
  const q = new URLSearchParams();
  if (filter.repo) q.set("repo", filter.repo);
  if (filter.suite) q.set("suite", filter.suite);
  if (filter.limit) q.set("limit", String(filter.limit));
  try {
    const r = await fetch(`/api/tests/runs${q.size ? `?${q}` : ""}`);
    return r.ok ? r.json() : [];
  } catch {
    return [];
  }
}

export async function getTestsRun(runId: string): Promise<TestRun | null> {
  try {
    const r = await fetch(`/api/tests/runs/${encodeURIComponent(runId)}`);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

/** `variables` con valor `null` significa "conserva el valor ya guardado" (el server nunca lo devolvió). */
export async function saveTestsConfig(repo: string, input: unknown): Promise<TestRepoConfig> {
  const r = await fetch(`/api/tests/config/${encodeURIComponent(repo)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return harnessJson(r, "no se pudo guardar la configuración de pruebas");
}

export async function startTests(selection: TestSelection): Promise<TestStartResult> {
  const r = await fetch("/api/tests/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
  });
  return harnessJson(r, "no se pudo iniciar la corrida");
}

export async function cancelTestRun(runId: string): Promise<{ cancelled: boolean }> {
  const r = await fetch(`/api/tests/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  return harnessJson(r, "no se pudo cancelar");
}

export async function retryTestRun(runId: string): Promise<TestStartResult> {
  const r = await fetch(`/api/tests/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" });
  return harnessJson(r, "no se pudo reintentar");
}

// ---- Workflow insights. El análisis corre en background: `analyzeWorkflows` sólo devuelve el
// id y la UI sondea `getWorkflowAnalysis`. Los GET devuelven null/[] ante un fallo de red (como
// `getTestsMatrix`); los POST lanzan con el mensaje del server. `status=""` sería un 400, así
// que el filtro vacío se omite en vez de mandarse.
export async function analyzeWorkflows(range: { from?: string; to?: string } = {}): Promise<{ analysisId: string }> {
  const r = await fetch("/api/workflows/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(range),
  });
  return harnessJson(r, "no se pudo iniciar el análisis");
}

export async function getWorkflowAnalysis(id: string): Promise<WorkflowAnalysis | null> {
  try {
    const r = await fetch(`/api/workflows/analyses/${encodeURIComponent(id)}`);
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

export async function getWorkflowProposals(status?: ProposalStatus): Promise<WorkflowProposal[]> {
  try {
    const r = await fetch(`/api/workflows/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`);
    return r.ok ? r.json() : [];
  } catch {
    return [];
  }
}

/** 201 con el item de catálogo recién creado; 409 si la propuesta ya no está en `proposed`. */
export async function acceptWorkflowProposal(id: string, name?: string): Promise<WorkflowCatalogItem> {
  const r = await fetch(`/api/workflows/proposals/${encodeURIComponent(id)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  return harnessJson(r, "no se pudo aceptar la propuesta");
}

export async function dismissWorkflowProposal(id: string): Promise<WorkflowProposal> {
  const r = await fetch(`/api/workflows/proposals/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
  return harnessJson(r, "no se pudo descartar la propuesta");
}
