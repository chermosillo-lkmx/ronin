import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { dataPath } from "./data-dir.js";
import {
  CLICKUP_LIST_IDS, CLICKUP_TEAM_ID, CLICKUP_TOKEN,
  JIRA_BASE_URL, JIRA_EMAIL, JIRA_JQL, JIRA_TOKEN,
  GITLAB_BASE_URL, GITLAB_PROJECT, GITLAB_TOKEN,
} from "./config.js";

const SETTINGS_FILE = dataPath("settings.json");
const COMMENT =
  "Credenciales de conectores (ClickUp/Jira/GitLab). Gitignored. Editable desde ⚙ Configuración → Conectores o a mano. Token vacío = conservar el existente.";

interface StoredSettings {
  allowedRoots?: string[];
  clickup?: { token?: string; teamId?: string; listIds?: string[] };
  jira?: { token?: string; baseUrl?: string; email?: string; jql?: string };
  gitlab?: { token?: string; baseUrl?: string; project?: string };
}

function normalizeListIds(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}
// Validate/coerce on-load (hand-edited JSON) — mirrors repos.ts/workflow.ts distrust of disk.
function str(v: unknown): string | undefined { return typeof v === "string" ? v : undefined; }
function sanitize(raw: any): StoredSettings {
  const out: StoredSettings = {};
  if (Array.isArray(raw?.allowedRoots)) out.allowedRoots = raw.allowedRoots.filter((root: unknown): root is string => typeof root === "string");
  if (raw?.clickup && typeof raw.clickup === "object") {
    out.clickup = {};
    const token = str(raw.clickup.token); if (token !== undefined) out.clickup.token = token;
    const teamId = str(raw.clickup.teamId); if (teamId !== undefined) out.clickup.teamId = teamId;
    if (raw.clickup.listIds !== undefined) out.clickup.listIds = normalizeListIds(raw.clickup.listIds);
  }
  if (raw?.jira && typeof raw.jira === "object") {
    out.jira = {};
    for (const k of ["token", "baseUrl", "email", "jql"] as const) {
      const v = str(raw.jira[k]); if (v !== undefined) (out.jira as any)[k] = v;
    }
  }
  if (raw?.gitlab && typeof raw.gitlab === "object") {
    out.gitlab = {};
    for (const k of ["token", "baseUrl", "project"] as const) {
      const v = str(raw.gitlab[k]); if (v !== undefined) (out.gitlab as any)[k] = v;
    }
  }
  return out;
}
function loadFrom(file: string): StoredSettings {
  try { return sanitize(JSON.parse(readFileSync(file, "utf8"))); }
  catch { return {}; } // ausente → todo env fallback (compat)
}
function load(): StoredSettings { return loadFrom(SETTINGS_FILE); }

function writeSettings(next: StoredSettings, file: string): void {
  writeFileSync(file, JSON.stringify({ _comment: COMMENT, ...next }, null, 2) + "\n");
}

let store: StoredSettings = load();

// ---- Getters (leídos por-llamada; settings gana según precedencia, si no env seed) ----
// token/jql: sólo si NO vacío (vacío sería inválido → env). Otros: si la clave existe (vaciar = clear explícito).
export function clickupToken(): string { const s = store.clickup?.token; return s && s.trim() ? s : CLICKUP_TOKEN; }
export function clickupTeamId(): string { return store.clickup?.teamId !== undefined ? store.clickup.teamId : CLICKUP_TEAM_ID; }
export function clickupListIds(): string[] { return store.clickup?.listIds !== undefined ? store.clickup.listIds : CLICKUP_LIST_IDS; }
export function jiraToken(): string { const s = store.jira?.token; return s && s.trim() ? s : JIRA_TOKEN; }
export function jiraBaseUrl(): string { const b = store.jira?.baseUrl; return (b !== undefined ? b : JIRA_BASE_URL).replace(/\/$/, ""); }
export function jiraEmail(): string { return store.jira?.email !== undefined ? store.jira.email : JIRA_EMAIL; }
export function jiraJql(): string { const j = store.jira?.jql; return j && j.trim() ? j : JIRA_JQL; }
export function gitlabToken(): string { const s = store.gitlab?.token; return s && s.trim() ? s : GITLAB_TOKEN; }
export function gitlabBaseUrl(): string { const b = store.gitlab?.baseUrl; return ((b && b.trim()) ? b : GITLAB_BASE_URL).replace(/\/$/, ""); }
export function gitlabProject(): string { return store.gitlab?.project !== undefined ? store.gitlab.project : GITLAB_PROJECT; }

export function readAllowedRoots(file: string = SETTINGS_FILE): string[] {
  return loadFrom(file).allowedRoots ?? [];
}

export function saveAllowedRoots(input: unknown, file: string = SETTINGS_FILE): string[] {
  if (!Array.isArray(input)) throw new Error("se esperaba una lista de raíces (rutas absolutas existentes)");
  const roots: string[] = [];
  for (const value of input) {
    const root = typeof value === "string" ? value.trim() : String(value);
    if (!isAbsolute(root) || !existsSync(root)) throw new Error(`raíz inválida: ${root} (debe existir y ser absoluta)`);
    const real = realpathSync(root);
    if (!roots.includes(real)) roots.push(real);
  }
  const next = { ...loadFrom(file), allowedRoots: roots };
  writeSettings(next, file);
  if (file === SETTINGS_FILE) store = next;
  return roots;
}

// ---- Read (masked) / Save ----
export interface ConnectorSettings {
  clickup: { hasToken: boolean; teamId: string; listIds: string[] };
  jira: { hasToken: boolean; baseUrl: string; email: string; jql: string };
  gitlab: { hasToken: boolean; baseUrl: string; project: string };
}
export function readConnectorSettings(): ConnectorSettings {
  return {
    clickup: { hasToken: Boolean(clickupToken()), teamId: clickupTeamId(), listIds: clickupListIds() },
    jira: { hasToken: Boolean(jiraToken()), baseUrl: jiraBaseUrl(), email: jiraEmail(), jql: jiraJql() },
    gitlab: { hasToken: Boolean(gitlabToken()), baseUrl: gitlabBaseUrl(), project: gitlabProject() },
  };
}
export function saveConnectorSettings(input: unknown): ConnectorSettings {
  const cur = load();
  const next: StoredSettings = { clickup: { ...cur.clickup }, jira: { ...cur.jira }, gitlab: { ...cur.gitlab } };
  const inp = (input ?? {}) as { clickup?: Record<string, unknown>; jira?: Record<string, unknown>; gitlab?: Record<string, unknown> };

  const ic = inp.clickup;
  if (ic && typeof ic === "object") {
    if (typeof ic.teamId === "string") next.clickup!.teamId = ic.teamId.trim();
    if (ic.listIds !== undefined) next.clickup!.listIds = normalizeListIds(ic.listIds);
    if (typeof ic.token === "string" && ic.token.trim()) next.clickup!.token = ic.token.trim(); // vacío = conservar
  }
  const ij = inp.jira;
  if (ij && typeof ij === "object") {
    if (typeof ij.baseUrl === "string") {
      // SECURITY: baseUrl is the OUTBOUND host for the Jira Basic-auth header (jira.ts).
      // Reject anything but https + a Jira-Cloud host, else a PUT with empty token (=keep)
      // could redirect the real token to an attacker host. Empty = clear (allowed).
      const b = ij.baseUrl.trim().replace(/\/$/, "");
      if (b) {
        let host = "";
        try { host = new URL(b).hostname; } catch { throw new Error("baseUrl de Jira inválida"); }
        if (!b.startsWith("https://") || !host.endsWith(".atlassian.net"))
          throw new Error("baseUrl de Jira debe ser https y de un sitio *.atlassian.net");
      }
      next.jira!.baseUrl = b;
    }
    if (typeof ij.email === "string") next.jira!.email = ij.email.trim();
    if (typeof ij.jql === "string") next.jira!.jql = ij.jql.trim();
    if (typeof ij.token === "string" && ij.token.trim()) next.jira!.token = ij.token.trim(); // vacío = conservar
  }
  const ig = inp.gitlab;
  if (ig && typeof ig === "object") {
    if (typeof ig.baseUrl === "string") {
      // SECURITY: baseUrl es el host de SALIDA del header PRIVATE-TOKEN (gitlab.ts).
      // Sólo https + gitlab.com, o el host self-hosted ya fijado en env GITLAB_BASE_URL.
      // Si no, un PUT con token vacío (=conservar) podría redirigir el token real a un
      // host atacante. Vacío = clear (permitido → cae al default).
      const b = ig.baseUrl.trim().replace(/\/$/, "");
      if (b) {
        let host = "";
        try { host = new URL(b).hostname; } catch { throw new Error("baseUrl de GitLab inválida"); }
        let envHost = "";
        if (GITLAB_BASE_URL) { try { envHost = new URL(GITLAB_BASE_URL).hostname; } catch {} }
        const allowed = host === "gitlab.com" || (envHost !== "" && host === envHost);
        if (!b.startsWith("https://") || !allowed)
          throw new Error("baseUrl de GitLab debe ser https y de gitlab.com o tu instancia self-hosted (GITLAB_BASE_URL)");
      }
      next.gitlab!.baseUrl = b;
    }
    if (typeof ig.project === "string") next.gitlab!.project = ig.project.trim();
    if (typeof ig.token === "string" && ig.token.trim()) next.gitlab!.token = ig.token.trim(); // vacío = conservar
  }

  writeSettings(next, SETTINGS_FILE);
  store = next;
  return readConnectorSettings();
}
