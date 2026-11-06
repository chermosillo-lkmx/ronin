import { readCapabilityToken } from "../capability.js";
import type { McpSessionPort } from "../mcp-sessions.js";
import { getRepoVars } from "../repo-config.js";
import { listRepos } from "../repos.js";
import type { ManagedSessionLaunchInput } from "../session-launch.js";
import { cycleDirForSession, readEvidence } from "../stages.js";
import { createTelegramApi, TelegramApiError, type TelegramApi, type Update } from "./api.js";
import { createConversation, type ConversationDeps, type ReportsPort } from "./conversation.js";
import { createOutbound } from "./outbound.js";
import type { TelegramStore } from "./store.js";
import { createWatcher, isSessionFollowed, WATCH_INTERVAL_MS } from "./watcher.js";

export const POLL_TIMEOUT_SEC = 30;
export const MAX_CONCURRENT_UPDATES = 4;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const CONFLICT_WAIT_MS = 60_000;
/** Cuánto espera `stop` al bucle de sondeo: un `fetch` real aborta al instante, esto es solo un tope. */
const STOP_GRACE_MS = 3_000;

/** Textos fijos para la UI: nunca un mensaje de error crudo, que podría traer rutas o datos del token. */
export const LAST_ERROR = {
  network: "No pude conectar con Telegram; reintentando.",
  conflict: "Otro proceso está usando este bot (por ejemplo Kitsune con el mismo token). Ronin espera a que lo libere.",
  unauthorized: "Telegram rechazó el token del bot. Revisa el token en Ajustes.",
  rateLimited: "Telegram pidió esperar un momento; reintentando.",
} as const;

export interface TelegramRuntimeDeps {
  store: TelegramStore;
  port: Pick<McpSessionPort, "catalog" | "reply" | "status">;
  launch(input: ManagedSessionLaunchInput): Promise<{ name: string }>;
  reports: ReportsPort;
  summaryFor?: (session: string) => string | null;
  /** Costuras de prueba. */
  createApi?: (token: string) => TelegramApi;
  conversation?: (deps: ConversationDeps) => { handle(update: Update): Promise<void> };
  capabilityToken?: () => string | null;
  repoVars?: () => string[];
  /** Espera abortable; el valor por defecto usa temporizadores reales. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  watchIntervalMs?: number;
  /** Costura interna (la usa el emparejamiento): devuelve true si manejó el update y la conversación no debe verlo. */
  onUpdate?: (update: Update, api: TelegramApi) => Promise<boolean>;
}

export interface TelegramRuntime {
  /** Arranca el sondeo y el watcher; devuelve la función que los detiene. Sin token no hace nada. */
  start(): () => Promise<void>;
  /** Vuelve a leer token y configuración; sin dos bucles a la vez. No hace nada si no está arrancado. */
  reload(): void;
  readonly store: TelegramStore;
  getApi(): TelegramApi | null;
}

interface Session {
  api: TelegramApi;
  handle(update: Update): Promise<void>;
  tick(): Promise<void>;
}

interface Loop {
  abort: AbortController;
  done: Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

function defaultRepoVars(): string[] {
  const out: string[] = [];
  for (const repo of listRepos()) {
    try {
      out.push(...Object.values(getRepoVars(repo)));
    } catch {
      // Un repo ilegible no impide redactar los demás.
    }
  }
  return out;
}

export function createTelegramRuntime(deps: TelegramRuntimeDeps): TelegramRuntime {
  const { store, port } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const createApi = deps.createApi ?? ((token: string) => createTelegramApi(token));
  const capabilityToken = deps.capabilityToken ?? (() => readCapabilityToken());
  const repoVars = deps.repoVars ?? defaultRepoVars;
  const watchIntervalMs = deps.watchIntervalMs ?? WATCH_INTERVAL_MS;
  const rawLog = deps.log ?? ((message: string) => console.warn(`[telegram] ${message}`));
  const log = (message: string): void => {
    try {
      rawLog(message);
    } catch {
      // Un registro roto no puede tumbar el servicio.
    }
  };
  const summaryFor =
    deps.summaryFor ?? ((session: string) => readEvidence(cycleDirForSession(session)).summary ?? null);

  let started = false;
  let session: Session | null = null;
  let loop: Loop = { abort: new AbortController(), done: Promise.resolve() };
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  let stopping: Promise<void> | undefined;

  /** Token, capability y `vars`, leídos al enviar; una fuente rota no quita las demás. */
  function secrets(): string[] {
    const out: string[] = [];
    const collect = (read: () => unknown): void => {
      try {
        const value = read();
        for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string" && item) out.push(item);
      } catch {
        // Ver arriba.
      }
    };
    collect(() => store.readToken());
    collect(capabilityToken);
    collect(repoVars);
    return out;
  }

  function buildSession(): Session | null {
    let token: string | null = null;
    try {
      token = store.readToken();
    } catch (error) {
      log(`no pude leer el token (${error instanceof Error ? error.name : "error"})`);
    }
    if (!token) return null;
    const api = createApi(token);
    const outbound = createOutbound(api, { secrets });
    const conversationDeps: ConversationDeps = {
      store,
      outbound,
      answerCallback: (id) => api.answerCallback(id),
      port,
      launch: (input) => deps.launch(input),
      reports: deps.reports,
      status: () => port.status(),
      isFollowed: (name) => isSessionFollowed(name, store.readConfig()),
      summaryFor,
      secrets,
      now,
      log,
    };
    const conversation = (deps.conversation ?? createConversation)(conversationDeps);
    const watcher = createWatcher({ store, outbound, port, now, log });
    return {
      api,
      tick: () => watcher.tick(),
      handle: async (update) => {
        if (deps.onUpdate && (await deps.onUpdate(update, api))) return;
        await conversation.handle(update);
      },
    };
  }

  // ---- despacho: sin esperar al handler, con tope de concurrencia ----
  const queue: Array<{ handle: Session["handle"]; update: Update }> = [];
  let active = 0;

  function pump(): void {
    while (active < MAX_CONCURRENT_UPDATES && queue.length > 0) {
      const { handle, update } = queue.shift()!;
      active += 1;
      Promise.resolve()
        .then(() => handle(update))
        .catch(() => log("un update falló al procesarse"))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  }

  function dispatch(current: Session, update: Update): void {
    queue.push({ handle: current.handle, update });
    pump();
  }

  // ---- estado visible ----
  let shownError: string | undefined;
  function setLastError(text: string | undefined): void {
    if (shownError === text) return;
    try {
      if (text === undefined && store.readConfig().lastError === undefined) {
        shownError = undefined;
        return;
      }
      store.updateConfig({ lastError: text });
      shownError = text;
    } catch {
      log("no pude guardar el estado de Telegram");
    }
  }

  function releaseStaleClaims(): void {
    const kinds = ["proposals", "drafts", "questions", "summaries"] as const;
    const claimedItems = (state: ReturnType<TelegramStore["readState"]>) =>
      kinds.flatMap((kind) => Object.values(state[kind] as Record<string, { claimed?: boolean }>)).filter((item) => item?.claimed);
    try {
      // Sin reclamos no se escribe nada: un arranque limpio no toca el disco.
      if (claimedItems(store.readState()).length === 0) return;
      store.updateState((state) => {
        for (const item of claimedItems(state)) delete item.claimed;
      });
    } catch {
      log("no pude liberar reclamos pendientes");
    }
  }

  // ---- bucle de sondeo ----
  async function poll(current: Session, signal: AbortSignal, previous: Promise<void>): Promise<void> {
    await previous; // nunca dos getUpdates a la vez
    let offset: number | undefined;
    try {
      offset = store.readState().offset;
    } catch {
      offset = undefined;
    }
    let backoff = BACKOFF_START_MS;
    let lastFailure = "";
    while (!signal.aborted) {
      try {
        const updates = await current.api.getUpdates(offset, POLL_TIMEOUT_SEC, signal);
        if (signal.aborted) return; // sin avanzar el offset: Telegram lo reenvía
        backoff = BACKOFF_START_MS;
        lastFailure = "";
        setLastError(undefined);
        let next = offset;
        for (const update of updates) {
          dispatch(current, update);
          if (Number.isFinite(update.update_id)) next = Math.max(next ?? 0, update.update_id + 1);
        }
        if (next !== offset) {
          offset = next;
          try {
            store.updateState((state) => { state.offset = next; });
          } catch {
            log("no pude guardar el offset");
          }
        }
      } catch (error) {
        if (signal.aborted) return; // el abort llega como TelegramApiError de estado 0
        const status = error instanceof TelegramApiError ? error.status : -1;
        if (status === 401 || status === 404) {
          setLastError(LAST_ERROR.unauthorized);
          log("Telegram rechazó el token; el sondeo se detiene");
          return;
        }
        let wait = backoff;
        if (status === 409) {
          setLastError(LAST_ERROR.conflict);
          wait = CONFLICT_WAIT_MS;
        } else if (status === 429) {
          setLastError(LAST_ERROR.rateLimited);
          wait = Math.max(1, (error instanceof TelegramApiError ? error.retryAfter : undefined) ?? 1) * 1000;
        } else {
          setLastError(LAST_ERROR.network);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
        const failure = `getUpdates falló (estado ${status})`;
        if (failure !== lastFailure) log(failure);
        lastFailure = failure;
        await sleep(wait, signal);
      }
    }
  }

  function startLoop(): void {
    const previous = loop.done;
    const abort = new AbortController();
    session = buildSession();
    if (!session) {
      loop = { abort, done: previous };
      return;
    }
    loop = {
      abort,
      done: poll(session, abort.signal, previous).catch(() => log("el sondeo terminó con un error inesperado")),
    };
  }

  function stopLoop(): void {
    loop.abort.abort();
    queue.length = 0;
  }

  function startTimer(): void {
    timer = setInterval(() => {
      if (!session || ticking) return;
      ticking = true;
      session.tick().finally(() => { ticking = false; });
    }, watchIntervalMs);
    timer.unref();
  }

  async function stop(): Promise<void> {
    started = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    stopLoop();
    const grace = new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS).unref());
    await Promise.race([loop.done, grace]);
  }

  return {
    store,
    getApi: () => session?.api ?? null,
    start() {
      if (started) return () => stopping ?? Promise.resolve();
      started = true;
      stopping = undefined;
      releaseStaleClaims();
      startLoop();
      startTimer();
      return () => (stopping ??= stop());
    },
    reload() {
      if (!started) return;
      stopLoop();
      startLoop();
    },
  };
}
