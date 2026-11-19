import assert from "node:assert/strict";
import test from "node:test";
import type { Incident } from "./incident.js";
import { createMainHealthNotifier } from "./notify.js";

const SHA = "a".repeat(40);

function incident(closed = false): Incident {
  return {
    id: `ant-ms-i18n@${SHA.slice(0, 7)}`,
    repo: "ant-ms-i18n",
    firstRedSha: SHA,
    openedAt: 1_000,
    ...(closed ? { closedAt: 2_000 } : {}),
    summary: "salida cruda SECRETO-QUE-NO-DEBE-SALIR",
    attribution: {
      status: "no_prior_green",
      reason: "sin medición verde previa",
      redSha: SHA,
      greenSha: null,
      commits: [],
      culpritShas: [],
      newRed: [],
      unattributedRed: [],
    },
  };
}

test("notifica apertura y cierre en español al tema configurado sin copiar logs", async () => {
  const sent: Array<{ chatId: number; threadId?: number; text: string }> = [];
  const notifier = createMainHealthNotifier({
    store: {
      readToken: () => "123:TOKEN-SECRETO",
      readConfig: () => ({ chatId: -100, topics: { "ant-ms-i18n": 42 } }),
    },
    runtime: {
      getApi: () => ({
        sendMessage: async (message) => {
          sent.push(message);
          return {};
        },
      }),
    },
  });

  await notifier.opened(incident());
  await notifier.closed(incident(true));

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(({ chatId, threadId }) => ({ chatId, threadId })), [
    { chatId: -100, threadId: 42 },
    { chatId: -100, threadId: 42 },
  ]);
  assert.match(sent[0]!.text, /Incidente abierto/);
  assert.match(sent[0]!.text, /ant-ms-i18n/);
  assert.match(sent[0]!.text, new RegExp(SHA.slice(0, 7)));
  assert.match(sent[1]!.text, /Incidente cerrado/);
  assert.doesNotMatch(sent.map(({ text }) => text).join("\n"), /SECRETO|TOKEN-SECRETO|salida cruda/);
});

test("sin token, API o chat configurado es no-op", async () => {
  let calls = 0;
  const make = (token: string | null, chatId: number | undefined, withApi: boolean) =>
    createMainHealthNotifier({
      store: {
        readToken: () => token,
        readConfig: () => ({ ...(chatId === undefined ? {} : { chatId }), topics: {} }),
      },
      runtime: {
        getApi: () => withApi ? {
          sendMessage: async () => {
            calls += 1;
            return {};
          },
        } : null,
      },
    });

  await make(null, -100, true).opened(incident());
  await make("token", undefined, true).opened(incident());
  await make("token", -100, false).opened(incident());
  assert.equal(calls, 0);
});

test("un repo con tema desactivado no notifica ni cae al chat raíz", async () => {
  let calls = 0;
  const notifier = createMainHealthNotifier({
    store: {
      readToken: () => "token",
      readConfig: () => ({
        chatId: -100,
        topics: { "ant-ms-i18n": 42 },
        disabledTopics: { "ant-ms-i18n": 42 },
      }),
    },
    runtime: {
      getApi: () => ({ sendMessage: async () => { calls += 1; } }),
    },
  });

  await notifier.opened(incident());
  assert.equal(calls, 0);
});

test("tema ausente o inválido conserva el fallback al chat raíz", async () => {
  const sent: Array<{ chatId: number; threadId?: number; text: string }> = [];
  for (const topic of [undefined, 0, -1, 1.5, Number.NaN]) {
    const notifier = createMainHealthNotifier({
      store: {
        readToken: () => "token",
        readConfig: () => ({
          chatId: -100,
          topics: topic === undefined ? {} : { "ant-ms-i18n": topic },
        }),
      },
      runtime: {
        getApi: () => ({ sendMessage: async (message) => { sent.push(message); } }),
      },
    });
    await notifier.opened(incident());
  }

  assert.equal(sent.length, 5);
  assert.ok(sent.every((message) => message.threadId === undefined));
});

test("propaga AbortSignal y un envío ya abortado es no-op", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const notifier = createMainHealthNotifier({
    store: {
      readToken: () => "token",
      readConfig: () => ({ chatId: -100, topics: {} }),
    },
    runtime: {
      getApi: () => ({
        sendMessage: async (message) => { signals.push(message.signal); },
      }),
    },
  });
  const active = new AbortController();
  const aborted = new AbortController();
  aborted.abort();

  await notifier.opened(incident(), active.signal);
  await notifier.closed(incident(true), aborted.signal);

  assert.deepEqual(signals, [active.signal]);
});
