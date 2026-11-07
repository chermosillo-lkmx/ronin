import { randomBytes } from "node:crypto";
import type { McpSessionPort, McpSessionStatus } from "../mcp-sessions.js";
import { readLaunchRecord } from "../sessions.js";
import { cycleDirForSession, readEvidence } from "../stages.js";
import type { InlineButton } from "./api.js";
import { summaryButton } from "./conversation.js";
import { redactSecrets, type Outbound } from "./outbound.js";
import type { FollowedSession, TelegramConfig, TelegramStore } from "./store.js";

export const WATCH_INTERVAL_MS = 15_000;
/** Por encima, el texto va por `sendLong` y los botones en un mensaje aparte (igual que la conversación). */
const MAX_INLINE_CHARS = 3800;
const MAX_BUTTON_LABEL_CHARS = 60;
const MAX_LOGGED_ERROR_CHARS = 200;
/** Pasado esto, una pregunta enviada se olvida: su botón deja de valer y Responder es una orden nueva. */
export const QUESTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Ticks seguidos que hacen falta para dar por real un idle o un shell. */
const CONFIRM_TICKS = 2;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** El repo de un registro seguido, o null. Falla cerrado ante cualquier campo malformado. */
function followedRepo(raw: unknown, config: TelegramConfig): string | null {
  const rec = record(raw);
  if (!rec) return null;
  if (rec.mode !== "workflow" || (rec.channel !== "telegram" && rec.channel !== "ui")) return null;
  const { repo, createdAt } = rec;
  if (typeof repo !== "string" || !repo || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  const topics = record(config.topics);
  if (!topics || !Object.hasOwn(topics, repo) || typeof topics[repo] !== "number") return null;
  const activated = typeof config.activatedAt === "string" ? Date.parse(config.activatedAt) : NaN;
  if (!Number.isFinite(activated) || createdAt < activated) return null;
  return repo;
}

/** Telegram sigue sesiones de workflow lanzadas desde Telegram o la app, en repos con tema y tras activarse. */
export function isFollowed(raw: unknown, config: TelegramConfig): boolean {
  return followedRepo(raw, config) !== null;
}

export function isSessionFollowed(
  name: string,
  config: TelegramConfig,
  readRecord: (name: string) => unknown | null = readLaunchRecord,
): boolean {
  try {
    return isFollowed(readRecord(name), config);
  } catch {
    return false;
  }
}

export interface WatcherDeps {
  store: TelegramStore;
  outbound: Outbound;
  port: Pick<McpSessionPort, "status">;
  readRecord?: (name: string) => unknown | null;
  hasSummary?: (name: string) => boolean;
  /** Token del bot, capability y `vars`: nada de eso llega a un registro. */
  secrets: () => string[];
  now?: () => number;
  log?: (message: string) => void;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "")}…`;

export function createWatcher(deps: WatcherDeps): { tick(): Promise<void> } {
  const { store, outbound, port } = deps;
  const readRecord = deps.readRecord ?? readLaunchRecord;
  const hasSummary = deps.hasSummary ?? ((name: string) => Boolean(readEvidence(cycleDirForSession(name)).summary));
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string) => console.warn(`[telegram] ${message}`));
  const logFailure = (what: string, error: unknown): void => {
    let detail = "sin detalle";
    try {
      detail = error instanceof Error ? clip(redactSecrets(error.message, deps.secrets()), MAX_LOGGED_ERROR_CHARS) : "error";
    } catch {
      // Sin secretos a la mano no se registra el mensaje.
    }
    log(`${what}: ${detail}`);
  };

  /** Confirmaciones en memoria: perder la cuenta en un reinicio solo retrasa un aviso. */
  const idleSeen = new Map<string, { questionId: string; ticks: number }>();
  const shellTicks = new Map<string, number>();
  let running: Promise<void> = Promise.resolve();

  const current = (name: string): FollowedSession | undefined => {
    const sessions = store.readState().sessions;
    return Object.hasOwn(sessions, name) ? sessions[name] : undefined;
  };
  const patch = (name: string, fn: (entry: FollowedSession) => void): void => {
    store.updateState((state) => {
      if (Object.hasOwn(state.sessions, name)) fn(state.sessions[name]);
    });
  };

  /**
   * Marca el aviso como enviado ANTES de enviarlo, para que un reinicio a medias no lo repita;
   * si el envío falla, deshace la marca y un tick posterior lo reintenta.
   */
  async function reserved(
    name: string,
    mark: (entry: FollowedSession) => void,
    unmark: (entry: FollowedSession) => void,
    send: () => Promise<void>,
  ): Promise<boolean> {
    patch(name, mark);
    try {
      await send();
      return true;
    } catch (error) {
      logFailure(`aviso de ${name} no enviado`, error);
      try {
        patch(name, unmark);
      } catch (undoError) {
        logFailure(`no pude deshacer la marca de ${name}`, undoError);
      }
      return false;
    }
  }

  const where = (config: TelegramConfig, repo: string) => ({ chatId: config.chatId as number, threadId: config.topics[repo] });

  function summaryKeyboard(name: string): InlineButton[][] | undefined {
    try {
      return hasSummary(name) ? [[summaryButton(store, name, now())]] : undefined;
    } catch (error) {
      logFailure("botón de resumen", error);
      return undefined;
    }
  }

  const notice = (name: string, repo: string, config: TelegramConfig, text: string): (() => Promise<void>) => async () => {
    await outbound.send({ ...where(config, repo), text, keyboard: summaryKeyboard(name) });
  };

  async function sendQuestion(s: McpSessionStatus, entry: FollowedSession, config: TelegramConfig): Promise<void> {
    const questionId = s.questionId as string;
    const question = s.question as string;
    const options = s.options ?? [];
    const key = randomBytes(6).toString("hex");
    const keyboard = options.length
      ? options.map((option, index) => [{ text: clip(`${index + 1}. ${option}`, MAX_BUTTON_LABEL_CHARS), data: `q:${key}:${index + 1}` }])
      : undefined;
    const target = where(config, entry.repo);
    const previous = entry.lastQuestionId;
    await reserved(
      s.name,
      (e) => { e.lastQuestionId = questionId; },
      (e) => {
        if (e.lastQuestionId !== questionId) return;
        if (previous === undefined) delete e.lastQuestionId;
        else e.lastQuestionId = previous;
      },
      async () => {
        const text = `❓ ${s.name} pregunta:\n\n${question}`;
        let messageId: number;
        if (text.length <= MAX_INLINE_CHARS) {
          messageId = (await outbound.send({ ...target, text, keyboard })).message_id;
        } else {
          await outbound.sendLong({ ...target, title: `❓ ${s.name} pregunta`, text: question });
          // `sendLong` no devuelve ID: el mensaje corto con los botones es el destino de Responder.
          const short = `❓ ${s.name} pregunta (texto completo arriba). Responde a este mensaje.`;
          messageId = (await outbound.send({ ...target, text: short, keyboard })).message_id;
        }
        store.updateState((state) => {
          state.questions[key] = { session: s.name, questionId, messageId, options: [...options], createdAt: new Date(now()).toISOString() };
        });
      },
    );
  }

  async function watch(s: McpSessionStatus, config: TelegramConfig): Promise<void> {
    let raw: unknown = null;
    try {
      raw = readRecord(s.name);
    } catch {
      /* sin registro legible: no se sigue */
    }
    const repo = followedRepo(raw, config);
    if (!repo) return;
    if (!current(s.name)) {
      store.updateState((state) => {
        if (!Object.hasOwn(state.sessions, s.name)) state.sessions[s.name] = { session: s.name, repo };
      });
    }
    const entry = (): FollowedSession => current(s.name) as FollowedSession;
    const name = s.name;

    if (s.attention === "gone") {
      idleSeen.delete(name);
      shellTicks.delete(name);
      if (!entry().gone) {
        await reserved(name, (e) => { e.gone = true; }, (e) => { delete e.gone; },
          notice(name, repo, config, `⚠️ ${name} ya no está activa (la sesión terminó o murió).`));
      }
      return;
    }
    if (entry().gone) patch(name, (e) => { delete e.gone; });

    const done = s.stagesTotal > 0 && s.stagesDone === s.stagesTotal;
    if (done && !entry().finished) {
      await reserved(name, (e) => { e.finished = true; }, (e) => { delete e.finished; },
        notice(name, repo, config, `✅ ${name} terminó su flujo (${s.stagesDone}/${s.stagesTotal} etapas).`));
    }

    if (s.gate?.state === "failed") {
      const gateKey = `${s.gate.stage}:${s.gate.attempts ?? 0}`;
      if (entry().gateKey !== gateKey) {
        const previous = entry().gateKey;
        await reserved(name, (e) => { e.gateKey = gateKey; },
          (e) => { if (e.gateKey === gateKey) { if (previous === undefined) delete e.gateKey; else e.gateKey = previous; } },
          notice(name, repo, config, `❌ El gate de ${name} falló en la etapa ${s.gate.stage}${s.gate.attempts ? ` (intento ${s.gate.attempts})` : ""}.`));
      }
    } else if (entry().gateKey !== undefined) {
      patch(name, (e) => { delete e.gateKey; });
    }

    if (s.attention === "shell" && !done) {
      const ticks = (shellTicks.get(name) ?? 0) + 1;
      shellTicks.set(name, ticks);
      if (ticks >= CONFIRM_TICKS && !entry().stuck) {
        await reserved(name, (e) => { e.stuck = true; }, (e) => { delete e.stuck; },
          notice(name, repo, config, `⏸️ ${name} parece atascada: volvió a la terminal con el flujo sin terminar.`));
      }
    } else {
      shellTicks.delete(name);
      if (entry().stuck) patch(name, (e) => { delete e.stuck; });
    }

    const askable = s.needsInput && Boolean(s.questionId) && typeof s.question === "string" && s.question.trim() !== "";
    if (!s.needsInput && entry().lastQuestionId !== undefined) patch(name, (e) => { delete e.lastQuestionId; });
    if (!askable) {
      idleSeen.delete(name);
      return;
    }
    if (entry().lastQuestionId === s.questionId) return;
    if (s.attention === "idle") {
      const seen = idleSeen.get(name);
      const ticks = seen && seen.questionId === s.questionId ? seen.ticks + 1 : 1;
      idleSeen.set(name, { questionId: s.questionId as string, ticks });
      if (ticks < CONFIRM_TICKS) return;
    }
    idleSeen.delete(name);
    await sendQuestion(s, entry(), config);
  }

  async function vanished(entry: FollowedSession, config: TelegramConfig): Promise<void> {
    idleSeen.delete(entry.session);
    shellTicks.delete(entry.session);
    if (!entry.gone && !entry.finished) {
      const sent = await reserved(entry.session, (e) => { e.gone = true; }, (e) => { delete e.gone; },
        notice(entry.session, entry.repo, config, `⚠️ ${entry.session} ya no existe (la sesión se cerró o murió).`));
      if (!sent) return;
    }
    store.updateState((state) => { delete state.sessions[entry.session]; });
  }

  function pruneQuestions(): void {
    const stale = (createdAt: string): boolean => !(now() - Date.parse(createdAt) <= QUESTION_TTL_MS);
    try {
      // Sin nada que podar no se escribe: esto corre en cada tick.
      if (!Object.values(store.readState().questions).some((q) => stale(q.createdAt))) return;
      store.updateState((state) => {
        const pruned = Object.entries(state.questions).filter(([, q]) => stale(q.createdAt));
        for (const [key] of pruned) delete state.questions[key];
        // Si la sesión sigue esperando esa pregunta, olvidarla hace que el tick la reenvíe:
        // sin entrada no habría botón ni Responder que llegue al agente.
        for (const [, q] of pruned) {
          const followed = state.sessions[q.session];
          if (followed?.lastQuestionId !== q.questionId) continue;
          const kept = Object.values(state.questions).some((other) => other.session === q.session && other.questionId === q.questionId);
          if (!kept) delete followed.lastQuestionId;
        }
      });
    } catch (error) {
      logFailure("no pude podar las preguntas", error);
    }
  }

  async function runTick(): Promise<void> {
    const config = store.readConfig();
    if (typeof config.chatId !== "number") return;
    pruneQuestions();
    let statuses: McpSessionStatus[];
    try {
      statuses = await port.status();
    } catch (error) {
      logFailure("no pude leer el estado de las sesiones", error);
      return;
    }
    if (!Array.isArray(statuses)) return;
    const present = new Set<string>();
    for (const s of statuses) {
      present.add(s.name);
      try {
        await watch(s, config);
      } catch (error) {
        logFailure(`seguimiento de ${s.name}`, error);
      }
    }
    for (const entry of Object.values(store.readState().sessions)) {
      if (present.has(entry.session)) continue;
      try {
        await vanished(entry, config);
      } catch (error) {
        logFailure(`seguimiento de ${entry.session}`, error);
      }
    }
  }

  return {
    /** Nunca rechaza; los ticks no se solapan. */
    tick() {
      running = running.then(runTick).catch((error) => logFailure("tick", error));
      return running;
    },
  };
}
