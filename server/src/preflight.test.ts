import { strict as assert } from "node:assert";
import { test } from "node:test";
import { binCheck, pathCheck } from "./preflight.js";

test("binCheck: binario con versión → ok, y el detalle lleva ruta y versión", () => {
  const c = binCheck("tmux", "tmux", "/opt/homebrew/bin/tmux", "3.6", "brew install tmux");
  assert.equal(c.level, "ok");
  assert.equal(c.detail, "/opt/homebrew/bin/tmux · 3.6");
  assert.equal(c.note, undefined); // en ok no se le dan instrucciones al operador
});

test("binCheck: binario ausente → fail con la instrucción de instalación", () => {
  const c = binCheck("tmux", "tmux", "", "", "brew install tmux");
  assert.equal(c.level, "fail");
  assert.equal(c.detail, "no encontrado");
  assert.equal(c.note, "brew install tmux");
});

test("binCheck: binario presente pero sin versión legible → warn, no fail", () => {
  // Está y probablemente sirve; degradar a fail mandaría al operador a reinstalar algo sano.
  const c = binCheck("ttyd", "ttyd", "/opt/homebrew/bin/ttyd", "", "brew install ttyd");
  assert.equal(c.level, "warn");
  assert.equal(c.detail, "/opt/homebrew/bin/ttyd · versión desconocida");
  assert.equal(c.note, "brew install ttyd");
});

test("pathCheck: un PATH con entradas → ok y las cuenta", () => {
  const c = pathCheck(["/opt/homebrew/bin", "/usr/bin", "/bin"]);
  assert.equal(c.level, "ok");
  assert.equal(c.detail, "3 entradas");
  assert.equal(c.note, undefined);
});

test("pathCheck: un PATH vacío → fail (el modo de fallo de Electron)", () => {
  // Una app lanzada desde Finder no hereda el PATH del login shell: tmux/claude/git simplemente
  // no existen para ella. Este check es el que lo hará visible en F6.
  const c = pathCheck([]);
  assert.equal(c.level, "fail");
  assert.equal(c.detail, "vacío");
  assert.match(c.note ?? "", /login shell/i);
});
