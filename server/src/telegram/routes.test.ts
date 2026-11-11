import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import express from "express";
import { ensureCapabilityToken } from "../capability.js";
import { createApp } from "../index.js";
import { TelegramApiError, type TelegramApi } from "./api.js";
import { createTelegramRouter, LAST_ERROR_TEXT } from "./routes.js";
import type { TelegramRuntime } from "./service.js";
import { createTelegramStore } from "./store.js";

const dirs: string[] = [];
const closers: Array<() => void> = [];
after(() => {
  for (const close of closers) close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "123456:SECRET-token_value";
const NEW_TOKEN = "654321:NEW-secret_value";

interface Calls { getMe: number; getChat: number; getChatMember: number; created: string[]; tokens: string[] }

async function listening(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  closers.push(() => server.close());
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/telegram`;
}

function rig(opts: { token?: string | null; repos?: string[]; api?: Partial<TelegramApi> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "telegram-routes-"));
  dirs.push(dir);
  const store = createTelegramStore(dir);
  if (opts.token !== null) store.writeToken(opts.token ?? TOKEN);
  const calls: Calls = { getMe: 0, getChat: 0, getChatMember: 0, created: [], tokens: [] };
  let nextThread = 100;
  const behavior = {
    chat: { id: -100, type: "supergroup", title: "Ronin", is_forum: true } as { id: number; type: string; title?: string; is_forum?: boolean },
    member: { status: "administrator", user: { id: 1 }, can_manage_topics: true } as { status: string; user: { id: number }; can_manage_topics?: boolean },
    failTopic: new Set<string>(),
  };
  const makeApi = (token: string): TelegramApi => {
    calls.tokens.push(token);
    return {
      getMe: async () => { calls.getMe += 1; return { id: 1, username: "ronin_bot" }; },
      getChat: async () => { calls.getChat += 1; return behavior.chat; },
      getChatMember: async () => { calls.getChatMember += 1; return behavior.member; },
      createForumTopic: async (_chat: number, name: string) => {
        if (behavior.failTopic.has(name)) throw new TelegramApiError("createForumTopic: boom " + TOKEN, 400);
        calls.created.push(name);
        nextThread += 1;
        return { message_thread_id: nextThread, name };
      },
      ...opts.api,
    } as unknown as TelegramApi;
  };
  let reloads = 0;
  const runtime = {
    store,
    getApi: () => (store.readToken() ? makeApi(store.readToken()!) : null),
    reload: () => { reloads += 1; },
    start: () => async () => {},
  } as TelegramRuntime;
  let clock = 1_000_000;
  const router = createTelegramRouter({
    runtime,
    listRepos: () => opts.repos ?? ["repoA", "repoB", "repoC"],
    createApi: makeApi,
    now: () => clock,
  });
  const app = express();
  app.use(express.json());
  app.use("/api/telegram", router);
  const baseUrl = listening(app);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch((await baseUrl) + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : undefined };
  };
  return { store, calls, behavior, call, reloads: () => reloads, advance: (ms: number) => { clock += ms; } };
}

const ready = { botUsername: "ronin_bot", userId: 7, chatId: -100 };

test("GET /status recorre los pasos según el estado", async () => {
  const r = rig({ token: null });
  assert.equal((await r.call("GET", "/status")).body.step, 1);
  assert.equal((await r.call("GET", "/status")).body.connected, false);
  r.store.writeToken(TOKEN);
  r.store.updateConfig({ botUsername: "ronin_bot" });
  let status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, 2);
  assert.equal(status.userLinked, false);
  assert.equal(status.connected, true);
  r.store.updateConfig({ userId: 7 });
  assert.equal((await r.call("GET", "/status")).body.step, 3);
  r.store.updateConfig({ chatId: -100 });
  r.advance(60_000);
  status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, 4);
  assert.deepEqual(status.group, { title: "Ronin", isForum: true, botIsAdmin: true, canManageTopics: true });
  assert.deepEqual(status.repos, [
    { repo: "repoA", hasTopic: false },
    { repo: "repoB", hasTopic: false },
    { repo: "repoC", hasTopic: false },
  ]);
  r.store.updateConfig({ topics: { repoA: 5 }, activatedAt: "2026-11-06T00:00:00Z" });
  status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, "done");
  assert.equal(status.repos[0].hasTopic, true);
});

test("el estado refleja Temas apagados y permisos faltantes: el paso 3 no avanza", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  r.behavior.chat.is_forum = false;
  let status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, 3);
  assert.equal(status.group.isForum, false);
  r.behavior.chat.is_forum = true;
  r.behavior.member = { status: "member", user: { id: 1 } };
  r.advance(11_000);
  status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, 3);
  assert.equal(status.group.botIsAdmin, false);
  r.behavior.member = { status: "administrator", user: { id: 1 }, can_manage_topics: false };
  r.advance(11_000);
  status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, 3);
  assert.deepEqual([status.group.botIsAdmin, status.group.canManageTopics], [true, false]);
  r.behavior.member = { status: "creator", user: { id: 1 } };
  r.advance(11_000);
  assert.equal((await r.call("GET", "/status")).body.step, 4);
});

test("GET /status cachea 10 s las consultas a Telegram", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  await r.call("GET", "/status");
  await r.call("GET", "/status");
  r.advance(5_000);
  await r.call("GET", "/status");
  assert.equal(r.calls.getChat, 1);
  assert.equal(r.calls.getChatMember, 1);
  r.advance(6_000);
  await r.call("GET", "/status");
  assert.equal(r.calls.getChat, 2);
});

const activated = { ...ready, topics: { repoA: 5 }, activatedAt: "2026-11-06T00:00:00Z" };

test("configurado y sin consulta exitosa (la Mac despertó sin red): sigue en done y muestra lastError", async () => {
  let down = true;
  const r = rig({ api: { getChat: async () => { if (down) throw new TelegramApiError("getChat: red", 0); return { id: -100, type: "supergroup", title: "Ronin", is_forum: true }; } } });
  r.store.updateConfig(activated);
  let status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, "done");
  assert.equal(status.lastError, LAST_ERROR_TEXT.group);
  assert.equal(status.group, undefined);
  down = false;
  r.advance(11_000);
  status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, "done");
  assert.equal(status.lastError, undefined);
  assert.equal(status.group.isForum, true);
});

test("configurado: solo una consulta exitosa con el grupo mal regresa al paso 3", async () => {
  const bad: Array<(r: ReturnType<typeof rig>) => void> = [
    (r) => { r.behavior.chat.is_forum = false; },
    (r) => { r.behavior.member = { status: "member", user: { id: 1 } }; },
    (r) => { r.behavior.member = { status: "administrator", user: { id: 1 }, can_manage_topics: false }; },
  ];
  for (const breakGroup of bad) {
    const r = rig();
    r.store.updateConfig(activated);
    assert.equal((await r.call("GET", "/status")).body.step, "done");
    breakGroup(r);
    r.advance(11_000);
    assert.equal((await r.call("GET", "/status")).body.step, 3);
  }
});

test("configurado: una consulta que falla tras ver el grupo mal conserva el paso 3 con lo último conocido", async () => {
  let down = false;
  const r = rig({ api: { getChat: async () => { if (down) throw new TelegramApiError("getChat: red", 0); return { id: -100, type: "supergroup", title: "Ronin", is_forum: false }; } } });
  r.store.updateConfig(activated);
  assert.equal((await r.call("GET", "/status")).body.step, 3);
  down = true;
  r.advance(11_000);
  const status = (await r.call("GET", "/status")).body;
  assert.equal(status.step, 3);
  assert.equal(status.lastError, LAST_ERROR_TEXT.group);
});

test("un fallo de Telegram devuelve lo último conocido con lastError, nunca un 500", async () => {
  let fail = true;
  const failing = rig({
    api: { getChat: async () => { if (fail) throw new TelegramApiError("getChat: x " + TOKEN, 0); return { id: -100, type: "supergroup", title: "Ronin", is_forum: true }; } },
  });
  failing.store.updateConfig(ready);
  let response = await failing.call("GET", "/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.lastError, LAST_ERROR_TEXT.group);
  assert.equal(response.body.step, 3, "sin activar: el wizard aún no terminó");
  assert.equal(response.text.includes(TOKEN), false);
  fail = false;
  failing.advance(11_000);
  response = await failing.call("GET", "/status");
  assert.equal(response.body.lastError, undefined);
  assert.equal(response.body.group.isForum, true);
  fail = true;
  failing.advance(11_000);
  response = await failing.call("GET", "/status");
  assert.equal(response.status, 200);
  assert.equal(response.body.group.isForum, true, "conserva el último dato conocido");
  assert.equal(response.body.lastError, LAST_ERROR_TEXT.group);
});

test("connected es falso si el último sondeo falló, y su error se expone", async () => {
  const r = rig();
  r.store.updateConfig({ botUsername: "ronin_bot", lastError: "No pude conectar con Telegram; reintentando." });
  const status = (await r.call("GET", "/status")).body;
  assert.equal(status.connected, false);
  assert.equal(status.lastError, "No pude conectar con Telegram; reintentando.");
});

test("GET /status nunca contiene token ni código", async () => {
  const r = rig();
  r.store.updateConfig({ ...ready, pairingCode: "PAIR-CODE-XYZ", pairingExpiresAt: 9e12, groupCode: "GROUP-CODE-XYZ", groupExpiresAt: 9e12, topics: { repoA: 5 } });
  const { text } = await r.call("GET", "/status");
  for (const secret of [TOKEN, "SECRET-token_value", "PAIR-CODE-XYZ", "GROUP-CODE-XYZ"]) assert.equal(text.includes(secret), false, secret);
});

test("POST /pairing: 409 sin bot; con bot devuelve enlace y guarda código con vigencia de 30 min", async () => {
  const none = rig({ token: null });
  assert.equal((await none.call("POST", "/pairing")).status, 409);
  const noBotName = rig();
  assert.equal((await noBotName.call("POST", "/pairing")).status, 409);

  const r = rig();
  r.store.updateConfig({ botUsername: "ronin_bot" });
  const response = await r.call("POST", "/pairing");
  assert.equal(response.status, 200);
  const config = r.store.readConfig();
  assert.match(config.pairingCode!, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(response.body.link, `https://t.me/ronin_bot?start=${config.pairingCode}`);
  assert.equal(config.pairingExpiresAt, 1_000_000 + 30 * 60_000);
  const second = await r.call("POST", "/pairing");
  assert.notEqual(second.body.link, response.body.link, "cada solicitud genera un código nuevo");
});

test("POST /pairing con usuario ya vinculado → 409 sin cambiar nada; tras DELETE / se puede", async () => {
  const r = rig();
  r.store.updateConfig({ botUsername: "ronin_bot", userId: 7 });
  const response = await r.call("POST", "/pairing");
  assert.equal(response.status, 409);
  assert.equal(r.store.readConfig().pairingCode, undefined);
  await r.call("DELETE", "/");
  r.store.writeToken(TOKEN);
  r.store.updateConfig({ botUsername: "ronin_bot" });
  assert.equal((await r.call("POST", "/pairing")).status, 200);
});

test("POST /group-link: 409 sin usuario vinculado; con usuario devuelve enlace de grupo", async () => {
  const r = rig();
  r.store.updateConfig({ botUsername: "ronin_bot" });
  assert.equal((await r.call("POST", "/group-link")).status, 409);
  assert.equal(r.store.readConfig().groupCode, undefined);
  r.store.updateConfig({ userId: 7 });
  const response = await r.call("POST", "/group-link");
  assert.equal(response.status, 200);
  const config = r.store.readConfig();
  assert.equal(response.body.link, `https://t.me/ronin_bot?startgroup=${config.groupCode}&admin=manage_topics`);
  assert.equal(config.groupExpiresAt, 1_000_000 + 30 * 60_000);
});

test("PUT /token inválido no guarda nada y no devuelve el token", async () => {
  const r = rig({ api: { getMe: async () => { throw new TelegramApiError("getMe: Unauthorized " + NEW_TOKEN, 401); } } });
  r.store.updateConfig({ ...ready, topics: { repoA: 5 } });
  const response = await r.call("PUT", "/token", { token: NEW_TOKEN });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Token inválido");
  assert.equal(response.text.includes(NEW_TOKEN), false);
  assert.equal(r.store.readToken(), TOKEN);
  assert.equal(r.store.readConfig().userId, 7);
  assert.equal(r.reloads(), 0);
});

test("PUT /token con falla de red da un error distinto de 'token inválido'", async () => {
  const r = rig({ api: { getMe: async () => { throw new TelegramApiError("getMe: fallo de red: " + NEW_TOKEN, 0); } } });
  const response = await r.call("PUT", "/token", { token: NEW_TOKEN });
  assert.equal(response.status, 502);
  assert.equal(response.body.error, LAST_ERROR_TEXT.network);
  assert.notEqual(response.body.error, "Token inválido");
  assert.equal(response.text.includes(NEW_TOKEN), false);
  assert.equal(r.store.readToken(), TOKEN);
});

test("PUT /token con forma inválida → 400 sin llamar a Telegram", async () => {
  const r = rig();
  for (const body of [{}, { token: 5 }, { token: "" }, { token: "no es un token" }, { token: "1:" + "a".repeat(500) }]) {
    assert.equal((await r.call("PUT", "/token", body)).status, 400);
  }
  assert.equal(r.calls.getMe, 0);
});

test("PUT /token válido valida con el candidato, guarda, limpia vinculación y estado y recarga", async () => {
  const r = rig();
  r.store.updateConfig({
    ...ready, topics: { repoA: 5 }, disabledTopics: { repoB: 6 }, activatedAt: "x",
    pairingCode: "p", pairingExpiresAt: 1, groupCode: "g", groupExpiresAt: 1, lastError: "e",
  });
  r.store.updateState((s) => { s.offset = 99; s.sessions.s = { session: "s", repo: "repoA" }; });
  const response = await r.call("PUT", "/token", { token: ` ${NEW_TOKEN} ` });
  assert.equal(response.status, 200);
  assert.equal(response.text.includes(NEW_TOKEN), false);
  assert.ok(r.calls.tokens.includes(NEW_TOKEN), "getMe se hizo con el token candidato");
  assert.equal(r.store.readToken(), NEW_TOKEN);
  assert.deepEqual(r.store.readConfig(), { botUsername: "ronin_bot", topics: {} });
  const state = r.store.readState();
  assert.equal(state.offset, undefined);
  assert.deepEqual(state.sessions, {});
  assert.equal(r.reloads(), 1);
});

test("PUT /repos: repo desconocido → 400 sin crear nada", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  const response = await r.call("PUT", "/repos", { repos: ["repoA", "ajeno"] });
  assert.equal(response.status, 400);
  assert.deepEqual(r.calls.created, []);
  assert.deepEqual(r.store.readConfig().topics, {});
  assert.equal((await r.call("PUT", "/repos", { repos: "repoA" })).status, 400);
});

test("PUT /repos sin grupo vinculado → 409", async () => {
  const r = rig();
  r.store.updateConfig({ botUsername: "ronin_bot", userId: 7 });
  assert.equal((await r.call("PUT", "/repos", { repos: ["repoA"] })).status, 409);
});

test("PUT /repos crea temas una sola vez, fija activatedAt y es idempotente", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  const first = await r.call("PUT", "/repos", { repos: ["repoA", "repoB", "repoA"] });
  assert.equal(first.status, 200);
  assert.deepEqual(r.calls.created, ["repoA", "repoB"]);
  const config = r.store.readConfig();
  assert.deepEqual(Object.keys(config.topics).sort(), ["repoA", "repoB"]);
  assert.ok(config.activatedAt);
  const stamp = config.activatedAt;
  r.advance(5_000);
  const again = await r.call("PUT", "/repos", { repos: ["repoA", "repoB"] });
  assert.equal(again.status, 200);
  assert.deepEqual(r.calls.created, ["repoA", "repoB"]);
  assert.equal(r.store.readConfig().activatedAt, stamp);
  assert.deepEqual(again.body.repos.filter((x: { hasTopic: boolean }) => x.hasTopic).map((x: { repo: string }) => x.repo), ["repoA", "repoB"]);
});

test("PUT /repos: llamadas simultáneas no duplican temas", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  await Promise.all([r.call("PUT", "/repos", { repos: ["repoA"] }), r.call("PUT", "/repos", { repos: ["repoA"] })]);
  assert.deepEqual(r.calls.created, ["repoA"]);
});

test("deseleccionar mueve el tema a disabledTopics y volver a elegirlo lo restaura sin duplicar", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  await r.call("PUT", "/repos", { repos: ["repoA", "repoB"] });
  const threadA = r.store.readConfig().topics.repoA;
  await r.call("PUT", "/repos", { repos: ["repoB"] });
  let config = r.store.readConfig();
  assert.equal(config.topics.repoA, undefined);
  assert.deepEqual(config.disabledTopics, { repoA: threadA });
  const status = (await r.call("GET", "/status")).body;
  assert.equal(status.repos.find((x: { repo: string }) => x.repo === "repoA").hasTopic, false);
  await r.call("PUT", "/repos", { repos: ["repoA", "repoB"] });
  config = r.store.readConfig();
  assert.equal(config.topics.repoA, threadA);
  assert.deepEqual(config.disabledTopics ?? {}, {});
  assert.deepEqual(r.calls.created, ["repoA", "repoB"]);
});

test("PUT /repos con fallo parcial conserva lo creado, informa los fallidos con 502 y sin error crudo", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  r.behavior.failTopic.add("repoB");
  const response = await r.call("PUT", "/repos", { repos: ["repoA", "repoB", "repoC"] });
  assert.equal(response.status, 502);
  assert.deepEqual(response.body.failed, ["repoB"]);
  assert.equal(response.text.includes(TOKEN), false);
  assert.equal(response.text.includes("boom"), false);
  const config = r.store.readConfig();
  assert.deepEqual(Object.keys(config.topics).sort(), ["repoA", "repoC"]);
  assert.ok(config.activatedAt);
});

test("PUT /repos sin ningún tema creado no fija activatedAt", async () => {
  const r = rig();
  r.store.updateConfig(ready);
  r.behavior.failTopic.add("repoA");
  const response = await r.call("PUT", "/repos", { repos: ["repoA"] });
  assert.equal(response.status, 502);
  assert.equal(r.store.readConfig().activatedAt, undefined);
});

function pendingTopics() {
  const started: string[] = [];
  let release!: (id: number) => void;
  const gate = new Promise<number>((resolve) => { release = resolve; });
  const api = {
    createForumTopic: async (_chat: number, name: string) => {
      started.push(name);
      const id = await gate;
      return { message_thread_id: id, name };
    },
  };
  return { api, started, release };
}
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5)); };

test("DELETE / durante un createForumTopic pendiente: el PUT /repos no reescribe nada y responde 409", async () => {
  const pending = pendingTopics();
  const r = rig({ api: pending.api });
  r.store.updateConfig(ready);
  const put = r.call("PUT", "/repos", { repos: ["repoA", "repoB"] });
  await until(() => pending.started.length > 0);
  await r.call("DELETE", "/");
  pending.release(5);
  const response = await put;
  assert.equal(response.status, 409);
  assert.deepEqual(r.store.readConfig(), { topics: {} });
  assert.deepEqual(pending.started, ["repoA"], "no sigue creando temas con el API anterior");
});

test("re-vincular otro grupo durante un createForumTopic pendiente: los hilos viejos no entran al grupo nuevo", async () => {
  const pending = pendingTopics();
  const r = rig({ api: pending.api });
  r.store.updateConfig(ready);
  const put = r.call("PUT", "/repos", { repos: ["repoA", "repoB"] });
  await until(() => pending.started.length > 0);
  r.store.updateConfig({ chatId: -999, topics: {}, disabledTopics: undefined, activatedAt: undefined });
  pending.release(5);
  const response = await put;
  assert.equal(response.status, 409);
  const config = r.store.readConfig();
  assert.equal(config.chatId, -999);
  assert.deepEqual(config.topics, {});
  assert.equal(config.activatedAt, undefined);
  assert.deepEqual(pending.started, ["repoA"]);
});

test("PUT /token durante un createForumTopic pendiente tampoco recibe el hilo del bot anterior", async () => {
  const pending = pendingTopics();
  const r = rig({ api: pending.api });
  r.store.updateConfig(ready);
  const put = r.call("PUT", "/repos", { repos: ["repoA"] });
  await until(() => pending.started.length > 0);
  assert.equal((await r.call("PUT", "/token", { token: NEW_TOKEN })).status, 200);
  pending.release(5);
  assert.equal((await put).status, 409);
  const config = r.store.readConfig();
  assert.deepEqual(config.topics, {});
  assert.equal(config.activatedAt, undefined);
});

test("DELETE / borra token, configuración y estado, y recarga", async () => {
  const r = rig();
  r.store.updateConfig({ ...ready, topics: { repoA: 5 } });
  r.store.updateState((s) => { s.offset = 4; });
  const response = await r.call("DELETE", "/");
  assert.equal(response.status, 200);
  assert.equal(r.store.readToken(), null);
  assert.deepEqual(r.store.readConfig(), { topics: {} });
  assert.equal(r.store.readState().offset, undefined);
  assert.equal(r.reloads(), 1);
});

test("un error interno no filtra el mensaje crudo", async () => {
  const r = rig();
  r.store.updateConfig({ botUsername: "ronin_bot" });
  r.store.updateConfig = () => { throw new Error("/ruta/secreta " + TOKEN); };
  const response = await r.call("POST", "/pairing");
  assert.equal(response.status, 500);
  assert.equal(response.text.includes("secreta"), false);
  assert.equal(response.text.includes(TOKEN), false);
});

test("las rutas de escritura exigen capability; GET /status no", async () => {
  const token = ensureCapabilityToken();
  const dir = mkdtempSync(join(tmpdir(), "telegram-cap-"));
  dirs.push(dir);
  const store = createTelegramStore(dir);
  const runtime = { store, getApi: () => null, reload: () => {}, start: () => async () => {} } as TelegramRuntime;
  const app = createApp({ telegram: runtime });
  const base = await listening(app);
  const writes: Array<[string, string]> = [["PUT", "/token"], ["POST", "/pairing"], ["POST", "/group-link"], ["PUT", "/repos"], ["DELETE", "/"]];
  for (const [method, path] of writes) {
    for (const headers of [{}, { "x-ronin-capability": "wrong" }] as Array<Record<string, string>>) {
      const response = await fetch(base + path, { method, headers: { ...headers, "content-type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  }
  const ok = await fetch(base + "/status");
  assert.equal(ok.status, 200);
  const withCap = await fetch(base + "/pairing", { method: "POST", headers: { "x-ronin-capability": token } });
  assert.notEqual(withCap.status, 401);
});
