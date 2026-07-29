import type { ConnectorSettings, ConnectorSettingsInput, CustomAction, HistoryEvent, PaneRole, PaneView, PreflightCheck, PromptTemplate, RepoOverrideConfig, ReportMeta, ReposConfig, Snapshot, TmuxSessionInfo, WorkflowConfig } from "./types";

/** Subscribe to live snapshots via SSE. Returns an unsubscribe fn. */
export function subscribeStream(
  onSnapshot: (s: Snapshot) => void,
  onStatus: (connected: boolean) => void
): () => void {
  const es = new EventSource("/api/stream");
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.onmessage = (ev) => {
    try {
      onSnapshot(JSON.parse(ev.data) as Snapshot);
    } catch {
      /* ignore malformed frame */
    }
  };
  return () => es.close();
}

/** Overrides por lanzamiento: modelos + (modo Driver) mode/reviewTool. Se re-validan en el server. */
export interface LaunchOverrides {
  plannerModel?: string;
  workerModel?: string;
  mode?: "driver";
  reviewTool?: "codex" | "agent";
}

export async function launchTask(
  taskId: string,
  stageKeys?: string[],
  models?: LaunchOverrides
): Promise<void> {
  await fetch(`/api/tasks/${taskId}/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(stageKeys ? { stageKeys } : {}), ...(models ?? {}) }),
  });
}

export async function launchResearch(taskId: string): Promise<void> {
  await fetch(`/api/tasks/${taskId}/research`, { method: "POST" });
}

export async function getActions(): Promise<CustomAction[]> {
  const r = await fetch("/api/actions");
  return r.ok ? r.json() : [];
}

export async function saveActions(list: CustomAction[]): Promise<CustomAction[]> {
  const r = await fetch("/api/actions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(list),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo guardar las acciones");
  }
  return r.json();
}

export async function launchAction(taskId: string, key: string): Promise<void> {
  const r = await fetch(`/api/tasks/${taskId}/action/${encodeURIComponent(key)}`, { method: "POST" });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo lanzar la acción");
  }
}

export async function getTaskDescription(id: string): Promise<string | null> {
  const r = await fetch(`/api/tasks/${encodeURIComponent(id)}/description`);
  return r.ok ? (await r.json()).description : null;
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
    throw new Error(e.error || "no se pudo guardar el workflow");
  }
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

export async function stopWorker(workerId: string): Promise<void> {
  await fetch(`/api/workers/${workerId}/stop`, { method: "POST" });
}

/** Abre Terminal.app. Con `role` (modo driver) zoomea antes ese pane; si no se pudo, no abre nada. */
export async function attachWorker(workerId: string, role?: PaneRole): Promise<void> {
  const r = await fetch(`/api/workers/${workerId}/attach`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(role ? { role } : {}),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo abrir la terminal");
  }
}

export interface PanesResult {
  panes: PaneView[];
  zoomed: PaneRole | null;
}

/** Los 4 panes de una sesión driver con su estado. null si no hay sesión o el layout está degradado. */
export async function getWorkerPanes(id: string): Promise<PanesResult | null> {
  const r = await fetch(`/api/workers/${id}/panes`);
  return r.ok ? r.json() : null;
}

/**
 * Zoom de tmux sobre un pane (`null` → volver a los 4 panes). OJO: el zoom es estado de la VENTANA
 * tmux, no del cliente — lo ven todos los attachados (otras pestañas y Terminal.app).
 */
export async function focusPane(id: string, role: PaneRole | null): Promise<void> {
  const r = await fetch(`/api/workers/${id}/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo enfocar el pane");
  }
}

export async function refreshTasks(): Promise<void> {
  await fetch("/api/refresh", { method: "POST" });
}

/** Texto del pane. `role` (modo driver) elige cuál; sin él, el pane del driver. */
export async function getPane(
  id: string,
  role?: PaneRole
): Promise<{ hasSession: boolean; pane: string } | null> {
  const r = await fetch(`/api/workers/${id}/pane${role ? `?role=${encodeURIComponent(role)}` : ""}`);
  return r.ok ? r.json() : null;
}

export interface Evidence {
  summary: string | null;
  research: string | null;
  curl: string | null;
  ui: string | null;
  verdict: string | null;
  images: string[];
}

export async function getEvidence(id: string): Promise<Evidence | null> {
  const r = await fetch(`/api/workers/${id}/evidence`);
  return r.ok ? r.json() : null;
}

export function evidenceFileUrl(id: string, name: string): string {
  return `/api/workers/${id}/evidence/file/${encodeURIComponent(name)}`;
}

export async function getHistory(from: number, to: number): Promise<HistoryEvent[]> {
  const r = await fetch(`/api/history?from=${from}&to=${to}`);
  return r.ok ? r.json() : [];
}

export async function pinTask(id: string, on: boolean): Promise<void> {
  await fetch(`/api/today/${on ? "pin" : "unpin"}/${id}`, { method: "POST" });
}

export async function getTerminalUrl(id: string): Promise<string | null> {
  const r = await fetch(`/api/workers/${id}/term`, { method: "POST" });
  return r.ok ? (await r.json()).url : null;
}

export async function workerInput(id: string, text: string): Promise<void> {
  await fetch(`/api/workers/${id}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function launchAdhoc(text: string): Promise<void> {
  await fetch("/api/adhoc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function launchPrReview(prUrl: string, taskUrl: string): Promise<void> {
  await fetch("/api/pr-review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prUrl, taskUrl }),
  });
}

export async function setOrder(order: string[]): Promise<void> {
  await fetch("/api/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
}

export async function getRepos(): Promise<string[]> {
  const r = await fetch("/api/repos");
  if (!r.ok) return ["monorepo"];
  const data = (await r.json()) as { repos?: string[] };
  return data.repos?.length ? data.repos : ["monorepo"];
}

export async function launchCustom(text: string, repo: string, stageKeys: string[]): Promise<void> {
  await fetch("/api/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, repo, stageKeys }),
  });
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
    throw new Error(e.error || "no se pudo guardar la config del repo");
  }
  return r.json();
}

export async function getConnectorSettings(): Promise<ConnectorSettings | null> {
  const r = await fetch("/api/connectors");
  return r.ok ? r.json() : null;
}

export async function saveConnectorSettings(input: ConnectorSettingsInput): Promise<ConnectorSettings> {
  const r = await fetch("/api/connectors", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || "no se pudo guardar los conectores");
  }
  return r.json();
}

export async function testConnector(name: "clickup" | "jira" | "gitlab"): Promise<{ ok: boolean; detail?: string; error?: string }> {
  const r = await fetch(`/api/connectors/${name}/test`, { method: "POST" });
  return r.ok ? r.json() : { ok: false, error: "no se pudo probar la conexión" };
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
export async function getSessions(): Promise<TmuxSessionInfo[] | null> {
  try {
    const r = await fetch("/api/sessions");
    // El `?? null` NO es decorativo: un 200 con un cuerpo sin `sessions` devolvería `undefined`,
    // que no es `null` ni es un array — los consumidores comparan contra `null` y acabarían
    // haciendo `undefined.find(...)`, o sea pantalla en blanco. Aquí sólo salen dos cosas.
    return r.ok ? ((await r.json()).sessions ?? null) : null;
  } catch {
    return null; // fetch rechaza cuando el server está caído
  }
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
