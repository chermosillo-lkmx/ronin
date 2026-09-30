import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROMPTS, getPromptTemplate, MEMORY_TRIAGE_WARNING, PROMPT_KEYS, promptWarning, readPromptConfig, resetPromptTemplate, savePromptTemplate } from "./prompts.js";

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

test("la plantilla memory existe, tiene default y publica sus placeholders", () => {
  assert.equal(PROMPT_KEYS.includes("memory"), true);
  assert.equal(getPromptTemplate("memory"), DEFAULT_PROMPTS.memory);
  assert.deepEqual(
    readPromptConfig().find((prompt) => prompt.key === "memory")?.placeholders,
    ["{repo}", "{session}", "{workflow}", "{request}", "{evidence}", "{replies}", "{known}", "{skillCatalog}", "{offeredSkills}"],
  );
});

test("la plantilla kb publica {kbSuggestions} y su default lo usa al final", () => {
  assert.ok(DEFAULT_PROMPTS.kb.endsWith("{kbSuggestions}"));
  assert.ok(readPromptConfig().find((prompt) => prompt.key === "kb")?.placeholders.includes("{kbSuggestions}"));
});

test("la plantilla memory pide el triaje de skills y la plantilla skill existe con sus placeholders", () => {
  assert.ok(DEFAULT_PROMPTS.memory.includes("{skillCatalog}"));
  assert.ok(DEFAULT_PROMPTS.memory.includes("{offeredSkills}"));
  assert.match(DEFAULT_PROMPTS.memory, /"skill":null/);
  assert.match(DEFAULT_PROMPTS.memory, /"reusable":true/);
  assert.equal(PROMPT_KEYS.includes("skill"), true);
  assert.equal(getPromptTemplate("skill"), DEFAULT_PROMPTS.skill);
  const skill = readPromptConfig().find((prompt) => prompt.key === "skill");
  assert.deepEqual(skill?.placeholders, ["{repo}", "{session}", "{summary}", "{request}", "{evidence}", "{catalog}", "{current}"]);
  for (const placeholder of skill?.placeholders ?? []) assert.ok(DEFAULT_PROMPTS.skill.includes(placeholder), placeholder);
  assert.match(DEFAULT_PROMPTS.skill, /\{"skip":"motivo"\}/);
});

test("promptWarning avisa sólo cuando una plantilla memory no trae {skillCatalog}", () => {
  assert.equal(MEMORY_TRIAGE_WARNING, "tu plantilla memory no incluye el triaje de skills");
  assert.equal(promptWarning("memory", DEFAULT_PROMPTS.memory), undefined);
  assert.equal(promptWarning("memory", "destila {repo} a la antigua"), MEMORY_TRIAGE_WARNING);
  assert.equal(promptWarning("kb", "sin catálogo"), undefined);
  assert.equal(readPromptConfig().find((prompt) => prompt.key === "memory")?.warning, undefined);
});
