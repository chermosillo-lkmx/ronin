import assert from "node:assert/strict";
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
