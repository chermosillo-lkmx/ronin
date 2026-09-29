import { McpToolError, type McpSessionPort, type McpSessionStatus } from "./mcp-sessions.js";
import { SessionLaunchError, type ManagedSessionLaunchInput } from "./session-launch.js";
import { detectDecision, menuIsLastLine, paneAttention } from "./attention.js";
import { claudeAlive, lastMeaningfulText, MAX_PANE_KEYS_BYTES } from "./tmux.js";
import type { TmuxSessionInfo } from "./types.js";

export interface SessionPortDeps {
  listRepos(): string[];
  listWorkflows(): Array<{ id: string; name: string; stages: string[] }>;
  launch(input: ManagedSessionLaunchInput): Promise<{ name: string; branch?: string; worktree?: string }>;
  inventory(): Promise<TmuxSessionInfo[]>;
  /** Captura fresca de la cola de esos panes (mismo helper que el inventario); null/ausente = no existe. */
  capture(paneIds: string[]): Promise<Map<string, string | null>>;
  /** Misma entrega que /keys y broadcast: teclea o pega por buffer según el tamaño (deliverText). */
  deliver(paneId: string, text: string, submit: boolean): Promise<void>;
  now(): number;
}

const MAX_QUESTION = 500;

/** Mismo criterio que el diálogo "Nueva sesión": primeras palabras en slug, con prefijo cowork-. */
export function deriveSessionName(request: string, now: number): string {
  const source = request.trim().split(/\s+/).slice(0, 4).join(" ");
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug ? `cowork-${slug}` : `cowork-sesion-${now}`;
}

/** Etiquetas del menú numerado que espera al usuario; vacío si la decisión no es un menú. */
function menuOptions(pane: string | null | undefined): string[] {
  return pane ? detectDecision(pane)?.options ?? [] : [];
}

/** `pane`: captura fresca del pane que pidió atención, si se tomó; aporta las opciones del menú. */
export function toStatus(session: TmuxSessionInfo, pane?: string | null): McpSessionStatus {
  const flow = session.flow;
  const current = flow?.stages.find((stage) => stage.status === "current" || stage.status === "failed");
  const failed = flow?.stages.find((stage) => stage.status === "failed");
  const level = session.attention?.level ?? null;
  const pending = flow ? flow.done < flow.total : true;
  const needsInput = level === "decision" || (level === "idle" && pending);
  const status: McpSessionStatus = {
    name: session.name,
    workflow: flow?.workflow ?? null,
    stage: current?.key ?? null,
    stagesDone: flow?.done ?? 0,
    stagesTotal: flow?.total ?? 0,
    attention: level,
    needsInput,
    gate: failed ? { stage: failed.key, ...(failed.attempts !== undefined ? { attempts: failed.attempts } : {}) } : null,
  };
  if (session.attention?.question) status.question = session.attention.question.slice(0, MAX_QUESTION);
  else if (level === "idle" && needsInput && pane) {
    // Spec §4.2: sin diálogo detectado, la pregunta es la última línea significativa del pane.
    const question = lastMeaningfulText(pane, MAX_QUESTION);
    if (question) status.question = question;
  }
  const options = level === "decision" ? menuOptions(pane) : [];
  if (options.length) status.options = options;
  return status;
}

/**
 * Re-chequeo EN VIVO antes de escribir: el inventario puede tener segundos y paneAttention mira
 * la decisión antes que claudeAlive, así que un `[y/n]` rancio sobre un shell (Claude salió y
 * corre `exec $SHELL -l`) se ve como `decision`. Sólo se escribe si el agente sigue vivo.
 */
function liveWaiting(pane: string | null, pending: boolean): boolean {
  if (pane === null) return false;
  const level = paneAttention(pane).level;
  if (level === "decision") return claudeAlive(pane) || menuIsLastLine(pane);
  return level === "idle" && pending;
}

export function createSessionPort(deps: SessionPortDeps): McpSessionPort {
  const managed = async () => (await deps.inventory()).filter((session) => session.kind === "managed");
  // Sólo se capturan los panes que pueden estar esperando: decisión (opciones) o idle (pregunta).
  const waitingPane = (session: TmuxSessionInfo) => {
    const level = session.attention?.level;
    return level === "decision" || level === "idle" ? session.attention?.paneId : undefined;
  };
  return {
    async catalog() {
      return { repos: deps.listRepos(), workflows: deps.listWorkflows() };
    },
    async launch(input) {
      const name = input.name ?? deriveSessionName(input.request, deps.now());
      try {
        const launched = await deps.launch({
          repo: input.repo, workflowId: input.workflowId, name, mode: "workflow", request: input.request,
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
        });
        return { name: launched.name, ...(launched.branch ? { branch: launched.branch } : {}), ...(launched.worktree ? { worktree: launched.worktree } : {}) };
      } catch (error) {
        if (error instanceof SessionLaunchError) throw new McpToolError(error.code, error.message);
        throw error;
      }
    },
    async status(names) {
      const sessions = await managed();
      const wanted = names === undefined ? sessions : sessions.filter((session) => names.includes(session.name));
      const paneIds = wanted.map(waitingPane).filter((id): id is string => Boolean(id));
      const panes = paneIds.length ? await deps.capture(paneIds) : new Map<string, string | null>();
      return wanted.map((session) => toStatus(session, panes.get(waitingPane(session) ?? "")));
    },
    async reply(name, text) {
      const session = (await managed()).find((item) => item.name === name);
      if (!session) throw new McpToolError("SESSION_NOT_FOUND", `no hay una sesión gestionada llamada ${name}`);
      const status = toStatus(session);
      const paneId = session.attention?.paneId;
      if (!status.needsInput || !paneId) throw new McpToolError("SESSION_NOT_WAITING", "la sesión no está esperando una respuesta");
      const clean = text.split("\x00").join("");
      if (Buffer.byteLength(clean, "utf8") > MAX_PANE_KEYS_BYTES) {
        throw new McpToolError("PAYLOAD_TOO_LARGE", `texto por encima de ${MAX_PANE_KEYS_BYTES} bytes`);
      }
      const live = (await deps.capture([paneId])).get(paneId) ?? null;
      const pending = session.flow ? session.flow.done < session.flow.total : true;
      if (!liveWaiting(live, pending)) throw new McpToolError("SESSION_NOT_WAITING", "la sesión no está esperando una respuesta");
      // En un menú numerado (p. ej. permisos de Claude) texto + Enter confirmaría la opción
      // resaltada: sólo se acepta el número de una opción y se envía sólo esa tecla.
      const options = paneAttention(live!).level === "decision" ? menuOptions(live) : [];
      if (options.length) {
        const choice = clean.trim();
        const valid = options.map((_, index) => String(index + 1));
        if (!valid.includes(choice)) {
          throw new McpToolError("SESSION_EXPECTS_OPTION", `la sesión espera una opción del menú: responde sólo con ${valid.join(", ")}`);
        }
        await deps.deliver(paneId, choice, false);
        return;
      }
      await deps.deliver(paneId, clean, true);
    },
  };
}
