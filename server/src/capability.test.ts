import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureCapabilityToken, readCapabilityToken, requireCapability, verifyCapability } from "./capability.js";

function tempFile(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cowork-capability-"));
  const file = join(dir, "capability-token");
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ensureCapabilityToken: crea el archivo en modo 0600 con un token de al menos 32 bytes hex", () => {
  const { file, cleanup } = tempFile();
  try {
    const token = ensureCapabilityToken(file);
    assert.match(token, /^[0-9a-f]+$/);
    assert.ok(Buffer.byteLength(token, "utf8") >= 64, "32 bytes en hex son 64 caracteres");
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(file, "utf8"), token);
  } finally {
    cleanup();
  }
});

test("ensureCapabilityToken: llamarla dos veces en el mismo arranque devuelve el MISMO token sin reescribir", () => {
  const { file, cleanup } = tempFile();
  try {
    const first = ensureCapabilityToken(file);
    const beforeSecondCall = statSync(file).mtimeNs;
    const second = ensureCapabilityToken(file);
    assert.equal(second, first);
    assert.equal(statSync(file).mtimeNs, beforeSecondCall);
  } finally {
    cleanup();
  }
});

test("readCapabilityToken: null si el archivo no existe (arranque aún no completado) — no lanza", () => {
  const { file, cleanup } = tempFile();
  try {
    assert.equal(readCapabilityToken(file), null);
  } finally {
    cleanup();
  }
});

test("verifyCapability: tiempo constante, rechaza undefined, vacío y longitud distinta", () => {
  const { file, cleanup } = tempFile();
  try {
    const token = ensureCapabilityToken(file);
    assert.equal(verifyCapability(undefined, file), false);
    assert.equal(verifyCapability("", file), false);
    assert.equal(verifyCapability(token.slice(0, -1), file), false);
    assert.equal(verifyCapability(token + "x", file), false);
    assert.equal(verifyCapability(token, file), true);
  } finally {
    cleanup();
  }
});

test("verifyCapability: false si el archivo no existe todavía, sin lanzar", () => {
  const { file, cleanup } = tempFile();
  try {
    assert.equal(verifyCapability("anything", file), false);
  } finally {
    cleanup();
  }
});

// ---- requireCapability: la puerta general de /api (T4) ----

function fakeReqRes(method: string, headers: Record<string, string> = {}) {
  let statusCode: number | undefined;
  let body: unknown;
  let nextCalled = false;
  const req = { method, get: (name: string) => headers[name.toLowerCase()] } as any;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as any;
  const next = () => { nextCalled = true; };
  return { req, res, next, outcome: () => ({ statusCode, body, nextCalled }) };
}

test("requireCapability: deja pasar GET/HEAD/OPTIONS sin mirar nada, aunque no haya token ni cabecera", () => {
  const { file, cleanup } = tempFile();
  try {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const { req, res, next, outcome } = fakeReqRes(method);
      requireCapability(req, res, next, file);
      assert.deepEqual(outcome(), { statusCode: undefined, body: undefined, nextCalled: true });
    }
  } finally {
    cleanup();
  }
});

test("requireCapability: sin token en disco todavía → 503 CAPABILITY_UNAVAILABLE, fail-closed, next NO se llama", () => {
  const { file, cleanup } = tempFile();
  try {
    const { req, res, next, outcome } = fakeReqRes("POST");
    requireCapability(req, res, next, file);
    const result = outcome();
    assert.equal(result.statusCode, 503);
    assert.equal((result.body as any).code, "CAPABILITY_UNAVAILABLE");
    assert.equal(result.nextCalled, false);
  } finally {
    cleanup();
  }
});

test("requireCapability: token en disco pero cabecera ausente o incorrecta → 401 CAPABILITY_REQUIRED, next NO se llama", () => {
  const { file, cleanup } = tempFile();
  try {
    ensureCapabilityToken(file);
    for (const headers of [{}, { "x-ronin-capability": "wrong" }]) {
      const { req, res, next, outcome } = fakeReqRes("POST", headers);
      requireCapability(req, res, next, file);
      const result = outcome();
      assert.equal(result.statusCode, 401);
      assert.equal((result.body as any).code, "CAPABILITY_REQUIRED");
      assert.equal(result.nextCalled, false);
    }
  } finally {
    cleanup();
  }
});

test("requireCapability: /webhook/dm pasa sin capability — YA pasó por requireWebhookSecret (su propia puerta), no está exenta de facto", () => {
  const { file, cleanup } = tempFile();
  try {
    const { req, res, next, outcome } = fakeReqRes("POST");
    (req as any).path = "/webhook/dm";
    requireCapability(req, res, next, file);
    assert.deepEqual(outcome(), { statusCode: undefined, body: undefined, nextCalled: true });
  } finally {
    cleanup();
  }
});

test("requireCapability: con la cabecera correcta, next() se llama y no se toca la respuesta", () => {
  const { file, cleanup } = tempFile();
  try {
    const token = ensureCapabilityToken(file);
    const { req, res, next, outcome } = fakeReqRes("POST", { "x-ronin-capability": token });
    requireCapability(req, res, next, file);
    assert.deepEqual(outcome(), { statusCode: undefined, body: undefined, nextCalled: true });
  } finally {
    cleanup();
  }
});
