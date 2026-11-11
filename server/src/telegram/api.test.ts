import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createTelegramApi, TelegramApiError } from "./api.js";

const reply = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

test("un error de red no filtra el token", async () => {
  const api = createTelegramApi("123:SECRET", async () => {
    throw new Error("fetch failed https://api.telegram.org/bot123:SECRET/getMe", {
      cause: new Error("connect https://api.telegram.org/bot123:SECRET/getMe"),
    });
  });
  await assert.rejects(api.getMe(), (e: Error) => {
    assert.ok(e instanceof TelegramApiError);
    assert.equal(e.cause, undefined);
    assert.ok(!e.message.includes("SECRET") && !String(e.stack).includes("SECRET"));
    return true;
  });
});

test("429 expone retryAfter", async () => {
  const api = createTelegramApi("1:T", reply(429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } }));
  await assert.rejects(api.getMe(), (e: TelegramApiError) => e.status === 429 && e.retryAfter === 7);
});

test("409 expone status 409", async () => {
  const api = createTelegramApi("1:T", reply(409, { ok: false, error_code: 409, description: "Conflict" }));
  await assert.rejects(api.getUpdates(0, 1), (e: TelegramApiError) => e.status === 409);
});

test("getUpdates pide los tipos permitidos y devuelve result", async () => {
  let seen: { url: string; body: Record<string, unknown> } | undefined;
  const api = createTelegramApi("1:T", (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ ok: true, result: [{ update_id: 5 }] }));
  }) as unknown as typeof fetch);
  assert.deepEqual(await api.getUpdates(6, 30), [{ update_id: 5 }]);
  assert.ok(seen!.url.endsWith("/bot1:T/getUpdates"));
  assert.deepEqual(seen!.body, { offset: 6, timeout: 30, allowed_updates: ["message", "callback_query", "my_chat_member"] });
});

test("sendMessage traduce teclado, hilo, respuesta y force_reply", async () => {
  const bodies: Record<string, unknown>[] = [];
  const api = createTelegramApi("1:T", (async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1, type: "supergroup" } } }));
  }) as unknown as typeof fetch);
  await api.sendMessage({ chatId: 9, threadId: 3, text: "hola", keyboard: [[{ text: "Sí", data: "y" }]], replyTo: 4 });
  await api.sendMessage({ chatId: 9, text: "x", forceReply: true });
  assert.deepEqual(bodies[0], {
    chat_id: 9,
    message_thread_id: 3,
    text: "hola",
    reply_to_message_id: 4,
    reply_markup: { inline_keyboard: [[{ text: "Sí", callback_data: "y" }]] },
  });
  assert.deepEqual(bodies[1].reply_markup, { force_reply: true });
});

test("sendDocument envía multipart con el nombre de archivo", async () => {
  let form: FormData | undefined;
  const api = createTelegramApi("1:T", (async (_u: string, init: RequestInit) => {
    form = init.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2, chat: { id: 1, type: "supergroup" } } }));
  }) as unknown as typeof fetch);
  await api.sendDocument({ chatId: 1, threadId: 8, filename: "a.md", content: "hola" });
  assert.equal(form!.get("chat_id"), "1");
  assert.equal(form!.get("message_thread_id"), "8");
  assert.equal((form!.get("document") as File).name, "a.md");
});
