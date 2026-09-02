import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePort } from "./port.js";

// Load server/.env (gitignored) before reading any config. Safe no-op if absent.
try {
  process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));
} catch {
  /* no .env file — rely on the ambient environment */
}

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

/** Interactive command used by a normal Claude terminal session (not the worker auto-mode). */
export const CLAUDE_TERMINAL_CMD = process.env.COWORK_CLAUDE_TERMINAL_CMD ?? "claude";

/** Interactive command used by a normal Codex terminal session. Kept server-owned. */
export const CODEX_CMD = process.env.COWORK_CODEX_CMD ?? "codex";

// ---- Modelos por rol (F0) ----
/**
 * Modelo del Planner (advisor): arranca el pane y escribe el plan / investiga / analiza PRs.
 * Se inyecta como `--model` sobre el startCommand del repo. Default `opus` (Opus 4.8; id
 * pineable `claude-opus-4-8`). Override por repo en repo-config.ts.
 */
export const PLANNER_MODEL = process.env.COWORK_PLANNER_MODEL ?? "opus";
/**
 * Modelo del Worker (implementer): sólo la fase de implementación, tras "PLAN APPROVED". El
 * poller cambia el pane a este modelo con `/model` al cruzar plan→impl. Default `sonnet`
 * (Sonnet; id pineable `claude-sonnet-5`). Override por repo en repo-config.ts.
 */
export const WORKER_MODEL = process.env.COWORK_WORKER_MODEL ?? "sonnet";

/** Root under which task.repo names resolve to working directories. */
export const LIEBRE_ROOT =
  process.env.COWORK_LIEBRE_ROOT ?? "/Users/cesarhermosillo/code/lkmx/liebre";

export const PORT = resolvePort(process.env.PORT);

// ---- Reportes de resumen (scheduler opt-in) ----
export const REPORT_SCHEDULE = process.env.COWORK_REPORT_SCHEDULE === "1";
/**
 * P2: el bucle que ejecuta los `verifyCmd` de las etapas. Opt-in como el de reportes, y por la
 * misma razón multiplicada: corre comandos declarados en el override por-repo. Apagado, el
 * servidor no abre el lazo; encendido, sigue inerte hasta que un repo declare un verifyCmd.
 */
export const VERIFY_GATE = process.env.COWORK_VERIFY_GATE === "1";
export const REPORT_DAILY_AT = process.env.COWORK_REPORT_DAILY_AT ?? "19:00";
export const REPORT_WEEKLY_DAY = Number(process.env.COWORK_REPORT_WEEKLY_DAY ?? 5); // 0=Dom..6=Sáb, default vie
