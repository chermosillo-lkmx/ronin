import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TrustedRootsEditor } from "./TrustedRootsEditor.js";

test("TrustedRootsEditor permite editar raíces guardadas", () => {
  const html = renderToString(createElement(TrustedRootsEditor, { roots: ["/workspace"], source: "settings", onSave: async () => {} }));
  assert.match(html, /Raíces de confianza/);
  assert.match(html, /placeholder="\/ruta\/de\/confianza"/);
  assert.match(html, /Guardar raíces/);
  assert.match(html, /Añadir un repo no lo autoriza; añadir su raíz sí\./);
});

test("TrustedRootsEditor muestra sólo lectura cuando la política viene del entorno", () => {
  const html = renderToString(createElement(TrustedRootsEditor, { roots: ["/workspace"], source: "env", onSave: async () => {} }));
  assert.match(html, /definidas por COWORK_ALLOWED_ROOTS/);
  assert.doesNotMatch(html, /Guardar raíces/);
});
