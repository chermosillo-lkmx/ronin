import { jiraBaseUrl, jiraEmail, jiraJql, jiraToken } from "./settings.js";
import type { Priority, Task, TaskStatus } from "./types.js";

/** Jira priority (Highest/High/Medium/Low/Lowest) → board scale. */
function mapJiraPriority(name?: string): Priority {
  const p = (name ?? "").toLowerCase();
  if (p === "highest") return "urgent";
  if (p === "high") return "high";
  if (p === "medium") return "normal";
  if (p === "low") return "low";
  if (p === "lowest") return "none";
  return "none";
}

/** Map Jira status (or statusCategory) onto the board's 5 states. */
export function mapJiraStatus(name: string, category: string, isBug: boolean): TaskStatus {
  const s = name.toLowerCase();
  const c = category.toLowerCase();
  if (c === "done" || /done|closed|resolved/.test(s)) return "done";
  if (/review|qa|testing/.test(s)) return "review";
  if (c === "indeterminate" || /in progress|in development/.test(s)) return "running";
  // "To Do" bugs land in triage; other to-do work is queued.
  return isBug ? "triage" : "queued";
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string };
    project?: { key?: string };
    created?: string;
    description?: unknown;          // ADF (objeto) en v3, o string/null
  };
}

/** Aplana ADF (o string) de Jira a texto plano; ignora formato. Nodos sin texto → "". */
function adfToText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;                 // v2 / ya-string
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  const kids = Array.isArray(n.content) ? n.content.map(adfToText).join("") : "";
  // nodos de bloque → su propia línea
  return /^(paragraph|heading|blockquote|listItem|codeBlock)$/.test(n.type ?? "")
    ? kids + "\n"
    : kids;
}

function mapIssue(issue: JiraIssue): Task {
  const f = issue.fields;
  const isBug = (f.issuetype?.name ?? "").toLowerCase() === "bug";
  const raw = f.status?.name ?? "";
  const body = adfToText(f.description).trim();
  return {
    id: issue.key,
    key: issue.key,
    title: f.summary,
    repo: (f.project?.key ?? "jira").toLowerCase(),
    source: "jira",
    status: mapJiraStatus(raw, f.status?.statusCategory?.key ?? "", isBug),
    statusLabel: raw || undefined,
    priority: mapJiraPriority(f.priority?.name),
    dateCreated: f.created ? Date.parse(f.created) || undefined : undefined,
    body: body || undefined,
    url: `${jiraBaseUrl()}/browse/${issue.key}`,
  };
}

export function jiraConfigured(): boolean {
  return Boolean(jiraBaseUrl() && jiraEmail() && jiraToken());
}

/** Fetch the authenticated user's open issues via JQL. */
export async function fetchJiraTasks(): Promise<Task[]> {
  if (!jiraConfigured()) throw new Error("no Jira credentials");
  const auth = Buffer.from(`${jiraEmail()}:${jiraToken()}`).toString("base64");
  const url =
    `${jiraBaseUrl()}/rest/api/3/search?` +
    new URLSearchParams({
      jql: jiraJql(),
      maxResults: "50",
      fields: "summary,status,issuetype,project,priority,created,description",
    }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira ${res.status}`);
  const data = await res.json();
  return (data.issues ?? []).map(mapIssue);
}

/** Chequeo autenticado ligero con las creds guardadas. Nunca lanza. */
export async function testJira(): Promise<{ ok: boolean; detail?: string; error?: string }> {
  if (!jiraConfigured()) return { ok: false, error: "faltan credenciales de Jira" };
  try {
    const auth = Buffer.from(`${jiraEmail()}:${jiraToken()}`).toString("base64");
    const res = await fetch(`${jiraBaseUrl()}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `Jira ${res.status}` };
    const me = await res.json();
    return { ok: true, detail: `conectado como ${me?.displayName || me?.emailAddress || "usuario"}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
