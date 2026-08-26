import assert from "node:assert/strict";
import test from "node:test";
import { defaultSessionName } from "./NewSessionDialog";

test("defaultSessionName prefiere el ticket y si no usa las primeras cuatro palabras", () => {
  assert.equal(defaultSessionName("necesito que trabajes este ticket CU-86e2 hoy"), "cowork-cu-86e2");
  assert.equal(defaultSessionName("Implementa la pantalla de inicio de sesión"), "cowork-implementa-la-pantalla-de");
});
