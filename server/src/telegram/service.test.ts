import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TelegramApiError, type TelegramApi, type Update } from "./api.js";
import type { ConversationDeps } from "./conversation.js";
import { createTelegramRuntime, type TelegramRuntimeDeps } from "./service.js";
import { createTelegramStore } from "./store.js";

const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const upd = (id: number): Update => ({ update_id: id });
type Step = (offset: number | undefined, signal?: AbortSignal) => Promise<Update[]>;
const abortError = () => new TelegramApiError("getUpdates: fallo de red: This operation was aborted", 0);
const waitFor = async (cond: () => boolean, what = "condición"): Promise<void> => {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no se cumplió: ${what}`);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function rig(opts: { token?: string | null; script?: Step[]; handle?: (u: Update) => Promise<void>; deps?: Partial<TelegramRuntimeDeps> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "telegram-svc-"));
  dirs.push(dir);
  const store = createTelegramStore(dir);
  if (opts.token !== null) store.writeToken(opts.token ?? "111:TOKEN");
  const script = [...(opts.script ?? [])];
  const calls: Array<{ offset: number | undefined; timeout: number }> = [];
  const apis: string[] = [];
  const handled: number[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const seen = { secrets: undefined as undefined | (() => string[]), concurrent: 0, maxConcurrent: 0 };
  const makeApi = (token: string): TelegramApi => {
    apis.push(token);
    return {
      getUpdates: async (offset, timeout, signal) => {
        calls.push({ offset, timeout });
        seen.concurrent += 1;
        seen.maxConcurrent = Math.max(seen.maxConcurrent, seen.concurrent);
        try {
          const step = script.shift();
          if (step) return await step(offset, signal);
          return await new Promise<Update[]>((_, reject) => {
            if (signal?.aborted) return reject(abortError());
            signal?.addEventListener("abort", () => reject(abortError()), { once: true });
          });
        } finally {
          seen.concurrent -= 1;
        }
      },
    } as unknown as TelegramApi;
  };
  const runtime = createTelegramRuntime({
    store,
    port: {} as never,
    launch: async () => ({ name: "x" }),
    reports: {} as never,
    createApi: makeApi,
    capabilityToken: () => null,
    repoVars: () => [],
    conversation: (deps: ConversationDeps) => {
      seen.secrets = deps.secrets;
      return {
        handle: async (update) => {
          handled.push(update.update_id);
          await opts.handle?.(update);
        },
      };
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (m) => logs.push(m),
    watchIntervalMs: 3_600_000,
    ...opts.deps,
  });
  return { store, runtime, calls, apis, handled, sleeps, logs, seen };
}

test("sin token no hace ninguna llamada", async () => {
  const r = rig({ token: null });
  const stop = r.runtime.start();
  await settle();
  assert.equal(r.calls.length, 0);
  assert.equal(r.apis.length, 0);
  assert.equal(r.runtime.getApi(), null);
  await stop();
});

test("avanza offset y lo persiste después de procesar", async () => {
  const r = rig({ script: [async () => [upd(5), upd(6)]] });
  r.store.updateState((s) => { s.offset = 3; });
  const stop = r.runtime.start();
  await waitFor(() => r.calls.length >= 2);
  assert.equal(r.calls[0].offset, 3);
  assert.equal(r.calls[0].timeout, 30);
  assert.equal(r.calls[1].offset, 7);
  assert.equal(r.store.readState().offset, 7);
  assert.deepEqual(r.handled, [5, 6]);
  await stop();
});

test("un handler que lanza no detiene el bucle ni repite el update", async () => {
  const r = rig({
    script: [async () => [upd(1)], async () => [upd(2)]],
    handle: async (u) => { if (u.update_id === 1) throw new Error("boom"); },
  });
  const stop = r.runtime.start();
  await waitFor(() => r.handled.length >= 2 && r.calls.length >= 3);
  assert.deepEqual(r.handled, [1, 2]);
  assert.deepEqual(r.calls.map((c) => c.offset), [undefined, 2, 3]);
  await stop();
});

test("despacha sin esperar al handler: el offset avanza aunque uno esté colgado", async () => {
  const r = rig({ script: [async () => [upd(1)], async () => [upd(2)]], handle: (u) => (u.update_id === 1 ? new Promise(() => {}) : Promise.resolve()) });
  const stop = r.runtime.start();
  await waitFor(() => r.handled.includes(2) && r.calls.length >= 3);
  assert.equal(r.store.readState().offset, 3);
  await stop();
});

test("tope de 4 despachos concurrentes; el resto en cola y en orden, sin frenar el offset", async () => {
  const releases: Array<() => void> = [];
  let active = 0;
  let max = 0;
  const r = rig({
    script: [async () => [1, 2, 3, 4, 5, 6].map(upd)],
    handle: async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });
  const stop = r.runtime.start();
  await waitFor(() => r.calls.length >= 2);
  assert.equal(r.store.readState().offset, 7);
  await settle();
  assert.deepEqual(r.handled, [1, 2, 3, 4]);
  releases[0]();
  await waitFor(() => r.handled.length === 5);
  assert.deepEqual(r.handled, [1, 2, 3, 4, 5]);
  releases.slice(1).forEach((release) => release());
  await waitFor(() => r.handled.length === 6);
  releases.forEach((release) => release());
  assert.equal(max, 4);
  assert.deepEqual(r.handled, [1, 2, 3, 4, 5, 6]);
  await stop();
});

test("error de red: reintenta con backoff (tope 60 s), deja lastError fijo y lo limpia al acertar", async () => {
  const fail: Step = async () => { throw new TelegramApiError("getUpdates: fallo de red: secreto-111:TOKEN", 0); };
  const r = rig({ script: [...Array(8).fill(fail), async () => []] });
  const stop = r.runtime.start();
  await waitFor(() => r.calls.length >= 9);
  assert.deepEqual(r.sleeps.slice(0, 8), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  await waitFor(() => r.calls.length >= 10);
  assert.equal(r.store.readConfig().lastError, undefined);
  await stop();
  const r2 = rig({ script: [fail] });
  const stop2 = r2.runtime.start();
  await waitFor(() => r2.store.readConfig().lastError !== undefined);
  const text = r2.store.readConfig().lastError as string;
  assert.ok(!text.includes("TOKEN") && !text.includes("secreto"));
  assert.match(text, /Telegram/);
  await stop2();
});

test("409: lastError dice que otro proceso usa este bot y espera 60 s", async () => {
  const r = rig({ script: [async () => { throw new TelegramApiError("getUpdates: Conflict", 409); }] });
  const stop = r.runtime.start();
  await waitFor(() => r.sleeps.length >= 1);
  assert.deepEqual(r.sleeps, [60_000]);
  const text = r.store.readConfig().lastError as string;
  assert.match(text, /otro proceso/i);
  assert.match(text, /Kitsune/);
  await stop();
});

test("429 espera el retryAfter indicado", async () => {
  const r = rig({ script: [async () => { throw new TelegramApiError("x", 429, 9); }] });
  const stop = r.runtime.start();
  await waitFor(() => r.sleeps.length >= 1);
  assert.deepEqual(r.sleeps, [9000]);
  await stop();
});

test("401: se detiene y pide revisar el token", async () => {
  const r = rig({ script: [async () => { throw new TelegramApiError("getUpdates: Unauthorized", 401); }, async () => [upd(1)]] });
  const stop = r.runtime.start();
  await waitFor(() => r.store.readConfig().lastError !== undefined);
  await settle();
  assert.match(r.store.readConfig().lastError as string, /token/i);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.sleeps, []);
  await stop();
});

test("stop aborta el long poll en curso y no registra ni deja error", async () => {
  const r = rig();
  const stop = r.runtime.start();
  await waitFor(() => r.calls.length === 1);
  await stop();
  await settle();
  assert.deepEqual(r.logs, []);
  assert.deepEqual(r.sleeps, []);
  assert.equal(r.store.readConfig().lastError, undefined);
  assert.equal(r.calls.length, 1);
});

test("stop resuelve aunque haya un handler colgado", async () => {
  const r = rig({ script: [async () => [upd(1)]], handle: () => new Promise(() => {}) });
  const stop = r.runtime.start();
  await waitFor(() => r.handled.length === 1);
  await stop();
});

test("al arrancar libera los reclamos que dejó un cierre brusco", async () => {
  const r = rig();
  r.store.updateState((s) => {
    s.proposals.a = { id: "a", repo: "x", instruction: "i", createdAt: 1, claimed: true };
    s.questions.q = { session: "s", questionId: "1", messageId: 1, options: [], createdAt: "t", claimed: true };
    s.proposals.b = { id: "b", repo: "x", instruction: "i", createdAt: 1 };
  });
  const stop = r.runtime.start();
  const state = r.store.readState();
  assert.equal(state.proposals.a.claimed, undefined);
  assert.equal(state.questions.q.claimed, undefined);
  assert.ok(state.proposals.b);
  await stop();
});

test("reload relee el token y nunca hay dos getUpdates a la vez", async () => {
  const r = rig();
  const stop = r.runtime.start();
  await waitFor(() => r.calls.length === 1);
  r.store.writeToken("222:NUEVO");
  r.runtime.reload();
  r.runtime.reload();
  await waitFor(() => r.calls.length === 2);
  await settle();
  assert.equal(r.calls.length, 2);
  assert.equal(r.seen.maxConcurrent, 1);
  assert.deepEqual(r.apis.slice(0, 2), ["111:TOKEN", "222:NUEVO"]);
  await stop();
  assert.equal(r.seen.concurrent, 0);
});

test("reload sin token deja de sondear", async () => {
  const r = rig();
  const stop = r.runtime.start();
  await waitFor(() => r.calls.length === 1);
  r.store.clearAll();
  r.runtime.reload();
  await settle();
  assert.equal(r.calls.length, 1);
  assert.equal(r.runtime.getApi(), null);
  await stop();
});

test("secrets reúne token, capability y vars; una fuente rota no corta las demás", async () => {
  const r = rig({ deps: { capabilityToken: () => "CAP", repoVars: () => ["VAR1", "VAR2"] } });
  const stop = r.runtime.start();
  await waitFor(() => r.seen.secrets !== undefined);
  const secrets = r.seen.secrets!();
  for (const s of ["111:TOKEN", "CAP", "VAR1", "VAR2"]) assert.ok(secrets.includes(s), s);
  await stop();

  const broken = rig({
    deps: { capabilityToken: () => { throw new Error("x"); }, repoVars: () => { throw new Error("y"); } },
  });
  const stop2 = broken.runtime.start();
  await waitFor(() => broken.seen.secrets !== undefined);
  assert.deepEqual(broken.seen.secrets!(), ["111:TOKEN"]);
  await stop2();
});

test("onUpdate que maneja el update evita la conversación", async () => {
  const taken: number[] = [];
  const r = rig({
    script: [async () => [upd(1), upd(2)]],
    deps: { onUpdate: async (u) => { taken.push(u.update_id); return u.update_id === 1; } },
  });
  const stop = r.runtime.start();
  await waitFor(() => r.handled.length === 1 && taken.length === 2);
  assert.deepEqual(r.handled, [2]);
  await stop();
});

test("expone store y getApi mientras hay token", async () => {
  const r = rig();
  const stop = r.runtime.start();
  assert.ok(r.runtime.store);
  assert.ok(r.runtime.getApi());
  await stop();
});
