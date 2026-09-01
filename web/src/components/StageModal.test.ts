import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StageModal } from "./StageModal.js";
import type { WfStage } from "../types.js";

const STAGE: WfStage = {
  key: "impl",
  label: "Implementar",
  icon: "⌨️",
  instruction: "Construye la funcionalidad.",
  verifyCmd: "npm test",
  maxRetries: 2,
};

test("StageModal muestra los valores de la etapa y bloquea verifyCmd cuando no está permitido", () => {
  const html = renderToString(createElement(StageModal, { stage: STAGE, allowVerifyCmd: false, onChange: () => {}, onClose: () => {}, onDelete: () => {} }));

  assert.match(html, /class="ronin-stage-modal"/);
  assert.match(html, /value="impl"/);
  assert.match(html, /value="Implementar"/);
  assert.match(html, /Construye la funcionalidad\./);
  assert.match(html, /disabled=""[^>]*value="npm test"/);
  assert.match(html, /disabled=""[^>]*value="2"/);
});

/**
 * T: tecleando en la instrucción, el foco saltaba al input "Nombre" en cada pulsación.
 * `onClose` llega como flecha inline desde WorkflowWorkspace, así que cambia de identidad en
 * CADA render; con el foco inicial colgado de esa dependencia, el efecto se re-ejecutaba con cada
 * tecla y robaba el foco. El enfoque de montaje NO puede depender de props inestables.
 *
 * Es una comprobación sobre la fuente, no sobre el DOM: este paquete se prueba con `node --test`
 * sin jsdom, y un efecto de React no corre en el render a string.
 */
test("el foco inicial del StageModal no depende de props que cambian en cada render", () => {
  const source = readFileSync(new URL("./StageModal.tsx", import.meta.url), "utf8");
  const focusEffect = source.match(/useEffect\(\(\) => \{[^]*?\.focus\(\)[^]*?\}, (\[[^\]]*\])\)/);

  assert.ok(focusEffect, "debe existir un efecto que enfoque al montar");
  assert.equal(focusEffect[1], "[]");
});
