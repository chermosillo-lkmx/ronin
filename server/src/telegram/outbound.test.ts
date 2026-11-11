import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TelegramApiError, type SendMessageParams, type TelegramApi } from "./api.js";
import { createOutbound, redactSecrets } from "./outbound.js";

interface Fake {
  api: TelegramApi;
  messages: SendMessageParams[];
  documents: { filename: string; content: string }[];
}

function fake(behavior: (n: number) => void = () => {}): Fake {
  const messages: SendMessageParams[] = [];
  const documents: { filename: string; content: string }[] = [];
  let n = 0;
  const api = {
    sendMessage: async (p: SendMessageParams) => {
      n += 1;
      behavior(n);
      messages.push(p);
      return { message_id: n, chat: { id: p.chatId, type: "supergroup" } };
    },
    sendDocument: async (p: { chatId: number; filename: string; content: string }) => {
      documents.push({ filename: p.filename, content: p.content });
      return { message_id: 99, chat: { id: p.chatId, type: "supergroup" } };
    },
  } as unknown as TelegramApi;
  return { api, messages, documents };
}

function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

test("redactSecrets sustituye y prefiere el secreto más largo", () => {
  assert.equal(redactSecrets("a abc b ab", ["ab", "abc", ""]), "a [redactado] b [redactado]");
});

test("redactSecrets redacta secretos cortos y es idempotente", () => {
  const once = redactSecrets("a b a", ["a"]);
  assert.equal(once, "[redactado] b [redactado]");
  assert.equal(redactSecrets(once, ["a"]), once);
  assert.equal(redactSecrets(once, ["a", "re", "dactado", "[", "]"]), once);
  assert.equal(redactSecrets("x.y x+y", ["x.y", "x+y"]), "[redactado] [redactado]");
  assert.equal(redactSecrets("x y", ["", ""]), "x y");
});

test("un trozo no crece más allá de su tamaño por re-redacción con un secreto corto", async () => {
  const f = fake();
  await createOutbound(f.api, { secrets: () => ["a"] }).sendLong({ chatId: 1, title: "", text: "a".repeat(400) });
  assert.ok(f.messages.every((m) => m.text.length <= 4096));
  assert.equal(f.messages.map((m) => m.text).join(""), "[redactado]".repeat(400));
});

test("sendLong de 5000 caracteres envía 2 mensajes ≤4096", async () => {
  const f = fake();
  await createOutbound(f.api, { secrets: () => [] }).sendLong({ chatId: 1, title: "", text: "x".repeat(5000) });
  assert.equal(f.messages.length, 2);
  assert.ok(f.messages.every((m) => m.text.length <= 4096));
  assert.equal(f.messages.map((m) => m.text).join(""), "x".repeat(5000));
  assert.equal(f.documents.length, 0);
});

test("sendLong de 20000 caracteres envía un documento", async () => {
  const f = fake();
  await createOutbound(f.api, { secrets: () => [] }).sendLong({ chatId: 1, title: "Informe 1/2", text: "y".repeat(20000) });
  assert.equal(f.messages.length, 0);
  assert.equal(f.documents.length, 1);
  assert.equal(f.documents[0].filename, "Informe-1-2.txt");
});

test("todo texto saliente pasa por la redacción", async () => {
  const f = fake();
  let secret = "tok:ABC";
  const out = createOutbound(f.api, { secrets: () => [secret] });
  await out.send({ chatId: 1, text: "clave tok:ABC", keyboard: [[{ text: "tok:ABC", data: "d" }]] });
  secret = "otro";
  await out.sendLong({ chatId: 1, title: "t otro", text: "otro" });
  await out.sendLong({ chatId: 1, title: "otro", text: "otro ".repeat(5000) });
  const all = JSON.stringify([f.messages, f.documents]);
  assert.ok(!all.includes("tok:ABC") && !all.includes("otro"));
  assert.ok(all.includes("[redactado]"));
});

test("tras 429 espera retryAfter y envía una sola vez", async () => {
  const c = clock();
  const f = fake((n) => {
    if (n === 1) throw new TelegramApiError("limit", 429, 3);
  });
  await createOutbound(f.api, { secrets: () => [], now: c.now, sleep: c.sleep }).send({ chatId: 1, text: "hola" });
  assert.deepEqual(c.sleeps, [3000]);
  assert.equal(f.messages.length, 1);
});

test("un segundo 429 rechaza sin más reintentos", async () => {
  const c = clock();
  let calls = 0;
  const f = fake(() => {
    calls += 1;
    throw new TelegramApiError("limit", 429, 1);
  });
  await assert.rejects(createOutbound(f.api, { secrets: () => [], now: c.now, sleep: c.sleep }).send({ chatId: 1, text: "x" }));
  assert.equal(calls, 2);
});

test("un fallo distinto de 429 no se reintenta y no detiene la cola", async () => {
  let calls = 0;
  const f = fake((n) => {
    calls = n;
    if (n === 1) throw new TelegramApiError("forbidden", 403);
  });
  const out = createOutbound(f.api, { secrets: () => [] });
  const first = out.send({ chatId: 1, text: "a" });
  const second = out.send({ chatId: 1, text: "b" });
  await assert.rejects(first);
  await second;
  assert.equal(calls, 2);
  assert.deepEqual(f.messages.map((m) => m.text), ["b"]);
});

test("limita a 20 por minuto por grupo", async () => {
  const c = clock();
  const f = fake();
  const out = createOutbound(f.api, { secrets: () => [], now: c.now, sleep: c.sleep });
  for (let i = 0; i < 21; i++) await out.send({ chatId: 1, text: String(i) });
  assert.equal(c.sleeps.length, 1);
  assert.equal(c.sleeps[0], 60_000);
  await out.send({ chatId: 2, text: "otro grupo" });
  assert.equal(c.sleeps.length, 1);
});
