import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TelegramApi, Update } from "./api.js";
import { handleSetupUpdate } from "./setup.js";
import { createTelegramStore, type TelegramConfig } from "./store.js";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function rig(config: Partial<TelegramConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "telegram-setup-"));
  dirs.push(dir);
  const store = createTelegramStore(dir);
  store.updateConfig({ botUsername: "ronin_bot", ...config });
  const sent: string[] = [];
  const api = { sendMessage: async (p: { text: string }) => { sent.push(p.text); return {}; } } as unknown as TelegramApi;
  return { store, api, sent };
}

const NOW = 1_000_000;
const msg = (text: string, from: number, chat: { id: number; type: string }, extra: object = {}): Update => ({
  update_id: 1,
  message: { message_id: 1, from: { id: from }, chat, text, ...extra },
});
const priv = (from: number) => ({ id: from, type: "private" });
const group = { id: -100, type: "supergroup" };

test("/start con el código correcto vincula al usuario y consume el código", async () => {
  const { store, api, sent } = rig({ pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start abc", 7, priv(7)), store, api, () => NOW), true);
  const config = store.readConfig();
  assert.equal(config.userId, 7);
  assert.equal(config.pairingCode, undefined);
  assert.equal(config.pairingExpiresAt, undefined);
  assert.equal(sent.length, 1);
});

test("el mismo código usado dos veces seguidas vincula solo al primero", async () => {
  const { store, api } = rig({ pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  const [a, b] = await Promise.all([
    handleSetupUpdate(msg("/start abc", 7, priv(7)), store, api, () => NOW),
    handleSetupUpdate(msg("/start abc", 8, priv(8)), store, api, () => NOW),
  ]);
  assert.deepEqual([a, b], [true, false]);
  assert.equal(store.readConfig().userId, 7);
});

test("/start con código incorrecto no vincula", async () => {
  const { store, api } = rig({ pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start abd", 7, priv(7)), store, api, () => NOW), false);
  assert.equal(store.readConfig().userId, undefined);
  assert.equal(store.readConfig().pairingCode, "abc");
});

test("/start sin código, o sin que exista un código, no vincula a un desconocido", async () => {
  const a = rig({ pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start", 7, priv(7)), a.store, a.api, () => NOW), false);
  assert.equal(a.store.readConfig().userId, undefined);
  const b = rig();
  assert.equal(await handleSetupUpdate(msg("/start", 7, priv(7)), b.store, b.api, () => NOW), false);
  assert.equal(await handleSetupUpdate(msg("/start x", 7, priv(7)), b.store, b.api, () => NOW), false);
  assert.equal(b.store.readConfig().userId, undefined);
});

test("un código vencido no vincula", async () => {
  const { store, api } = rig({ pairingCode: "abc", pairingExpiresAt: NOW - 1 });
  assert.equal(await handleSetupUpdate(msg("/start abc", 7, priv(7)), store, api, () => NOW), false);
  assert.equal(store.readConfig().userId, undefined);
});

test("un código sin vencimiento registrado no vincula", async () => {
  const { store, api } = rig({ pairingCode: "abc" });
  assert.equal(await handleSetupUpdate(msg("/start abc", 7, priv(7)), store, api, () => NOW), false);
});

test("/start con código en un grupo no vincula al usuario", async () => {
  const { store, api } = rig({ pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start abc", 7, group), store, api, () => NOW), false);
  assert.equal(store.readConfig().userId, undefined);
});

test("con un usuario vinculado, un /start nuevo de cualquiera no cambia nada", async () => {
  const { store, api } = rig({ userId: 7, pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start abc", 99, priv(99)), store, api, () => NOW), false);
  assert.equal(await handleSetupUpdate(msg("/start abc", 7, priv(7)), store, api, () => NOW), false);
  assert.equal(store.readConfig().userId, 7);
});

test("el grupo se vincula con código correcto, usuario vinculado y chat de grupo", async () => {
  const { store, api, sent } = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start@ronin_bot g1", 7, group), store, api, () => NOW), true);
  const config = store.readConfig();
  assert.equal(config.chatId, -100);
  assert.equal(config.groupCode, undefined);
  assert.equal(sent.length, 1);
});

test("el grupo acepta también /start <código> sin @bot", async () => {
  const { store, api } = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, { id: -5, type: "group" }), store, api, () => NOW), true);
  assert.equal(store.readConfig().chatId, -5);
});

test("vincular un grupo distinto descarta los temas del anterior", async () => {
  const { store, api } = rig({ userId: 7, chatId: -5, topics: { a: 1 }, disabledTopics: { b: 2 }, activatedAt: "x", groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, group), store, api, () => NOW), true);
  const config = store.readConfig();
  assert.equal(config.chatId, -100);
  assert.deepEqual(config.topics, {});
  assert.equal(config.disabledTopics, undefined);
  assert.equal(config.activatedAt, undefined);
});

test("vincular un grupo distinto limpia propuestas, borradores, preguntas y sesiones pero conserva el offset", async () => {
  const { store, api } = rig({ userId: 7, chatId: -5, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  store.updateState((s) => {
    s.offset = 42;
    s.proposals.p = { id: "p", repo: "a", instruction: "x", createdAt: 1, editMessageId: 3 };
    s.drafts.d = { id: "d", repo: "a", comment: "c", text: "t", createdAt: 1, editMessageId: 4 };
    s.questions.q = { session: "s", questionId: "q", messageId: 9, options: [], createdAt: "x" };
    s.sessions.s = { session: "s", repo: "a" };
    s.summaries.k = { session: "s", createdAt: 1 };
  });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, group), store, api, () => NOW), true);
  const state = store.readState();
  assert.equal(state.offset, 42);
  for (const key of ["proposals", "drafts", "questions", "sessions"] as const) assert.deepEqual(state[key], {}, key);
});

test("re-vincular el mismo grupo no toca el estado", async () => {
  const { store, api } = rig({ userId: 7, chatId: -100, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  store.updateState((s) => { s.sessions.s = { session: "s", repo: "a" }; });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, group), store, api, () => NOW), true);
  assert.ok(store.readState().sessions.s);
});

test("el grupo no se vincula si otro usuario manda el código", async () => {
  const { store, api } = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start@ronin_bot g1", 99, group), store, api, () => NOW), false);
  assert.equal(store.readConfig().chatId, undefined);
  assert.equal(store.readConfig().groupCode, "g1");
});

test("el grupo no se vincula con código incorrecto, vencido, sin usuario vinculado ni en chat privado", async () => {
  const wrong = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start g2", 7, group), wrong.store, wrong.api, () => NOW), false);
  const expired = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW - 1 });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, group), expired.store, expired.api, () => NOW), false);
  const noUser = rig({ groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, group), noUser.store, noUser.api, () => NOW), false);
  const privateChat = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start g1", 7, priv(7)), privateChat.store, privateChat.api, () => NOW), false);
  for (const r of [wrong, expired, noUser, privateChat]) assert.equal(r.store.readConfig().chatId, undefined);
});

test("/start@otro_bot no es para este bot", async () => {
  const { store, api } = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  assert.equal(await handleSetupUpdate(msg("/start@otro_bot g1", 7, group), store, api, () => NOW), false);
  assert.equal(store.readConfig().chatId, undefined);
});

test("my_chat_member solo no vincula el grupo", async () => {
  const { store, api } = rig({ userId: 7, groupCode: "g1", groupExpiresAt: NOW + 1000 });
  const update: Update = {
    update_id: 2,
    my_chat_member: { chat: group, from: { id: 7 }, new_chat_member: { status: "administrator", user: { id: 1 } } },
  };
  assert.equal(await handleSetupUpdate(update, store, api, () => NOW), false);
  assert.equal(store.readConfig().chatId, undefined);
});

test("migrate_to_chat_id actualiza el chat vinculado y conserva los temas", async () => {
  const { store, api } = rig({ userId: 7, chatId: -100, topics: { repoA: 11 }, disabledTopics: { repoB: 12 } });
  const update = msg("", 7, { id: -100, type: "group" }, { migrate_to_chat_id: -1002 });
  assert.equal(await handleSetupUpdate(update, store, api, () => NOW), true);
  const config = store.readConfig();
  assert.equal(config.chatId, -1002);
  assert.deepEqual(config.topics, { repoA: 11 });
  assert.deepEqual(config.disabledTopics, { repoB: 12 });
});

test("migrate_to_chat_id de un chat distinto al configurado se ignora", async () => {
  const { store, api } = rig({ userId: 7, chatId: -100, topics: {} });
  const update = msg("", 7, { id: -555, type: "group" }, { migrate_to_chat_id: -1002 });
  assert.equal(await handleSetupUpdate(update, store, api, () => NOW), false);
  assert.equal(store.readConfig().chatId, -100);
});

test("un fallo al responder no rechaza ni deshace el vínculo, y el texto no se registra", async () => {
  const { store } = rig({ pairingCode: "abc", pairingExpiresAt: NOW + 1000 });
  const api = { sendMessage: async () => { throw new Error("red"); } } as unknown as TelegramApi;
  const logs: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { logs.push(args); };
  try {
    assert.equal(await handleSetupUpdate(msg("/start abc", 7, priv(7)), store, api, () => NOW), true);
  } finally {
    console.warn = original;
  }
  assert.equal(store.readConfig().userId, 7);
  assert.equal(JSON.stringify(logs).includes("abc"), false);
});

test("updates sin mensaje, sin texto o ajenos devuelven false sin lanzar", async () => {
  const { store, api } = rig({ userId: 7 });
  assert.equal(await handleSetupUpdate({ update_id: 1 }, store, api, () => NOW), false);
  assert.equal(await handleSetupUpdate({ update_id: 1, message: { message_id: 1, chat: priv(7) } }, store, api, () => NOW), false);
  assert.equal(await handleSetupUpdate(msg("hola", 7, priv(7)), store, api, () => NOW), false);
  assert.equal(await handleSetupUpdate(msg("/startx abc", 7, priv(7)), store, api, () => NOW), false);
});
