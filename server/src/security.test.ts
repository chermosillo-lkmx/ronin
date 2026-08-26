import { strict as assert } from "node:assert";
import { test } from "node:test";
import { constantTimeEqual, isLoopbackOrigin, requireWebhookSecret } from "./security.js";

function fakeReqRes(headers: Record<string, string> = {}) {
  let statusCode: number | undefined;
  let body: unknown;
  let nextCalled = false;
  const req = { get: (name: string) => headers[name.toLowerCase()] } as any;
  const res = {
    status(code: number) { statusCode = code; return this; },
    json(payload: unknown) { body = payload; return this; },
  } as any;
  const next = () => { nextCalled = true; };
  return { req, res, next, outcome: () => ({ statusCode, body, nextCalled }) };
}

function withWebhookSecret(value: string | undefined, fn: () => void): void {
  const previous = process.env.COWORK_WEBHOOK_SECRET;
  if (value === undefined) delete process.env.COWORK_WEBHOOK_SECRET;
  else process.env.COWORK_WEBHOOK_SECRET = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.COWORK_WEBHOOK_SECRET;
    else process.env.COWORK_WEBHOOK_SECRET = previous;
  }
}

test("requireWebhookSecret: COWORK_WEBHOOK_SECRET sin configurar → 503 nombrando la variable, next NO se llama, sin lanzar un worker", () => {
  withWebhookSecret(undefined, () => {
    const { req, res, next, outcome } = fakeReqRes();
    requireWebhookSecret(req, res, next);
    const result = outcome();
    assert.equal(result.statusCode, 503);
    assert.equal((result.body as any).code, "WEBHOOK_SECRET_UNCONFIGURED");
    assert.match((result.body as any).error, /COWORK_WEBHOOK_SECRET/);
    assert.equal(result.nextCalled, false);
  });
});

test("requireWebhookSecret: configurado, sin cabecera o con una incorrecta → 401 WEBHOOK_FORBIDDEN, next NO se llama", () => {
  withWebhookSecret("s3cret", () => {
    for (const headers of [{}, { "x-ronin-webhook-secret": "wrong" }]) {
      const { req, res, next, outcome } = fakeReqRes(headers);
      requireWebhookSecret(req, res, next);
      const result = outcome();
      assert.equal(result.statusCode, 401);
      assert.equal((result.body as any).code, "WEBHOOK_FORBIDDEN");
      assert.equal(result.nextCalled, false);
    }
  });
});

test("requireWebhookSecret: configurado y con la cabecera correcta → next() se llama, sin tocar la respuesta", () => {
  withWebhookSecret("s3cret", () => {
    const { req, res, next, outcome } = fakeReqRes({ "x-ronin-webhook-secret": "s3cret" });
    requireWebhookSecret(req, res, next);
    assert.deepEqual(outcome(), { statusCode: undefined, body: undefined, nextCalled: true });
  });
});

test("requireWebhookSecret: comparación de tiempo constante — longitudes distintas se rechazan sin comparar byte a byte", () => {
  withWebhookSecret("s3cret", () => {
    const { req, res, next, outcome } = fakeReqRes({ "x-ronin-webhook-secret": "s3cretx" });
    requireWebhookSecret(req, res, next);
    assert.equal(outcome().statusCode, 401);
  });
});

test("constantTimeEqual: rechaza sin comparar cuando lo esperado está vacío (sin credencial configurada)", () => {
  assert.equal(constantTimeEqual("", ""), false);
  assert.equal(constantTimeEqual("", "anything"), false);
});

test("constantTimeEqual: rechaza longitudes distintas y acepta sólo el match exacto", () => {
  assert.equal(constantTimeEqual("secret", "secre"), false);
  assert.equal(constantTimeEqual("secret", "secrets"), false);
  assert.equal(constantTimeEqual("secret", "wrongx"), false);
  assert.equal(constantTimeEqual("secret", "secret"), true);
});

test("isLoopbackOrigin: sin Origin pasa (curl / same-origin / <img>)", () => {
  // Un POST cross-site del navegador SIEMPRE manda Origin. Su ausencia significa terminal,
  // mismo origen, o una carga no-cors como el <img> de la ruta de evidencia: bloquearla
  // rompería el uso desde curl sin ganar nada.
  assert.equal(isLoopbackOrigin(undefined), true);
  assert.equal(isLoopbackOrigin(""), true);
});

test("isLoopbackOrigin: acepta las cuatro formas de loopback", () => {
  assert.equal(isLoopbackOrigin("http://localhost:5180"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.1:8787"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:5180"), true);
  assert.equal(isLoopbackOrigin("https://localhost:5180"), true);
});

test("isLoopbackOrigin: acepta sólo el origin exacto de Electron", () => {
  assert.equal(isLoopbackOrigin("app://ronin"), true);
  assert.equal(isLoopbackOrigin("app://evil"), false);
  assert.equal(isLoopbackOrigin("app://ronin.evil"), false);
  assert.equal(isLoopbackOrigin("file:///tmp/ronin/index.html"), false);
});

test("isLoopbackOrigin: rechaza cualquier host externo", () => {
  assert.equal(isLoopbackOrigin("https://evil.example.com"), false);
  assert.equal(isLoopbackOrigin("http://192.168.1.50:5180"), false);
});

test("isLoopbackOrigin: rechaza un Origin no parseable, y `null` es uno de ellos", () => {
  // Fallar abierto aquí sería regalar el guard a cualquiera que mande basura.
  // `null` es el Origin de un iframe `sandbox` sin allow-same-origin: contenido que un
  // atacante controla. Aceptarlo haría el guard evadible con tres atributos de HTML.
  // Por eso F6 tiene que servir el renderer de Electron con un esquema propio (`app://`),
  // nunca desde `file://` — se allowlistea ese esquema, no se abre la puerta a `null`.
  assert.equal(isLoopbackOrigin("no-es-una-url"), false);
  assert.equal(isLoopbackOrigin("null"), false);
});

test("isLoopbackOrigin: no se deja engañar por un host que CONTIENE localhost", () => {
  // `localhost.evil.com` contiene la cadena; la comprobación es de hostname exacto.
  assert.equal(isLoopbackOrigin("http://localhost.evil.com"), false);
  assert.equal(isLoopbackOrigin("http://127.0.0.1.evil.com"), false);
});
