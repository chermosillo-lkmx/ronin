import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { failedReposOf, TelegramScreen } from "./TelegramScreen.js";
import { TelegramRequestError } from "../api.js";
import type { TelegramStatus } from "../types";

test("failedReposOf conserva la lista de un 502 parcial y vacía en cualquier otro error", () => {
  assert.deepEqual(failedReposOf(new TelegramRequestError("No pude crear el tema de algunos repos.", ["acme-web"])), ["acme-web"]);
  assert.deepEqual(failedReposOf(new TelegramRequestError("x")), []);
  assert.deepEqual(failedReposOf(new Error("x")), []);
  assert.deepEqual(failedReposOf("boom"), []);
});

test("en done, repos fallidos muestran la lista y Reintentar aunque no se edite", () => {
  const html = renderToString(createElement(TelegramScreen, {
    initial: { step: "done", botUsername: "b", userLinked: true, group: GROUP, repos: [{ repo: "acme-api", hasTopic: true }, { repo: "acme-web", hasTopic: false }], connected: true },
    initialFailedRepos: ["acme-web"],
  }));
  assert.match(html, /No pude crear el tema de/);
  assert.match(html, /acme-web/);
  assert.match(html, /Reintentar/);
});

const REPOS = [{ repo: "acme-api", hasTopic: false }, { repo: "acme-web", hasTopic: false }];
const GROUP = { title: "Ronin", isForum: true, botIsAdmin: true, canManageTopics: true };
const render = (initial: TelegramStatus) => renderToString(createElement(TelegramScreen, { initial }));

test("sin bot muestra el paso 1 con instrucciones de BotFather", () => {
  const html = render({ step: 1, userLinked: false, repos: REPOS, connected: false });
  assert.match(html, /@BotFather/);
  assert.match(html, /\/newbot/);
  assert.match(html, /Pega el token/);
});

test("paso 3 explica que el grupo es manual y pide activar Temas", () => {
  const html = render({ step: 3, botUsername: "ronin_bot", userLinked: true, repos: REPOS, connected: true });
  assert.match(html, /no puede crear grupos/);
  assert.match(html, /manual/);
  assert.match(html, /Temas/);
  assert.ok(html.indexOf("Crea el grupo") < html.indexOf("Activa Temas"), "orden: crear grupo antes de Temas");
  assert.ok(html.indexOf("Activa Temas") < html.indexOf("abre el enlace"), "orden: Temas antes del enlace");
});

test("paso 3 señala Temas apagados o permisos faltantes", () => {
  const off = render({ step: 3, botUsername: "b", userLinked: true, repos: REPOS, connected: true, group: { ...GROUP, isForum: false } });
  assert.match(off, /Temas están apagados/);
  const perms = render({ step: 3, botUsername: "b", userLinked: true, repos: REPOS, connected: true, group: { ...GROUP, botIsAdmin: false, canManageTopics: false } });
  assert.match(perms, /no es administrador/);
  assert.match(perms, /administrar temas/);
});

test("paso 4 muestra casillas por repo", () => {
  const html = render({ step: 4, botUsername: "b", userLinked: true, group: GROUP, repos: REPOS, connected: true });
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.match(html, /acme-api/);
  assert.match(html, /acme-web/);
});

test("estado final muestra conexión, último error y la condición de Mac encendida con Ronin abierto", () => {
  const html = render({
    step: "done", botUsername: "ronin_bot", userLinked: true, group: GROUP, connected: false,
    repos: [{ repo: "acme-api", hasTopic: true }, { repo: "acme-web", hasTopic: false }],
    lastError: "No pude consultar el grupo en Telegram; muestro lo último que sé.",
  });
  assert.match(html, /Sin conexión/);
  assert.match(html, /No pude consultar el grupo/);
  assert.match(html, /encendida y despierta/);
  assert.match(html, /Ronin abierto/);
  assert.match(html, /otro bot/);
  assert.match(html, /Cambiar repos/);
  assert.match(html, /Desconectar/);
  assert.doesNotMatch(html, /role="dialog"/);
  assert.match(render({ step: "done", botUsername: "b", userLinked: true, group: GROUP, repos: REPOS, connected: true }), /Conectado/);
});

test("nunca renderiza un campo con el token guardado", () => {
  const html = render({ step: 1, userLinked: false, repos: REPOS, connected: false });
  const input = html.match(/<input[^>]*>/)?.[0] ?? "";
  assert.match(input, /type="password"/);
  assert.doesNotMatch(input, /value=/);
  const done = render({ step: "done", botUsername: "b", userLinked: true, group: GROUP, repos: REPOS, connected: true });
  assert.doesNotMatch(done, /<input[^>]*type="(password|text)"/);
});
