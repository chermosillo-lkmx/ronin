import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROMPTS, getPromptTemplate, PROMPT_KEYS, readPromptConfig, resetPromptTemplate, savePromptTemplate } from "./prompts.js";

test("la plantilla kb tiene un default y conserva guardar/restaurar", () => {
  assert.equal(PROMPT_KEYS.includes("kb"), true);
  assert.ok(DEFAULT_PROMPTS.kb.trim());
  assert.equal(getPromptTemplate("kb"), DEFAULT_PROMPTS.kb);

  try {
    savePromptTemplate("kb", "KB de prueba en {kbDir} para {repo}");
    assert.equal(getPromptTemplate("kb"), "KB de prueba en {kbDir} para {repo}");
    assert.equal(readPromptConfig().find((prompt) => prompt.key === "kb")?.isDefault, false);
  } finally {
    resetPromptTemplate("kb");
  }

  assert.equal(getPromptTemplate("kb"), DEFAULT_PROMPTS.kb);
  assert.equal(readPromptConfig().find((prompt) => prompt.key === "kb")?.isDefault, true);
});
