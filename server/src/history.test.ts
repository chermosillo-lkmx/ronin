import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isReplyText, readHistory, readReplies, recordEvent, recordReply } from "./history.js";

function historyFile() {
  const directory = mkdtempSync(join(tmpdir(), "ronin-history-"));
  return { file: join(directory, "history.jsonl"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("recordReply registra un evento reply recortado con truncate(…, 2000)", () => {
  const { file, cleanup } = historyFile();
  try {
    recordReply("cowork-csv", "x".repeat(2500), "acme-api", file);
    const [event] = readHistory(0, Number.MAX_SAFE_INTEGER, file);
    assert.equal(event.type, "reply");
    assert.equal(event.key, "cowork-csv");
    assert.equal(event.repo, "acme-api");
    assert.equal(event.source, "session");
    assert.equal(event.text, `${"x".repeat(2000)}\n…[truncado]`);
  } finally {
    cleanup();
  }
});

test("readReplies devuelve sólo las respuestas de esa sesión, de la más antigua a la más reciente", () => {
  const { file, cleanup } = historyFile();
  try {
    recordReply("cowork-a", "primera", "acme-api", file);
    recordEvent({ type: "launch", key: "cowork-a", title: "x", repo: "acme-api", source: "session" }, file);
    recordReply("cowork-b", "de otra sesión", "acme-api", file);
    recordReply("cowork-a", "segunda", "acme-api", file);
    assert.deepEqual(readReplies("cowork-a", file), ["primera", "segunda"]);
    assert.deepEqual(readReplies("cowork-nadie", file), []);
  } finally {
    cleanup();
  }
});

test("isReplyText: sólo texto con Enter, nunca teclas sueltas ni opciones de menú", () => {
  assert.equal(isReplyText("usa make test-unit", true), true);
  assert.equal(isReplyText("123 pasos no es una opción", true), true);
  assert.equal(isReplyText("usa make test-unit", false), false);
  assert.equal(isReplyText("", true), false);
  assert.equal(isReplyText("  \r", true), false);
  assert.equal(isReplyText("2", true), false);
  assert.equal(isReplyText(" 12 ", true), false);
});
