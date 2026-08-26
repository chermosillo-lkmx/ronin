import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isSafeSessionName } from "./session-name.js";

test("isSafeSessionName: conserva el charset y las reglas actuales (traversal, vacío, '/')", () => {
  assert.equal(isSafeSessionName("cowork-adhoc-mrz96md7"), true);
  assert.equal(isSafeSessionName("113"), true);
  assert.equal(isSafeSessionName("../../etc"), false);
  assert.equal(isSafeSessionName("a/b"), false);
  assert.equal(isSafeSessionName(""), false);
  assert.equal(isSafeSessionName(".."), false);
});

test("isSafeSessionName: rechaza un nombre de más de 80 caracteres (KB electron-desktop:94)", () => {
  assert.equal(isSafeSessionName("a".repeat(80)), true);
  assert.equal(isSafeSessionName("a".repeat(81)), false);
  assert.equal(isSafeSessionName("cowork-" + "x".repeat(200)), false);
});
