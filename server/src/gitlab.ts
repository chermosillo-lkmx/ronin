import { gitlabBaseUrl, gitlabProject, gitlabToken } from "./settings.js";
import type { Priority, Task, TaskStatus } from "./types.js";

/** GitLab no tiene prioridad nativa; deriva de labels priority::* o none. */
function mapGitLabPriority(labels: string[]): Priority {
  const l = labels.map((x) => x.toLowerCase());
  if (l.some((x) => /priority::?(urgent|critical|p0)/.test(x))) return "urgent";
  if (l.some((x) => /priority::?(high|p1)/.test(x))) return "high";
  if (l.some((x) => /priority::?(medium|normal|p2)/.test(x))) return "normal";
  if (l.some((x) => /priority::?(low|p3)/.test(x))) return "low";
  return "none";
}

/** Mapea estado GitLab (issue/MR) a los 5 estados del tablero. */
export function mapGitLabStatus(kind: "issue" | "mr", state: string, labels: string[], isBug: boolean): TaskStatus {
  const l = labels.map((x) => x.toLowerCase());
  if (state === "closed" || state === "merged") return "done";
  if (l.some((x) => /wip|draft|doing|in progress|in development/.test(x))) return "running";
  if (kind === "mr") return "review";              // MR abierto (asignado o por revisar) = review
  if (l.some((x) => /review|qa|testing/.test(x))) return "review";
  return isBug ? "triage" : "queued";              // issue abierto
}

interface GitLabItem {
  id: number;                       // id GLOBAL (único en la instancia) → base del Task.id
  iid: number;                      // número por-proyecto (#5/!5) → display, NO único
  title: string;
  description?: string;             // v4 issues/MRs list ya trae description
  state: string;                    // opened|closed|merged|locked
  labels?: string[];                // v4: string[]
  web_url?: string;
  created_at?: string;
  references?: { full?: string };   // "group/proj#5" / "group/proj!5"
}

/** repo desde references.full ("group/proj#5" → "group/proj"); fallback web_url. */
function repoFromItem(item: GitLabItem): string {
  const full = item.references?.full;
  const m = full?.match(/^(.*?)[#!]\d+$/);
  if (m) return m[1].toLowerCase();
  try { return new URL(item.web_url ?? "").pathname.split("/-/")[0].replace(/^\//, "").toLowerCase() || "gitlab"; }
  catch { return "gitlab"; }
}

function mapItem(item: GitLabItem, kind: "issue" | "mr"): Task {
  const labels = item.labels ?? [];
  const isBug = labels.some((x) => x.toLowerCase() === "bug");
  return {
    id: `gl-${kind}-${item.id}`,                       // id global + tipo → único (anti-colisión)
    key: `${kind === "mr" ? "!" : "#"}${item.iid}`,    // display corto
    title: item.title,
    repo: repoFromItem(item),
    source: "gitlab",
    status: mapGitLabStatus(kind, item.state, labels, isBug),
    statusLabel: item.state || undefined,
    priority: mapGitLabPriority(labels),
    dateCreated: item.created_at ? Date.parse(item.created_at) || undefined : undefined,
    body: item.description?.trim() || undefined,
    url: item.web_url,
  };
}

export function gitlabConfigured(): boolean {
  return Boolean(gitlabToken());
}

/** GET {base}/api/v4/{path}?{params} con header PRIVATE-TOKEN. Path scoped si hay project. */
async function glGet(path: "issues" | "merge_requests" | "user", params: Record<string, string> = {}): Promise<any> {
  const project = gitlabProject();
  const scoped = (path === "issues" || path === "merge_requests") && project
    ? `projects/${encodeURIComponent(project)}/${path}`
    : path;
  const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : "";
  const res = await fetch(`${gitlabBaseUrl()}/api/v4/${scoped}${qs}`, { headers: { "PRIVATE-TOKEN": gitlabToken() } });
  if (!res.ok) throw new Error(`GitLab ${res.status}`);   // sólo status, nunca el token
  return res.json();
}

function asArray(data: any): GitLabItem[] { return Array.isArray(data) ? data : []; }

/**
 * Issues asignados + MRs abiertos donde el usuario es ASIGNADO **o** REVISOR (por revisar).
 * `scope=assigned_to_me` NO incluye MRs donde eres reviewer → segundo fetch por reviewer_username
 * y dedupe por `id` global (puedes ser asignado y revisor del mismo MR). Lanza en error (loadGitLab lo traga).
 */
export async function fetchGitLabTasks(): Promise<Task[]> {
  if (!gitlabConfigured()) throw new Error("no GitLab credentials");
  const me = await glGet("user");                         // username para MRs por revisar
  const username = String(me?.username ?? "");
  const [issues, mrsAssigned, mrsReview] = await Promise.all([
    glGet("issues", { scope: "assigned_to_me", state: "opened", per_page: "100" }),
    glGet("merge_requests", { scope: "assigned_to_me", state: "opened", per_page: "100" }),
    username
      ? glGet("merge_requests", { scope: "all", reviewer_username: username, state: "opened", per_page: "100" })
      : Promise.resolve([]),
  ]);
  // Dedupe MRs por id global (asignado ∪ revisor).
  const mrs = new Map<number, GitLabItem>();
  for (const m of [...asArray(mrsAssigned), ...asArray(mrsReview)]) mrs.set(m.id, m);
  return [
    ...asArray(issues).map((i) => mapItem(i, "issue")),
    ...[...mrs.values()].map((m) => mapItem(m, "mr")),
  ];
}

/** Chequeo autenticado ligero con las creds guardadas. Nunca lanza. Sin token en el output. */
export async function testGitLab(): Promise<{ ok: boolean; detail?: string; error?: string }> {
  if (!gitlabConfigured()) return { ok: false, error: "sin token de GitLab" };
  try {
    const res = await fetch(`${gitlabBaseUrl()}/api/v4/user`, { headers: { "PRIVATE-TOKEN": gitlabToken() } });
    if (!res.ok) return { ok: false, error: `GitLab ${res.status}` };
    const me = await res.json();
    return { ok: true, detail: `conectado como ${me?.username || me?.name || "usuario"}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
