import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { ExecutorPicker } from "./ExecutorPicker.js";

test("M7a ExecutorPicker renderiza cuatro opciones y usa el datalistId recibido", () => {
  const html = renderToString(createElement(ExecutorPicker, {
    executor: "codex",
    model: "gpt-5",
    datalistId: "models-plan",
    onChange: () => {},
  }));

  assert.equal((html.match(/data-executor-option=/g) ?? []).length, 4);
  assert.match(html, /data-executor-option="hereda"/);
  assert.match(html, /list="models-plan"/);
  assert.match(html, /id="models-plan"/);
});

test("M7b StageModal consume ExecutorPicker sin mantener un selector duplicado", () => {
  const source = readFileSync(new URL("./StageModal.tsx", import.meta.url), "utf8");

  assert.match(source, /import \{ ExecutorPicker \} from "\.\/ExecutorPicker\.js"/);
  assert.match(source, /<ExecutorPicker[^>]*datalistId="ronin-stage-models"/s);
  assert.doesNotMatch(source, /const EXECUTOR_OPTIONS/);
});
