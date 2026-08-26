import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isSafeTerminalSession, MAX_SESSION_NAME_LENGTH, SESSION_NAME_PATTERN } from "./session-name.js";

test("isSafeTerminalSession: charset, traversal, longitud", () => {
  assert.equal(isSafeTerminalSession("cowork-safe"), true);
  assert.equal(isSafeTerminalSession(""), false);
  assert.equal(isSafeTerminalSession("../../other"), false);
  assert.equal(isSafeTerminalSession("a/b"), false);
  assert.equal(isSafeTerminalSession("a".repeat(80)), true);
  assert.equal(isSafeTerminalSession("a".repeat(81)), false);
});

// Paridad obligatoria (T0.4/T0.3): desktop/ no puede importar server/src/*, así que esta
// duplicación se verifica leyendo el archivo fuente del server como texto y comparando el
// literal del regex y el tope de longitud como cadenas — nunca importando el módulo.
test("paridad: el regex y el tope de longitud coinciden byte a byte con server/src/session-name.ts", () => {
  const serverSource = readFileSync(new URL("../../server/src/session-name.ts", import.meta.url), "utf8");
  assert.match(serverSource, /const SESSION_NAME_PATTERN = \/\^\[A-Za-z0-9\._@-\]\+\$\/;/);
  assert.match(serverSource, /const MAX_SESSION_NAME_LENGTH = 80;/);
  assert.equal(SESSION_NAME_PATTERN.source, "^[A-Za-z0-9._@-]+$");
  assert.equal(MAX_SESSION_NAME_LENGTH, 80);
});
