import { clickupListIds, clickupTeamId, clickupToken } from "./settings.js";
import type { Priority, Task, TaskStatus } from "./types.js";

/** ClickUp priority → board scale. ClickUp uses urgent/high/normal/low. */
function mapPriority(raw?: string | null): Priority {
  const p = (raw ?? "").toLowerCase();
  if (p === "urgent") return "urgent";
  if (p === "high") return "high";
  if (p === "normal") return "normal";
  if (p === "low") return "low";
  return "none";
}

const API = "https://api.clickup.com/api/v2";

/** Map ClickUp's free-form status names onto the board's 5 states. */
export function mapStatus(raw: string): TaskStatus {
  const s = raw.toLowerCase();
  if (/(resolved|released|closed|complete|done|merged)/.test(s)) return "done";
  if (/(in progress|en progreso|in development)/.test(s)) return "running";
  if (/(with issues|investigating|monitoring|blocked|con problemas)/.test(s)) return "triage";
  if (/(review|testing|ready for|qa|merge)/.test(s)) return "review";
  return "queued"; // backlog, to do, selected for dev, open, …
}

const REPO_RULES: Array<[RegExp, string]> = [
  [/ant-ms-cfdis|\bcfdi(s)?\b|facturaci[oó]n|\bdiot\b/i, "ant-ms-cfdis"],
  [/ant-ms-permissions|permiss?ions|\brbac\b/i, "ant-ms-permissions"],
  [/ant-ms-i18n|\bi18n\b|traducc/i, "ant-ms-i18n"],
  [/data-extraction|contpaqi/i, "ant-liebre-data-extraction-contpaqi"],
  [/ant-liebre-app|\bfront\b|\bapp\b/i, "ant-liebre-app"],
];

/** Best-effort repo inference from the task name + tags. Falls back to the API. */
export function inferRepo(name: string, tags: string[]): string {
  const hay = `${name} ${tags.join(" ")}`;
  for (const [re, repo] of REPO_RULES) if (re.test(hay)) return repo;
  return "ant-liebre-api";
}

interface CuTask {
  id: string;
  custom_id: string | null;
  name: string;
  status?: { status?: string };
  priority?: { priority?: string } | null;
  date_created?: string;
  url?: string;
  tags?: Array<{ name: string }>;
  list?: { id: string };
}

function mapTask(t: CuTask): Task {
  const tags = (t.tags ?? []).map((x) => x.name);
  const raw = t.status?.status ?? "";
  return {
    id: t.id,
    key: t.custom_id ?? t.id,
    title: t.name,
    repo: inferRepo(t.name, tags),
    source: "clickup",
    status: mapStatus(raw),
    statusLabel: raw || undefined,
    priority: mapPriority(t.priority?.priority),
    dateCreated: t.date_created ? Number(t.date_created) : undefined,
    listId: t.list?.id,
    url: t.url ?? `https://app.clickup.com/t/${t.id}`,
  };
}

async function cu(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: clickupToken() } });
  if (!res.ok) throw new Error(`ClickUp ${res.status} on ${path}`);
  return res.json();
}

/**
 * Fetch a single task's full description (markdown preferred) — used to enrich the
 * worker prompt at launch. Best-effort: returns null on any failure.
 */
export async function fetchClickUpDescription(taskId: string): Promise<string | null> {
  if (!clickupToken()) return null;
  try {
    const t = await cu(`/task/${taskId}?include_markdown_description=true`);
    const text = t?.markdown_description || t?.text_content || t?.description || "";
    const trimmed = String(text).trim();
    return trimmed.length ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the authenticated user's open tasks across the workspace.
 * Self-contained: discovers the user id and team id from the token.
 */
export async function fetchClickUpTasks(): Promise<Task[]> {
  if (!clickupToken()) throw new Error("no ClickUp token");

  const me = await cu("/user");
  const myId = String(me?.user?.id ?? "");

  let teamId = clickupTeamId();
  if (!teamId) {
    const teams = await cu("/team");
    teamId = String(teams?.teams?.[0]?.id ?? "");
  }
  if (!teamId) throw new Error("no ClickUp team");

  const params = new URLSearchParams({ include_closed: "false", subtasks: "false" });
  if (myId) params.append("assignees[]", myId);
  for (const id of clickupListIds()) params.append("list_ids[]", id);

  const all: Task[] = [];
  for (let page = 0; page < 10; page++) {
    const data = await cu(`/team/${teamId}/task?${params.toString()}&page=${page}`);
    const batch: CuTask[] = data?.tasks ?? [];
    all.push(...batch.map(mapTask));
    if (batch.length < 100 || data?.last_page) break;
  }
  return all;
}

/** Chequeo autenticado ligero con el token guardado. Nunca lanza. */
export async function testClickUp(): Promise<{ ok: boolean; detail?: string; error?: string }> {
  if (!clickupToken()) return { ok: false, error: "sin token de ClickUp" };
  try {
    const me = await cu("/user");
    const name = me?.user?.username || me?.user?.email || "usuario";
    return { ok: true, detail: `conectado como ${name}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message }; // mensaje = "ClickUp <status>", sin token
  }
}
