import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTelegramStore } from "./store.js";

function withStore(fn: (dir: string, store: ReturnType<typeof createTelegramStore>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ronin-telegram-"));
  try {
    fn(dir, createTelegramStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("el token se escribe con modo 0600 y fuera de telegram.json", () =>
  withStore((dir, store) => {
    assert.equal(store.readToken(), null);
    store.writeToken("123:SECRET");
    store.updateConfig({ botUsername: "bot" });
    assert.equal(statSync(join(dir, "telegram-token")).mode & 0o777, 0o600);
    assert.equal(store.readToken(), "123:SECRET");
    assert.ok(!readFileSync(join(dir, "telegram.json"), "utf8").includes("SECRET"));
    store.writeToken("456:OTHER");
    assert.equal(statSync(join(dir, "telegram-token")).mode & 0o777, 0o600);
  }));

test("readConfig de un archivo corrupto devuelve config vacía", () =>
  withStore((dir, store) => {
    writeFileSync(join(dir, "telegram.json"), "{no json");
    assert.deepEqual(store.readConfig(), { topics: {} });
    writeFileSync(join(dir, "telegram-state.json"), "[]");
    assert.deepEqual(store.readState(), { proposals: {}, drafts: {}, questions: {}, sessions: {}, summaries: {} });
  }));

test("migrateChat cambia chatId y conserva topics", () =>
  withStore((_dir, store) => {
    store.updateConfig({ chatId: -100, topics: { repo: 7 }, userId: 4 });
    store.migrateChat(-100, -200);
    assert.deepEqual(store.readConfig(), { chatId: -200, topics: { repo: 7 }, userId: 4 });
    store.migrateChat(-999, -300); // otro chat: no toca nada
    assert.equal(store.readConfig().chatId, -200);
  }));

test("updateState persiste mutando o devolviendo, y clearAll lo borra todo", () =>
  withStore((dir, store) => {
    store.writeToken("1:T");
    store.updateState((s) => {
      s.offset = 9;
    });
    store.updateState((s) => ({ ...s, questions: { q: { session: "s", questionId: "q", messageId: 1, options: ["a"], createdAt: "t" } } }));
    const state = store.readState();
    assert.equal(state.offset, 9);
    assert.equal(state.questions.q.messageId, 1);
    store.clearAll();
    for (const f of ["telegram-token", "telegram.json", "telegram-state.json"]) assert.equal(existsSync(join(dir, f)), false);
  }));
