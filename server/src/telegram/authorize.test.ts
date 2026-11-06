import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Update } from "./api.js";
import { authorizeUpdate } from "./authorize.js";
import type { TelegramConfig } from "./store.js";

const config: TelegramConfig = { userId: 7, chatId: -100, topics: {} };
const msg = (from: number, chat: number, thread?: number): Update => ({
  update_id: 1,
  message: { message_id: 1, from: { id: from }, chat: { id: chat, type: "supergroup" }, message_thread_id: thread },
});
const click = (from: number, chat: number): Update => ({
  update_id: 2,
  callback_query: { id: "c", from: { id: from }, data: "x", message: { message_id: 5, chat: { id: chat, type: "supergroup" } } },
});

test("rechaza a otro miembro del grupo", () => {
  assert.deepEqual(authorizeUpdate(msg(8, -100), config), { ok: false, reason: "user" });
});
test("rechaza el toque de botón de otro miembro", () => {
  assert.deepEqual(authorizeUpdate(click(8, -100), config), { ok: false, reason: "user" });
});
test("acepta el toque de botón del autorizado", () => {
  assert.deepEqual(authorizeUpdate(click(7, -100), config), { ok: true, userId: 7, chatId: -100 });
});
test("rechaza al autorizado en otro chat", () => {
  assert.deepEqual(authorizeUpdate(msg(7, -200), config), { ok: false, reason: "chat" });
  assert.deepEqual(authorizeUpdate(click(7, -200), config), { ok: false, reason: "chat" });
});
test("acepta usuario y grupo correctos, con threadId", () => {
  assert.deepEqual(authorizeUpdate(msg(7, -100, 42), config), { ok: true, userId: 7, chatId: -100, threadId: 42 });
});
test("sin configurar, rechaza", () => {
  assert.deepEqual(authorizeUpdate(msg(7, -100), { topics: {} }), { ok: false, reason: "unconfigured" });
  assert.deepEqual(authorizeUpdate(msg(7, -100), { userId: 7, topics: {} }), { ok: false, reason: "unconfigured" });
});
test("my_chat_member es irrelevante", () => {
  const update: Update = {
    update_id: 3,
    my_chat_member: { chat: { id: -100, type: "supergroup" }, from: { id: 7 }, new_chat_member: { status: "member", user: { id: 9 } } },
  };
  assert.deepEqual(authorizeUpdate(update, config), { ok: false, reason: "irrelevant" });
});
test("mensaje sin remitente se rechaza como usuario", () => {
  const update: Update = { update_id: 4, message: { message_id: 1, chat: { id: -100, type: "supergroup" } } };
  assert.deepEqual(authorizeUpdate(update, config), { ok: false, reason: "user" });
});
