import { randomBytes } from "node:crypto";
import express, { type Request, type RequestHandler, type Response, type Router } from "express";
import { TelegramApiError, type TelegramApi } from "./api.js";
import type { TelegramRuntime } from "./service.js";
import { PAIRING_TTL_MS } from "./setup.js";
import type { TelegramConfig, TelegramState } from "./store.js";

export const STATUS_CACHE_MS = 10_000;
const MAX_TOKEN_LENGTH = 200;
const TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]+$/;

/** Textos fijos hacia la UI: nunca el mensaje crudo de un error, que puede traer rutas o el token. */
export const LAST_ERROR_TEXT = {
  invalidToken: "Token inválido",
  malformedToken: "Pega el token completo que te dio @BotFather.",
  network: "No pude conectar con Telegram para validar el token. Revisa tu conexión e inténtalo de nuevo.",
  group: "No pude consultar el grupo en Telegram; muestro lo último que sé.",
  internal: "Error interno al configurar Telegram.",
  noBot: "Primero guarda el token del bot.",
  noUser: "Primero vincula tu usuario.",
  userLinked: "Ya hay un usuario vinculado. Reinicia la vinculación desde Ronin para cambiarlo.",
  noGroup: "Primero vincula el grupo.",
  changed: "La configuración de Telegram cambió mientras se creaban los temas; no se guardó nada más. Revisa el estado e inténtalo de nuevo.",
  unknownRepo: "Hay repos que Ronin no conoce.",
  badRepos: "Se esperaba una lista de repos.",
  topics: "No pude crear el tema de algunos repos.",
} as const;

export interface TelegramRouterDeps {
  runtime: TelegramRuntime;
  listRepos(): string[];
  /** Cliente para el token candidato de `PUT /token`. */
  createApi(token: string): TelegramApi;
  now?: () => number;
}

interface GroupInfo {
  title: string;
  isForum: boolean;
  botIsAdmin: boolean;
  canManageTopics: boolean;
}

const emptyState = (): TelegramState => ({ proposals: {}, drafts: {}, questions: {}, sessions: {}, summaries: {} });
const newCode = (): string => randomBytes(24).toString("base64url");

export function createTelegramRouter(deps: TelegramRouterDeps): Router {
  const { runtime, listRepos, createApi } = deps;
  const { store } = runtime;
  const now = deps.now ?? Date.now;
  const router = express.Router();

  // ---- caché de lo que se sabe del grupo (la UI consulta cada 2 s) ----
  let cache: { chatId: number; at: number; info?: GroupInfo; failed: boolean } | null = null;
  let inflight: Promise<void> | null = null;
  let botId: number | undefined;
  const resetCache = (): void => {
    cache = null;
    botId = undefined;
  };

  async function queryGroup(api: TelegramApi, chatId: number): Promise<void> {
    const previous = cache?.chatId === chatId ? cache.info : undefined;
    try {
      if (botId === undefined) botId = (await api.getMe()).id;
      const chat = await api.getChat(chatId);
      const member = await api.getChatMember(chatId, botId);
      const creator = member.status === "creator";
      const admin = creator || member.status === "administrator";
      cache = {
        chatId,
        at: now(),
        failed: false,
        info: {
          title: chat.title ?? "",
          isForum: chat.is_forum === true,
          botIsAdmin: admin,
          canManageTopics: creator || (admin && member.can_manage_topics === true),
        },
      };
    } catch {
      cache = { chatId, at: now(), failed: true, ...(previous ? { info: previous } : {}) };
    }
  }

  async function groupInfo(chatId: number): Promise<{ info?: GroupInfo; failed: boolean }> {
    if (!cache || cache.chatId !== chatId || now() - cache.at >= STATUS_CACHE_MS) {
      const api = runtime.getApi();
      if (!api) return { failed: false };
      inflight ??= queryGroup(api, chatId).finally(() => { inflight = null; });
      await inflight;
    }
    return { info: cache?.info, failed: cache?.failed ?? false };
  }

  // ---- utilidades ----
  const handler = (fn: (req: Request, res: Response) => Promise<void> | void): RequestHandler =>
    async (req, res) => {
      try {
        await fn(req, res);
      } catch {
        if (!res.headersSent) res.status(500).json({ error: LAST_ERROR_TEXT.internal });
      }
    };

  const fail = (res: Response, status: number, error: string, extra: object = {}): void => {
    res.status(status).json({ error, ...extra });
  };

  const repoRows = (config: TelegramConfig) => listRepos().map((repo) => ({ repo, hasTopic: config.topics[repo] !== undefined }));

  // ---- rutas ----
  router.get("/status", handler(async (_req, res) => {
    const config = store.readConfig();
    let hasToken = false;
    try {
      hasToken = store.readToken() !== null;
    } catch {
      hasToken = false;
    }
    let group: { info?: GroupInfo; failed: boolean } = { failed: false };
    if (hasToken && config.userId !== undefined && config.chatId !== undefined) group = await groupInfo(config.chatId);

    const groupReady = group.info?.isForum && group.info.botIsAdmin && group.info.canManageTopics;
    let step: 1 | 2 | 3 | 4 | "done";
    if (!hasToken || !config.botUsername) step = 1;
    else if (config.userId === undefined) step = 2;
    else if (config.chatId === undefined || !groupReady) step = 3;
    else step = config.activatedAt !== undefined ? "done" : 4;

    const lastError = config.lastError ?? (group.failed ? LAST_ERROR_TEXT.group : undefined);
    res.json({
      step,
      ...(config.botUsername ? { botUsername: config.botUsername } : {}),
      userLinked: config.userId !== undefined,
      ...(group.info ? { group: group.info } : {}),
      repos: repoRows(config),
      ...(lastError ? { lastError } : {}),
      connected: hasToken && config.lastError === undefined,
    });
  }));

  router.put("/token", handler(async (req, res) => {
    const raw: unknown = req.body?.token;
    const token = typeof raw === "string" ? raw.trim() : "";
    if (!token || token.length > MAX_TOKEN_LENGTH || !TOKEN_SHAPE.test(token)) {
      return fail(res, 400, LAST_ERROR_TEXT.malformedToken);
    }
    let username: string | undefined;
    try {
      username = (await createApi(token).getMe()).username;
    } catch (error) {
      if (error instanceof TelegramApiError && (error.status === 401 || error.status === 404)) {
        return fail(res, 400, LAST_ERROR_TEXT.invalidToken);
      }
      return fail(res, 502, LAST_ERROR_TEXT.network);
    }
    if (!username) return fail(res, 400, LAST_ERROR_TEXT.invalidToken);

    // Los updates y los IDs pertenecen al bot anterior: todo lo ligado a él se descarta.
    store.updateConfig({
      botUsername: username,
      userId: undefined,
      chatId: undefined,
      topics: {},
      disabledTopics: undefined,
      activatedAt: undefined,
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      groupCode: undefined,
      groupExpiresAt: undefined,
      lastError: undefined,
    });
    store.writeToken(token);
    resetCache();
    runtime.reload();
    // Después de reload: el sondeo anterior ya está abortado y no puede reescribir el offset.
    store.updateState(() => emptyState());
    res.json({ botUsername: username });
  }));

  router.post("/pairing", handler((_req, res) => {
    const config = store.readConfig();
    if (!store.readToken() || !config.botUsername) return fail(res, 409, LAST_ERROR_TEXT.noBot);
    if (config.userId !== undefined) return fail(res, 409, LAST_ERROR_TEXT.userLinked);
    const code = newCode();
    store.updateConfig({ pairingCode: code, pairingExpiresAt: now() + PAIRING_TTL_MS });
    res.json({ link: `https://t.me/${config.botUsername}?start=${code}` });
  }));

  router.post("/group-link", handler((_req, res) => {
    const config = store.readConfig();
    if (!store.readToken() || !config.botUsername) return fail(res, 409, LAST_ERROR_TEXT.noBot);
    if (config.userId === undefined) return fail(res, 409, LAST_ERROR_TEXT.noUser);
    const code = newCode();
    store.updateConfig({ groupCode: code, groupExpiresAt: now() + PAIRING_TTL_MS });
    res.json({ link: `https://t.me/${config.botUsername}?startgroup=${code}&admin=manage_topics` });
  }));

  // Un solo PUT /repos a la vez: dos corriendo juntos crearían el mismo tema dos veces.
  let reposQueue: Promise<unknown> = Promise.resolve();

  router.put("/repos", handler(async (req, res) => {
    const requested: unknown = req.body?.repos;
    if (!Array.isArray(requested) || requested.some((item) => typeof item !== "string")) {
      return fail(res, 400, LAST_ERROR_TEXT.badRepos);
    }
    const known = new Set(listRepos());
    const desired = [...new Set(requested as string[])];
    if (desired.some((repo) => !known.has(repo))) return fail(res, 400, LAST_ERROR_TEXT.unknownRepo);

    const run = reposQueue.then(async () => {
      const config = store.readConfig();
      const api = runtime.getApi();
      if (config.chatId === undefined || !api) return { status: 409 as const, changed: false, failed: [] as string[] };

      // Desmarcar quita el repo de `topics` (nada lo enruta ni lo sigue) pero guarda su hilo; marcarlo lo restaura.
      const topics = { ...config.topics };
      const disabled = { ...(config.disabledTopics ?? {}) };
      for (const repo of Object.keys(topics)) {
        if (desired.includes(repo)) continue;
        disabled[repo] = topics[repo];
        delete topics[repo];
      }
      for (const repo of desired) {
        if (topics[repo] === undefined && disabled[repo] !== undefined) {
          topics[repo] = disabled[repo];
          delete disabled[repo];
        }
      }
      store.updateConfig({ topics, disabledTopics: Object.keys(disabled).length > 0 ? disabled : undefined });

      // Durante un await la configuración puede cambiar (DELETE /, token nuevo, otro grupo): si el grupo o el
      // bot ya no son los de este PUT, no se escribe nada más ni se sigue creando temas con el API anterior.
      const chatId = config.chatId;
      const token = store.readToken();
      const stale = (): boolean => store.readConfig().chatId !== chatId || store.readToken() !== token;
      const failed: string[] = [];
      for (const repo of desired) {
        if (topics[repo] !== undefined) continue;
        if (stale()) return { status: 409 as const, changed: true, failed };
        let threadId: number | undefined;
        try {
          threadId = (await api.createForumTopic(chatId, repo)).message_thread_id;
        } catch {
          failed.push(repo);
        }
        if (stale()) return { status: 409 as const, changed: true, failed };
        if (threadId === undefined) continue;
        topics[repo] = threadId;
        store.updateConfig({ topics: { ...store.readConfig().topics, [repo]: threadId } });
      }
      const current = store.readConfig();
      if (current.activatedAt === undefined && Object.keys(current.topics).length > 0) {
        store.updateConfig({ activatedAt: new Date(now()).toISOString() });
      }
      return { status: failed.length > 0 ? (502 as const) : (200 as const), failed };
    });
    reposQueue = run.catch(() => undefined);
    const result = await run;

    if (result.status === 409) return fail(res, 409, result.changed ? LAST_ERROR_TEXT.changed : LAST_ERROR_TEXT.noGroup);
    const rows = repoRows(store.readConfig());
    if (result.status === 502) return fail(res, 502, LAST_ERROR_TEXT.topics, { failed: result.failed, repos: rows });
    res.json({ repos: rows });
  }));

  router.delete("/", handler((_req, res) => {
    store.clearAll();
    resetCache();
    runtime.reload();
    res.json({ ok: true });
  }));

  return router;
}
