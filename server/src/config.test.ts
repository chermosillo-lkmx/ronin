import assert from "node:assert/strict";
import test from "node:test";
import { resolveVerifyGate, VERIFY_GATE } from "./config.js";

test("resolveVerifyGate: encendido por defecto — sin variable el gate corre", () => {
  assert.equal(resolveVerifyGate(undefined), true);
  assert.equal(resolveVerifyGate(""), true);
});

test("resolveVerifyGate: sólo COWORK_VERIFY_GATE=0 lo apaga; 1 y cualquier otro valor lo dejan encendido", () => {
  assert.equal(resolveVerifyGate("0"), false);
  assert.equal(resolveVerifyGate("1"), true);
  assert.equal(resolveVerifyGate("false"), true);
});

test("VERIFY_GATE del módulo sale de resolveVerifyGate sobre el entorno del proceso", () => {
  assert.equal(VERIFY_GATE, resolveVerifyGate(process.env.COWORK_VERIFY_GATE));
});
