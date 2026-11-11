import type { Update } from "./api.js";
import type { TelegramConfig } from "./store.js";

export type Authorization =
  | { ok: true; userId: number; chatId: number; threadId?: number }
  | { ok: false; reason: "user" | "chat" | "unconfigured" | "irrelevant" };

/**
 * Autoriza un update por ID de usuario y por grupo: ser miembro del grupo no da permiso.
 * Solo `message` y `callback_query` son relevantes; el resto (p. ej. `my_chat_member`) se descarta.
 */
export function authorizeUpdate(update: Update, config: TelegramConfig): Authorization {
  const origin = update.message
    ? { from: update.message.from, message: update.message }
    : update.callback_query
      ? { from: update.callback_query.from, message: update.callback_query.message }
      : null;
  if (!origin) return { ok: false, reason: "irrelevant" };
  if (config.userId === undefined || config.chatId === undefined) return { ok: false, reason: "unconfigured" };
  if (origin.from?.id !== config.userId) return { ok: false, reason: "user" };
  if (origin.message?.chat.id !== config.chatId) return { ok: false, reason: "chat" };
  const threadId = origin.message.message_thread_id;
  return threadId === undefined
    ? { ok: true, userId: config.userId, chatId: config.chatId }
    : { ok: true, userId: config.userId, chatId: config.chatId, threadId };
}
