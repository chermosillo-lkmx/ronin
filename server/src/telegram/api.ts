export interface InlineButton {
  text: string;
  data: string;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date?: number;
  reply_to_message?: { message_id: number; message_thread_id?: number };
  migrate_to_chat_id?: number;
}

export interface Update {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramUser; message?: TelegramMessage; data?: string };
  my_chat_member?: { chat: TelegramChat; from: TelegramUser; new_chat_member: { status: string; user: TelegramUser } };
}

export interface SendMessageParams {
  chatId: number;
  threadId?: number;
  text: string;
  keyboard?: InlineButton[][];
  replyTo?: number;
  forceReply?: boolean;
}

export interface TelegramApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(offset: number | undefined, timeoutSec: number, signal?: AbortSignal): Promise<Update[]>;
  sendMessage(params: SendMessageParams): Promise<TelegramMessage>;
  editMessage(params: { chatId: number; messageId: number; text: string; keyboard?: InlineButton[][] }): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  createForumTopic(chatId: number, name: string): Promise<{ message_thread_id: number; name: string }>;
  getChat(chatId: number): Promise<TelegramChat>;
  getChatMember(chatId: number, userId: number): Promise<{ status: string; user: TelegramUser }>;
  sendDocument(params: { chatId: number; threadId?: number; filename: string; content: string }): Promise<TelegramMessage>;
}

/** Error de la Bot API o de red. Su mensaje se construye sin el token y no conserva `cause`. */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly retryAfter?: number;
  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

interface ApiEnvelope {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

function keyboardMarkup(keyboard: InlineButton[][]): unknown {
  return { inline_keyboard: keyboard.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const scrub = (text: string): string => (token ? text.split(token).join("<token>") : text);

  async function call<T>(method: string, init: { json?: unknown; form?: FormData; signal?: AbortSignal }): Promise<T> {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    let response: Response;
    try {
      response = await fetchImpl(
        url,
        init.form
          ? { method: "POST", body: init.form, signal: init.signal }
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(init.json ?? {}),
              signal: init.signal,
            },
      );
    } catch (error) {
      // Ni el mensaje ni `cause` ni el stack del original viajan: undici incluye la URL con el token.
      const reason = error instanceof Error ? error.message : String(error);
      throw new TelegramApiError(scrub(`${method}: fallo de red: ${reason}`), 0);
    }
    let body: ApiEnvelope = {};
    try {
      body = (await response.json()) as ApiEnvelope;
    } catch {
      // Cuerpo no JSON: se informa solo por el estado HTTP.
    }
    if (!response.ok || body.ok !== true) {
      const status = body.error_code ?? (response.status || 0);
      throw new TelegramApiError(
        scrub(`${method}: ${body.description ?? `HTTP ${response.status}`}`),
        status,
        body.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  const json = <T>(method: string, payload: unknown, signal?: AbortSignal) => call<T>(method, { json: payload, signal });

  return {
    getMe: () => json("getMe", {}),
    getUpdates: (offset, timeoutSec, signal) =>
      json("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query", "my_chat_member"] }, signal),
    sendMessage: ({ chatId, threadId, text, keyboard, replyTo, forceReply }) =>
      json("sendMessage", {
        chat_id: chatId,
        message_thread_id: threadId,
        text,
        reply_to_message_id: replyTo,
        reply_markup: keyboard ? keyboardMarkup(keyboard) : forceReply ? { force_reply: true } : undefined,
      }),
    editMessage: async ({ chatId, messageId, text, keyboard }) => {
      await json("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: keyboard ? keyboardMarkup(keyboard) : { inline_keyboard: [] },
      });
    },
    answerCallback: async (callbackId, text) => {
      await json("answerCallbackQuery", { callback_query_id: callbackId, text });
    },
    createForumTopic: (chatId, name) => json("createForumTopic", { chat_id: chatId, name }),
    getChat: (chatId) => json("getChat", { chat_id: chatId }),
    getChatMember: (chatId, userId) => json("getChatMember", { chat_id: chatId, user_id: userId }),
    sendDocument: ({ chatId, threadId, filename, content }) => {
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (threadId !== undefined) form.set("message_thread_id", String(threadId));
      form.set("document", new Blob([content], { type: "text/plain" }), filename);
      return call("sendDocument", { form });
    },
  };
}
