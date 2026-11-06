import { TelegramApiError, type InlineButton, type SendMessageParams, type TelegramApi, type TelegramMessage } from "./api.js";

export const REDACTED = "[redactado]";
const MAX_CHUNK = 4096;
const MAX_CHUNKS_AS_MESSAGES = 3;
const PER_MINUTE = 20;
const WINDOW_MS = 60_000;

/** Sustituye cada secreto (los más largos primero) por `[redactado]`. */
export function redactSecrets(text: string, secrets: string[]): string {
  const ordered = secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  return ordered.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
}

export interface OutboundOptions {
  /** Se lee en cada envío. */
  secrets: () => string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Outbound {
  send(msg: SendMessageParams): Promise<TelegramMessage>;
  sendLong(msg: { chatId: number; threadId?: number; title: string; text: string }): Promise<void>;
}

/** Parte en trozos de a lo sumo `max`, prefiriendo cortar en salto de línea. */
function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const nl = rest.lastIndexOf("\n", max - 1);
    const cut = nl > max / 2 ? nl + 1 : max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

export function createOutbound(api: TelegramApi, opts: OutboundOptions): Outbound {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const redact = (text: string): string => redactSecrets(text, opts.secrets());
  const redactKeyboard = (kb?: InlineButton[][]) => kb?.map((row) => row.map((b) => ({ ...b, text: redact(b.text) })));

  const sentAt = new Map<number, number[]>();
  const tails = new Map<number, Promise<unknown>>();

  /** Espera hasta que el grupo tenga hueco en la ventana de un minuto y reserva el envío. */
  async function reserve(chatId: number): Promise<void> {
    for (;;) {
      const times = (sentAt.get(chatId) ?? []).filter((t) => now() - t < WINDOW_MS);
      if (times.length < PER_MINUTE) {
        times.push(now());
        sentAt.set(chatId, times);
        return;
      }
      sentAt.set(chatId, times);
      await sleep(Math.max(1, times[0] + WINDOW_MS - now()));
    }
  }

  /** Serializa por grupo; un fallo rechaza a su llamador sin detener la cola. */
  function enqueue<T>(chatId: number, job: () => Promise<T>): Promise<T> {
    const run = (tails.get(chatId) ?? Promise.resolve()).then(job);
    tails.set(chatId, run.catch(() => undefined));
    return run;
  }

  /** Único reintento: solo tras un 429, esperando `retryAfter`. */
  async function attempt<T>(chatId: number, call: () => Promise<T>): Promise<T> {
    await reserve(chatId);
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof TelegramApiError) || error.status !== 429) throw error;
      await sleep((error.retryAfter ?? 1) * 1000);
      await reserve(chatId);
      return call();
    }
  }

  const send = (msg: SendMessageParams): Promise<TelegramMessage> =>
    enqueue(msg.chatId, () =>
      attempt(msg.chatId, () => api.sendMessage({ ...msg, text: redact(msg.text), keyboard: redactKeyboard(msg.keyboard) })),
    );

  const sendLong: Outbound["sendLong"] = async ({ chatId, threadId, title, text }) => {
    const full = redact(title ? `${title}\n\n${text}` : text);
    const parts = chunk(full, MAX_CHUNK);
    if (parts.length > MAX_CHUNKS_AS_MESSAGES) {
      const base = redact(title).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "mensaje";
      await enqueue(chatId, () =>
        attempt(chatId, () => api.sendDocument({ chatId, threadId, filename: `${base}.txt`, content: full })),
      );
      return;
    }
    for (const part of parts) await send({ chatId, threadId, text: part });
  };

  return { send, sendLong };
}
