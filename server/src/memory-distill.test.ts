import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MemoryEntry } from "./memory.js";
import {
  buildDistillPrompt,
  buildEvidence,
  DISTILL_EVIDENCE_MAX_BYTES,
  hasEvidence,
  parseDistillOutput,
  readCycleLaunch,
  readDistillSources,
  tailBytes,
} from "./memory-distill.js";
import { DEFAULT_PROMPTS } from "./prompts.js";

const EMPTY = { summary: null, research: null, verdict: null, plan: null, tests: null };

test("parseDistillOutput acepta el JSON del esquema aunque venga rodeado de texto o de un bloque ```json", () => {
  const wrapped = "Aquí va:\n```json\n{\"entries\":[{\"text\":\"Tests: usar make test-unit\",\"kind\":\"comando\"}]}\n```";
  assert.deepEqual(parseDistillOutput(wrapped), [{ text: "Tests: usar make test-unit", kind: "comando" }]);
  assert.deepEqual(parseDistillOutput('{"entries": []}'), []);
});

test("parseDistillOutput descarta la salida completa si no cumple el esquema", () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ text: `aprendizaje ${i}`, kind: "comando" }));
  const cases: Array<[string, RegExp]> = [
    ["sin json", /no contiene JSON/],
    ["{roto}", /no es JSON válido/],
    ['{"entries": {}}', /entries debe ser una lista/],
    ['[{"text":"x","kind":"comando"}]', /entries debe ser una lista/],
    [JSON.stringify({ entries: six }), /más de 5 entradas/],
    [JSON.stringify({ entries: [{ text: "x".repeat(201), kind: "comando" }] }), /de 1 a 200 caracteres/],
    [JSON.stringify({ entries: [{ text: "", kind: "comando" }] }), /de 1 a 200 caracteres/],
    [JSON.stringify({ entries: [{ text: "ok", kind: "chisme" }] }), /kind inválido/],
    [JSON.stringify({ entries: [{ text: "ok", kind: "comando" }, "suelto"] }), /entrada 2/],
  ];
  for (const [output, error] of cases) assert.throws(() => parseDistillOutput(output), error, output);
});

test("parseDistillOutput deja pasar caracteres de control: el store los limpia al proponer", () => {
  assert.deepEqual(
    parseDistillOutput(JSON.stringify({ entries: [{ text: "usa\u0007 make", kind: "trampa" }] })),
    [{ text: "usa\u0007 make", kind: "trampa" }],
  );
});

test("tailBytes conserva el final sin partir caracteres multibyte", () => {
  assert.equal(tailBytes("hola", 10), "hola");
  assert.equal(tailBytes("inicio-final", 5), "final");
  assert.equal(tailBytes("ññññ", 3), "ñ");
  assert.equal(tailBytes("abc", 0), "");
});

test("buildEvidence recorta a 24 KB en total conservando el final de cada archivo", () => {
  const big = (label: string) => `INICIO-${label}\n${"x".repeat(30 * 1024)}\nFINAL-${label}`;
  const evidence = buildEvidence({ summary: big("summary"), research: big("research"), verdict: "APROBADO", plan: big("plan"), tests: null });
  assert.ok(Buffer.byteLength(evidence, "utf8") <= DISTILL_EVIDENCE_MAX_BYTES, String(Buffer.byteLength(evidence, "utf8")));
  for (const label of ["summary", "research", "plan"]) {
    assert.match(evidence, new RegExp(`FINAL-${label}`));
    assert.doesNotMatch(evidence, new RegExp(`INICIO-${label}`));
  }
  assert.match(evidence, /### evidence\/verdict\.md\nAPROBADO/);
  assert.doesNotMatch(evidence, /tests\.md/);
});

test("sin ningún archivo con contenido no hay evidencia", () => {
  assert.equal(hasEvidence(EMPTY), false);
  assert.equal(hasEvidence({ ...EMPTY, summary: "  \n" }), false);
  assert.equal(buildEvidence({ ...EMPTY, summary: "  \n" }), "");
  assert.equal(hasEvidence({ ...EMPTY, tests: "42 passed" }), true);
});

test("readDistillSources lee evidencia, plan.md del ciclo y tests.md; readCycleLaunch la petición y el workflow", () => {
  const cycle = mkdtempSync(join(tmpdir(), "ronin-distill-cycle-"));
  try {
    mkdirSync(join(cycle, "evidence"));
    writeFileSync(join(cycle, "evidence", "summary.md"), "resumen");
    writeFileSync(join(cycle, "evidence", "tests.md"), "42 passed");
    writeFileSync(join(cycle, "plan.md"), "1. reintentos");
    writeFileSync(join(cycle, "launch.json"), JSON.stringify({ repo: "acme-api", request: "agrega reintentos al csv", workflowName: "plan-tdd" }));
    assert.deepEqual(readDistillSources(cycle), { summary: "resumen", research: null, verdict: null, plan: "1. reintentos", tests: "42 passed" });
    assert.deepEqual(readCycleLaunch(cycle), { repo: "acme-api", request: "agrega reintentos al csv", workflow: "plan-tdd" });
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("buildDistillPrompt rellena la plantilla con petición, evidencia, últimas 20 respuestas y memoria conocida", () => {
  const known: MemoryEntry[] = [
    { id: "m_1", text: "Tests: usar make test-unit", kind: "comando", source: "s", createdAt: 1, updatedAt: 1, status: "active", uses: 2 },
    { id: "m_2", text: "Usa siempre pnpm", kind: "preferencia", source: "s", createdAt: 1, updatedAt: 1, status: "discarded", uses: 0 },
    { id: "m_3", text: "Pendiente", kind: "trampa", source: "s", createdAt: 1, updatedAt: 1, status: "pending", uses: 0 },
  ];
  const replies = Array.from({ length: 25 }, (_, i) => `respuesta ${i}\ncon salto`);
  const prompt = buildDistillPrompt(
    { repo: "acme-api", session: "cowork-csv", workflow: "plan-tdd", request: "agrega reintentos", evidence: "### evidence/summary.md\nlisto", replies, known },
    "{repo}|{session}|{workflow}|{request}\n{evidence}\n{replies}\n{known}",
  );
  assert.equal(prompt.split("\n")[0], "acme-api|cowork-csv|plan-tdd|agrega reintentos");
  assert.match(prompt, /### evidence\/summary\.md\nlisto/);
  assert.doesNotMatch(prompt, /respuesta 4 /);
  assert.match(prompt, /- respuesta 5 con salto/);
  assert.match(prompt, /- respuesta 24 con salto/);
  assert.match(prompt, /- \[comando\] Tests: usar make test-unit\n- \[preferencia\] Usa siempre pnpm \(descartada\)$/);
  assert.doesNotMatch(prompt, /Pendiente/);
});

test("la plantilla memory por defecto usa todos los placeholders y rellena los vacíos", () => {
  for (const name of ["{repo}", "{session}", "{workflow}", "{request}", "{evidence}", "{replies}", "{known}"]) {
    assert.ok(DEFAULT_PROMPTS.memory.includes(name), name);
  }
  assert.match(DEFAULT_PROMPTS.memory, /\{"entries": \[\]\}/);
  const prompt = buildDistillPrompt({ repo: "acme-api", session: "cowork-x", workflow: "", request: "", evidence: "", replies: [], known: [] }, DEFAULT_PROMPTS.memory);
  assert.match(prompt, /\(sin petición registrada\)/);
  assert.match(prompt, /\(ninguna\)/);
  assert.match(prompt, /\(vacía\)/);
  assert.doesNotMatch(prompt, /\{repo\}|\{known\}|\{evidence\}/);
});

test("buildDistillPrompt rellena {skillCatalog} y {offeredSkills}, con valores por defecto si faltan", () => {
  const base = { repo: "acme-api", session: "cowork-x", workflow: "", request: "", evidence: "", replies: [], known: [] };
  const template = "catálogo:\n{skillCatalog}\nofrecidas:\n{offeredSkills}";
  assert.equal(buildDistillPrompt({ ...base, skillCatalog: "- migracion-reversible: Migra.", offeredSkills: "- api-review (global)" }, template), "catálogo:\n- migracion-reversible: Migra.\nofrecidas:\n- api-review (global)");
  assert.equal(buildDistillPrompt(base, template), "catálogo:\n(vacío)\nofrecidas:\n(ninguna)");
  assert.doesNotMatch(buildDistillPrompt(base, DEFAULT_PROMPTS.memory), /\{skillCatalog\}|\{offeredSkills\}/);
});
