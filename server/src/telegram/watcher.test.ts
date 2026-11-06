import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { McpSessionStatus } from "../mcp-sessions.js";
import type { SendMessageParams } from "./api.js";
import { createTelegramStore, type TelegramConfig, type TelegramStore } from "./store.js";
import { createWatcher, isFollowed, isSessionFollowed } from "./watcher.js";

const ACTIVATED = "2026-01-01T00:00:00.000Z";
const AFTER = Date.parse(ACTIVATED) + 1000;
const CONFIG: TelegramConfig = { chatId: -100, topics: { alpha: 7, beta: 8 }, activatedAt: ACTIVATED };
const record = (over: Record<string, unknown> = {}) => ({ mode: "workflow", channel: "telegram", repo: "alpha", createdAt: AFTER, ...over });

function status(over: Partial<McpSessionStatus> = {}): McpSessionStatus {
  return { name: "cowork-a", workflow: "w", stage: "s", stagesDone: 0, stagesTotal: 3, attention: "working", needsInput: false, gate: null, ...over };
}
const asking = (over: Partial<McpSessionStatus> = {}) =>
  status({ attention: "decision", needsInput: true, questionId: "q1", question: "¿Sigo?", ...over });

function setup(opts: { dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "watcher-"));
  const store: TelegramStore = createTelegramStore(dir);
  if (!opts.dir) store.updateConfig(CONFIG);
  const sent: SendMessageParams[] = [];
  const longs: Array<{ chatId: number; threadId?: number; title: string; text: string }> = [];
  let nextId = 100;
  const h = {
    dir, store, sent, longs,
    statuses: [] as McpSessionStatus[],
    statusError: false,
    sendError: 0,
    records: { "cowork-a": record(), "cowork-b": record({ repo: "beta" }) } as Record<string, unknown>,
    summary: true,
  };
  const outbound = {
    async send(msg: SendMessageParams) {
      if (h.sendError > 0) { h.sendError -= 1; throw new Error("red"); }
      sent.push(msg);
      return { message_id: nextId++, chat: { id: msg.chatId, type: "supergroup" } };
    },
    async sendLong(msg: { chatId: number; threadId?: number; title: string; text: string }) { longs.push(msg); },
  };
  const watcher = createWatcher({
    store, outbound,
    port: { status: async () => { if (h.statusError) throw new Error("boom"); return h.statuses; } },
    readRecord: (name) => h.records[name] ?? null,
    hasSummary: () => h.summary,
    now: () => AFTER + 5000,
    log: () => {},
  });
  return { h, watcher, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("sigue telegram y ui; no sigue MCP, terminal, sin tema ni anteriores a activatedAt", () => {
  const cases: Array<[string, unknown, boolean]> = [
    ["telegram", record(), true],
    ["ui", record({ channel: "ui" }), true],
    ["mcp", record({ channel: "mcp" }), false],
    ["sin canal", record({ channel: undefined }), false],
    ["terminal", record({ mode: "terminal" }), false],
    ["repo sin tema", record({ repo: "otro" }), false],
    ["repo heredado", record({ repo: "constructor" }), false],
    ["anterior a activatedAt", record({ createdAt: AFTER - 5000 }), false],
    ["createdAt texto", record({ createdAt: "x" }), false],
    ["createdAt NaN", record({ createdAt: NaN }), false],
    ["repo no texto", record({ repo: 3 }), false],
    ["null", null, false],
    ["arreglo", [], false],
    ["texto", "x", false],
  ];
  for (const [label, rec, expected] of cases) assert.equal(isFollowed(rec, CONFIG), expected, label);
  assert.equal(isFollowed(record(), { topics: { alpha: 7 } }), false, "sin activatedAt");
  assert.equal(isFollowed(record(), { ...CONFIG, activatedAt: "basura" }), false, "activatedAt inválido");
  assert.equal(isSessionFollowed("x", CONFIG, () => record()), true);
  assert.equal(isSessionFollowed("x", CONFIG, () => null), false);
  assert.equal(isSessionFollowed("x", CONFIG, () => { throw new Error("e"); }), false);
});

test("una pregunta se envía en el tema del repo y una sola vez por identidad", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking()];
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].chatId, -100);
  assert.equal(h.sent[0].threadId, 7);
  assert.match(h.sent[0].text, /cowork-a/);
  assert.match(h.sent[0].text, /¿Sigo\?/);
  const [key, q] = Object.entries(h.store.readState().questions)[0];
  assert.ok(!key.includes(":"));
  assert.equal(q.messageId, 100);
  assert.equal(q.questionId, "q1");
  assert.equal(q.session, "cowork-a");
  cleanup();
});

test("la misma pregunta que reaparece tras dejar de esperar crea una SentQuestion nueva", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking()];
  await watcher.tick();
  const [firstKey] = Object.keys(h.store.readState().questions);
  h.store.updateState((s) => { s.questions[firstKey].claimed = true; });
  h.statuses = [status()];
  await watcher.tick();
  h.statuses = [asking()];
  await watcher.tick();
  const questions = h.store.readState().questions;
  assert.equal(h.sent.length, 2);
  assert.equal(Object.keys(questions).length, 2);
  assert.equal(questions[firstKey].claimed, true, "no se toca la entrada vieja");
  cleanup();
});

test("sin questionId no se envía nada", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking({ questionId: undefined })];
  await watcher.tick();
  assert.equal(h.sent.length, 0);
  cleanup();
});

test("espera dos ticks seguidos antes de enviar una pregunta idle", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking({ attention: "idle" })];
  await watcher.tick();
  assert.equal(h.sent.length, 0);
  h.statuses = [status()];
  await watcher.tick();
  h.statuses = [asking({ attention: "idle" })];
  await watcher.tick();
  assert.equal(h.sent.length, 0, "el hueco reinicia la cuenta");
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  cleanup();
});

test("un menú decision se envía de inmediato con un botón por opción", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking({ options: ["Sí", "No", "Tal vez"] })];
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  const [key] = Object.keys(h.store.readState().questions);
  const kb = h.sent[0].keyboard!.flat();
  assert.deepEqual(kb.map((b) => b.data), [`q:${key}:1`, `q:${key}:2`, `q:${key}:3`]);
  assert.deepEqual(h.store.readState().questions[key].options, ["Sí", "No", "Tal vez"]);
  cleanup();
});

test("una pregunta nueva de la misma sesión se envía", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking()];
  await watcher.tick();
  h.statuses = [asking({ questionId: "q2", question: "¿Y ahora?" })];
  await watcher.tick();
  assert.equal(h.sent.length, 2);
  cleanup();
});

test("una pregunta larga va por sendLong y el mensaje de botones es el destino de Responder", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking({ question: "x".repeat(5000), options: ["Sí", "No"] })];
  await watcher.tick();
  assert.equal(h.longs.length, 1);
  assert.equal(h.longs[0].threadId, 7);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /^❓ cowork-a pregunta/);
  assert.ok(h.sent[0].keyboard);
  const q = Object.values(h.store.readState().questions)[0];
  assert.equal(q.messageId, 100);
  cleanup();
});

test("aviso único al terminar, con botón de resumen", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [status({ stagesDone: 3, stagesTotal: 3 })];
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  const button = h.sent[0].keyboard!.flat()[0];
  assert.match(button.data, /^r:/);
  assert.equal(Object.values(h.store.readState().summaries)[0].session, "cowork-a");
  cleanup();
});

test("sin resumen no hay botón; stagesTotal 0 no cuenta como terminado", async () => {
  const { h, watcher, cleanup } = setup();
  h.summary = false;
  h.statuses = [status({ stagesDone: 0, stagesTotal: 0 })];
  await watcher.tick();
  assert.equal(h.sent.length, 0);
  h.statuses = [status({ stagesDone: 3, stagesTotal: 3 })];
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].keyboard, undefined);
  cleanup();
});

test("aviso único por gate fallido", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [status({ gate: { stage: "tests", state: "failed", attempts: 1 } })];
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /tests/);
  h.statuses = [status({ gate: { stage: "tests", state: "running", attempts: 2 } })];
  await watcher.tick();
  h.statuses = [status({ gate: { stage: "tests", state: "failed", attempts: 2 } })];
  await watcher.tick();
  assert.equal(h.sent.length, 2);
  cleanup();
});

test("sesión gone o desaparecida: aviso único y se poda", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [status(), status({ name: "cowork-b" })];
  await watcher.tick();
  h.statuses = [status({ attention: "gone" }), status({ name: "cowork-b" })];
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].threadId, 7);
  // cowork-b desaparece y su registro ya no existe
  delete h.records["cowork-b"];
  h.statuses = [status({ attention: "gone" })];
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].threadId, 8);
  assert.ok(!("cowork-b" in h.store.readState().sessions));
  // cowork-a deja de aparecer: ya avisada, se poda sin repetir
  h.statuses = [];
  await watcher.tick();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(Object.keys(h.store.readState().sessions), []);
  cleanup();
});

test("shell dos ticks con flujo sin terminar: aviso de atasco, una vez", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [status({ attention: "shell" })];
  await watcher.tick();
  assert.equal(h.sent.length, 0);
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /atasc/i);
  cleanup();
});

test("shell con flujo terminado no avisa de atasco", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [status({ attention: "shell", stagesDone: 3, stagesTotal: 3 })];
  await watcher.tick();
  await watcher.tick();
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /termin/i);
  cleanup();
});

test("el aviso persiste: un reinicio no lo repite", async () => {
  const first = setup();
  first.h.statuses = [asking(), status({ name: "cowork-b", stagesDone: 3, stagesTotal: 3 })];
  await first.watcher.tick();
  assert.equal(first.h.sent.length, 2);
  const second = setup({ dir: first.h.dir });
  second.h.statuses = first.h.statuses;
  await second.watcher.tick();
  await second.watcher.tick();
  assert.equal(second.h.sent.length, 0);
  first.cleanup();
});

test("un envío fallido no se marca como enviado y se reintenta", async () => {
  const { h, watcher, cleanup } = setup();
  h.statuses = [asking({ options: ["Sí"] }), status({ name: "cowork-b", stagesDone: 3, stagesTotal: 3 })];
  h.sendError = 2;
  await watcher.tick();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.store.readState().questions, {});
  assert.notEqual(h.store.readState().sessions["cowork-a"]?.lastQuestionId, "q1");
  assert.notEqual(h.store.readState().sessions["cowork-b"]?.finished, true);
  await watcher.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(Object.keys(h.store.readState().questions).length, 1);
  cleanup();
});

test("cada tick poda las preguntas de más de 7 días, contestadas o no", async () => {
  const { h, watcher, cleanup } = setup();
  const nowMs = AFTER + 5000;
  const days7 = 7 * 24 * 60 * 60 * 1000;
  const at = (ms: number) => new Date(ms).toISOString();
  const q = (createdAt: string, answered?: boolean) => ({ session: "cowork-a", questionId: "q", messageId: 1, options: [], createdAt, ...(answered ? { answered, claimed: true } : {}) });
  h.store.updateState((s) => {
    s.questions.viejaContestada = q(at(nowMs - days7 - 1), true);
    s.questions.viejaSinContestar = q(at(nowMs - days7 - 1));
    s.questions.fechaBasura = q("basura");
    s.questions.recienteContestada = q(at(nowMs - days7 + 1000), true);
    s.questions.recienteSinContestar = q(at(nowMs - days7 + 1000));
  });
  await watcher.tick();
  assert.deepEqual(Object.keys(h.store.readState().questions).sort(), ["recienteContestada", "recienteSinContestar"]);
  cleanup();
});

test("la poda corre aunque no se pueda leer el estado de las sesiones", async () => {
  const { h, watcher, cleanup } = setup();
  h.statusError = true;
  h.store.updateState((s) => {
    s.questions.vieja = { session: "cowork-a", questionId: "q", messageId: 1, options: [], createdAt: "2000-01-01T00:00:00.000Z" };
  });
  await watcher.tick();
  assert.deepEqual(h.store.readState().questions, {});
  cleanup();
});

test("un status que falla no tumba el tick", async () => {
  const { h, watcher, cleanup } = setup();
  h.statusError = true;
  await watcher.tick();
  h.statusError = false;
  h.statuses = [asking()];
  await watcher.tick();
  assert.equal(h.sent.length, 1);
  cleanup();
});

test("sin chat, sin tema o canal MCP no se envía nada", async () => {
  const none = setup();
  none.h.store.updateConfig({ chatId: undefined });
  none.h.statuses = [asking()];
  await none.watcher.tick();
  assert.equal(none.h.sent.length, 0);
  none.cleanup();
  const noTopic = setup();
  noTopic.h.records["cowork-a"] = record({ repo: "sin-tema" });
  noTopic.h.statuses = [asking()];
  await noTopic.watcher.tick();
  assert.equal(noTopic.h.sent.length, 0);
  noTopic.cleanup();
  const mcp = setup();
  mcp.h.records["cowork-a"] = record({ channel: "mcp" });
  mcp.h.statuses = [asking()];
  await mcp.watcher.tick();
  assert.equal(mcp.h.sent.length, 0);
  mcp.cleanup();
});
