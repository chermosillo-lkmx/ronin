import assert from "node:assert/strict";
import test from "node:test";
import { nextSelectedPane } from "./SessionWorkspace.js";

/**
 * El inventario se resondea cada 5s y trae un array de panes NUEVO aunque nada haya cambiado.
 * Reseteando a `panes[0]` en cada llegada, el pane que el operador eligió duraba un segundo.
 */
test("nextSelectedPane conserva el pane elegido mientras siga existiendo", () => {
  const panes = [{ id: "%214" }, { id: "%215" }];
  assert.equal(nextSelectedPane("%215", panes), "%215");
  assert.equal(nextSelectedPane("%214", panes), "%214");
});

test("nextSelectedPane cae al primero cuando el elegido ya no está", () => {
  assert.equal(nextSelectedPane("%999", [{ id: "%214" }, { id: "%215" }]), "%214");
  assert.equal(nextSelectedPane(null, [{ id: "%214" }]), "%214");
});

test("nextSelectedPane devuelve null sin panes", () => {
  assert.equal(nextSelectedPane("%214", []), null);
  assert.equal(nextSelectedPane(null, []), null);
});
