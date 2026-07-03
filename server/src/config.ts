import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Load server/.env (gitignored) before reading any config. Safe no-op if absent.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {
  /* no .env file — rely on the ambient environment */
}

/**
 * Runtime config, all overridable by env. Defaults are the SAFE choices:
 * simulated mode, no auto-submit. Live mode (real tmux + claude) is opt-in.
 */
export const MODE: "simulated" | "live" =
  process.env.COWORK_MODE === "live" ? "live" : "simulated";

/** When true (default), the requirement is submitted so the worker starts working. Set COWORK_AUTOSUBMIT=0 to stage it. */
export const AUTOSUBMIT = process.env.COWORK_AUTOSUBMIT !== "0";

/** When on (default), the seeded prompt invokes the /tmux-worker-loop skill. */
export const USE_WORKER_LOOP = process.env.COWORK_USE_WORKER_LOOP !== "0";

/**
 * Command used to launch the worker agent inside the tmux pane.
 * Defaults to auto mode (bypass permissions) so the worker starts working without pausing.
 * Dial back via COWORK_CLAUDE_CMD, e.g. "claude --permission-mode acceptEdits" or "...default".
 */
export const CLAUDE_CMD = process.env.COWORK_CLAUDE_CMD ?? "claude --permission-mode bypassPermissions";

/** Root under which task.repo names resolve to working directories. */
export const LIEBRE_ROOT =
  process.env.COWORK_LIEBRE_ROOT ?? "/Users/cesarhermosillo/code/lkmx/liebre";

export const PORT = Number(process.env.PORT ?? 8787);

// ---- ClickUp (Fase 2) ----
/** Personal API token (pk_...). When present, tasks sync live from ClickUp. */
export const CLICKUP_TOKEN = process.env.COWORK_CLICKUP_TOKEN ?? "";
/** Optional: pin a team/workspace id. Otherwise the first team is used. */
export const CLICKUP_TEAM_ID = process.env.COWORK_CLICKUP_TEAM_ID ?? "";
/** Optional comma-separated list ids to restrict the board. */
export const CLICKUP_LIST_IDS = (process.env.COWORK_CLICKUP_LIST_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** How often to auto-refresh the board, in ms (default 5 min). */
export const CLICKUP_REFRESH_MS = Number(process.env.COWORK_CLICKUP_REFRESH_MS ?? 300000);

// ---- Jira (Fase 3) ----
/** Jira Cloud site, e.g. https://yoursite.atlassian.net */
export const JIRA_BASE_URL = (process.env.COWORK_JIRA_BASE_URL ?? "").replace(/\/$/, "");
/** Atlassian account email (Basic auth user). */
export const JIRA_EMAIL = process.env.COWORK_JIRA_EMAIL ?? "";
/** Atlassian API token (Basic auth password). */
export const JIRA_TOKEN = process.env.COWORK_JIRA_TOKEN ?? "";
/** JQL used to pull the board. */
export const JIRA_JQL =
  process.env.COWORK_JIRA_JQL ?? "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

// ---- GitLab (Fase 4) ----
/** Instancia GitLab, default gitlab.com. Self-hosted: https://gitlab.tuco.com */
export const GITLAB_BASE_URL = (process.env.COWORK_GITLAB_BASE_URL ?? "https://gitlab.com").replace(/\/$/, "");
/** Personal Access Token (header PRIVATE-TOKEN). Presente = sync live. */
export const GITLAB_TOKEN = process.env.COWORK_GITLAB_TOKEN ?? "";
/** Opcional: acota a un proyecto (id o "grupo/path"). Vacío = todo lo asignado. */
export const GITLAB_PROJECT = process.env.COWORK_GITLAB_PROJECT ?? "";

// ---- ClickUp DM poller (opt-in; auto-lanza tareas detectadas en DMs) ----
export const DM_POLL = process.env.COWORK_DM_POLL === "1";
export const DM_POLL_MS = Number(process.env.COWORK_DM_POLL_MS ?? 120000);

// ---- Reportes de resumen (scheduler opt-in) ----
export const REPORT_SCHEDULE = process.env.COWORK_REPORT_SCHEDULE === "1";
export const REPORT_DAILY_AT = process.env.COWORK_REPORT_DAILY_AT ?? "19:00";
export const REPORT_WEEKLY_DAY = Number(process.env.COWORK_REPORT_WEEKLY_DAY ?? 5); // 0=Dom..6=Sáb, default vie
