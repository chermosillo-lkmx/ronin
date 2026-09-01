import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSessionName, NewSessionDialog } from "./NewSessionDialog";

test("defaultSessionName prefiere el ticket y si no usa las primeras cuatro palabras", () => {
  assert.equal(defaultSessionName("necesito que trabajes este ticket CU-86e2 hoy"), "cowork-cu-86e2");
  assert.equal(defaultSessionName("Implementa la pantalla de inicio de sesión"), "cowork-implementa-la-pantalla-de");
});

test("el diálogo workflow ofrece una petición amplia y redimensionable", () => {
  const html = renderToStaticMarkup(createElement(NewSessionDialog, { onClose: () => {}, onCreated: () => {} }));
  const css = readFileSync(new URL("../ronin-shell.css", import.meta.url), "utf8");

  assert.match(html, /<textarea(?=[^>]*class="ronin-request-input")(?=[^>]*rows="12")/);
  assert.match(css, /\.ronin-new-session\s*\{[^}]*width:\s*min\(760px,\s*92vw\)/);
  assert.match(css, /\.ronin-request-input\s*\{[^}]*min-height:\s*220px/);
});
