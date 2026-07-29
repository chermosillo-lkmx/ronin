import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isLoopbackOrigin } from "./security.js";

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
