import { constantTimeEqual } from "../security.js";
import type { TelegramApi, TelegramMessage, Update } from "./api.js";
import type { TelegramStore } from "./store.js";

/** Vigencia de los códigos de vinculación. */
export const PAIRING_TTL_MS = 30 * 60_000;

const START = /^\/start(?:@(\w+))?(?:\s+(\S+))?\s*$/;
const GROUP_TYPES = new Set(["group", "supergroup"]);

function codeMatches(expected: string | undefined, expiresAt: number | undefined, presented: string, now: number): boolean {
  if (!expected || expiresAt === undefined || !(expiresAt > now)) return false;
  return constantTimeEqual(expected, presented);
}

async function reply(api: TelegramApi, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage({ chatId, text });
  } catch {
    // El vínculo ya quedó guardado; la confirmación es cortesía y no cuenta el contenido del mensaje.
  }
}

/**
 * Atiende solo lo de la vinculación: `/start <código>` en privado, `/start[@bot] <código>` en el grupo
 * y la migración a supergrupo. Devuelve true si consumió el update; todo lo demás sigue a la conversación,
 * que lo autoriza. Nunca rechaza ni registra el contenido de los mensajes.
 *
 * Todas las lecturas y escrituras de configuración ocurren antes del primer `await`: dos updates con el
 * mismo código no pueden ganar ambos.
 */
export async function handleSetupUpdate(
  update: Update,
  store: TelegramStore,
  api: TelegramApi,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    const message = update.message;
    if (!message) return false;
    const config = store.readConfig();

    // Solo el chat ya vinculado puede migrar: un mensaje de servicio ajeno no mueve nada.
    if (message.migrate_to_chat_id !== undefined) {
      if (config.chatId === undefined || message.chat.id !== config.chatId) return false;
      store.migrateChat(config.chatId, message.migrate_to_chat_id);
      return true;
    }

    const match = typeof message.text === "string" ? START.exec(message.text) : null;
    if (!match) return false;
    const [, target, code] = match;
    if (!code || message.from === undefined) return false;
    if (target !== undefined && config.botUsername !== undefined && target.toLowerCase() !== config.botUsername.toLowerCase()) {
      return false;
    }

    if (message.chat.type === "private") return await pairUser(message, code, store, api, now());
    if (GROUP_TYPES.has(message.chat.type)) return await bindGroup(message, code, store, api, now());
    return false;
  } catch {
    return false;
  }
}

async function pairUser(message: TelegramMessage, code: string, store: TelegramStore, api: TelegramApi, now: number): Promise<boolean> {
  const config = store.readConfig();
  if (config.userId !== undefined) return false; // ya hay un usuario: solo el wizard reinicia la vinculación
  if (!codeMatches(config.pairingCode, config.pairingExpiresAt, code, now)) return false;
  store.updateConfig({ userId: message.from!.id, pairingCode: undefined, pairingExpiresAt: undefined });
  await reply(api, message.chat.id, "Listo: este usuario quedó vinculado a Ronin. Sigue en la app para agregar el grupo.");
  return true;
}

async function bindGroup(message: TelegramMessage, code: string, store: TelegramStore, api: TelegramApi, now: number): Promise<boolean> {
  const config = store.readConfig();
  if (config.userId === undefined || message.from!.id !== config.userId) return false;
  if (!codeMatches(config.groupCode, config.groupExpiresAt, code, now)) return false;
  // Los temas pertenecen al grupo anterior; en otro grupo no significan nada.
  const sameChat = config.chatId === message.chat.id;
  store.updateConfig({
    chatId: message.chat.id,
    groupCode: undefined,
    groupExpiresAt: undefined,
    ...(sameChat ? {} : { topics: {}, disabledTopics: undefined, activatedAt: undefined }),
  });
  if (!sameChat) {
    // Los IDs de mensaje son por chat: una pregunta o propuesta del grupo anterior podría coincidir con una respuesta del nuevo.
    store.updateState((state) => {
      state.proposals = {};
      state.drafts = {};
      state.questions = {};
      state.sessions = {};
    });
  }
  await reply(api, message.chat.id, "Grupo vinculado a Ronin. Vuelve a la app para elegir los repos.");
  return true;
}
