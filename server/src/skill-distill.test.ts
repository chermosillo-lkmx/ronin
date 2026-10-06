import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PROMPTS } from "./prompts.js";
import {
  buildSkillDraftPrompt,
  evaluateSkillGate,
  formatOfferedSkills,
  isFlowComplete,
  MANUAL_SUMMARY,
  NO_DETERMINISTIC_GATE,
  parseSkillDraft,
  parseSkillTriage,
  readOfferedSkills,
} from "./skill-distill.js";

const TRIAGE = { reusable: true, name: "migracion-reversible", summary: "Cómo agregar una migración reversible y probarla.", updates: null };

test("parseSkillTriage: un skill válido se acepta aunque las entradas de memoria no sirvan", () => {
  assert.deepEqual(parseSkillTriage(JSON.stringify({ entries: [], skill: TRIAGE })), { ok: true, triage: { name: "migracion-reversible", summary: TRIAGE.summary, updates: null } });
  assert.deepEqual(parseSkillTriage(`Listo:\n${JSON.stringify({ entries: "no es lista", skill: { ...TRIAGE, updates: " migracion-reversible " } })}`), {
    ok: true,
    triage: { name: "migracion-reversible", summary: TRIAGE.summary, updates: "migracion-reversible" },
  });
});

test("parseSkillTriage: null, ausente o reusable false no proponen nada", () => {
  for (const output of ['{"entries": []}', '{"entries": [], "skill": null}', JSON.stringify({ entries: [], skill: { ...TRIAGE, reusable: false } })]) {
    assert.deepEqual(parseSkillTriage(output), { ok: true, triage: null }, output);
  }
});

test("parseSkillTriage: un skill inválido o una salida sin JSON dejan sólo la parte de skill en error", () => {
  const cases: Array<[string, RegExp]> = [
    ["sin json", /no contiene JSON/],
    [JSON.stringify({ skill: "sí" }), /skill debe ser un objeto o null/],
    [JSON.stringify({ skill: { ...TRIAGE, reusable: "sí" } }), /reusable/],
    [JSON.stringify({ skill: { ...TRIAGE, name: "" } }), /skill\.name/],
    [JSON.stringify({ skill: { ...TRIAGE, summary: "x".repeat(201) } }), /skill\.summary debe tener de 1 a 200/],
    [JSON.stringify({ skill: { ...TRIAGE, updates: 3 } }), /skill\.updates/],
  ];
  for (const [output, error] of cases) {
    const result = parseSkillTriage(output);
    assert.equal(result.ok, false, output);
    assert.match(result.ok ? "" : result.error, error, output);
  }
});

function cycleFixture(options: { verify?: Record<string, "passed" | "failed" | "pending">; done?: string[]; verifyCmd?: Record<string, string> } = {}) {
  const cycle = mkdtempSync(join(tmpdir(), "ronin-skill-gate-"));
  const verifyCmd = options.verifyCmd ?? { test: "npm test" };
  const stages = ["plan", "test", "done"].map((key) => ({ key, label: key, icon: "·", ...(verifyCmd[key] ? { verifyCmd: verifyCmd[key] } : {}) }));
  writeFileSync(join(cycle, "flow.json"), JSON.stringify({ stages, verifyAfter: [] }));
  mkdirSync(join(cycle, "evidence"));
  for (const key of options.done ?? ["plan", "test", "done"]) writeFileSync(join(cycle, key), "");
  for (const [key, status] of Object.entries(options.verify ?? { test: "passed" })) writeFileSync(join(cycle, `verify-${key}.json`), JSON.stringify({ attempts: 1, status }));
  return { cycle, cleanup: () => rmSync(cycle, { recursive: true, force: true }) };
}

test("evaluateSkillGate: flujo completo, un verifyCmd aprobado y ningún gate fallido", () => {
  const ok = cycleFixture();
  try {
    assert.equal(isFlowComplete(ok.cycle), true);
    assert.deepEqual(evaluateSkillGate(ok.cycle), { ok: true });
  } finally {
    ok.cleanup();
  }
  const skipped: Array<Parameters<typeof cycleFixture>[0]> = [
    { verify: {} },
    { verifyCmd: {}, verify: { test: "passed" } },
    { verify: { test: "passed", plan: "failed" } },
    { verify: { test: "pending" } },
    { done: ["plan", "test"] },
  ];
  for (const options of skipped) {
    const fixture = cycleFixture(options);
    try {
      assert.deepEqual(evaluateSkillGate(fixture.cycle), { ok: false, reason: NO_DETERMINISTIC_GATE }, JSON.stringify(options));
    } finally {
      fixture.cleanup();
    }
  }
  const partial = cycleFixture({ done: ["plan"] });
  try {
    assert.equal(isFlowComplete(partial.cycle), false);
    assert.equal(isFlowComplete(join(partial.cycle, "no-existe")), false);
  } finally {
    partial.cleanup();
  }
});

test("readOfferedSkills lee el índice registrado en launch.json y formatOfferedSkills lo resume", () => {
  const cycle = mkdtempSync(join(tmpdir(), "ronin-skill-offered-"));
  try {
    assert.deepEqual(readOfferedSkills(cycle), []);
    writeFileSync(join(cycle, "launch.json"), JSON.stringify({ repo: "acme-api", skills: [{ root: "learned", name: "migracion-reversible", hash: "sha256:a" }, { root: "global", hash: "x" }, "basura"] }));
    const offered = readOfferedSkills(cycle);
    assert.deepEqual(offered, [{ root: "learned", name: "migracion-reversible", hash: "sha256:a" }]);
    assert.equal(formatOfferedSkills(offered), "- migracion-reversible (learned)");
    assert.equal(formatOfferedSkills([]), "(ninguna)");
  } finally {
    rmSync(cycle, { recursive: true, force: true });
  }
});

test("buildSkillDraftPrompt rellena la plantilla skill, con valores por defecto para la redacción manual", () => {
  const input = { repo: "acme-api", session: "cowork-mig", request: "agrega la migración", evidence: "### evidence/summary.md\nlisto", summary: TRIAGE.summary, catalog: "(vacío)", current: null };
  assert.equal(
    buildSkillDraftPrompt(input, "{repo}|{session}|{summary}|{request}|{evidence}|{catalog}|{current}"),
    `acme-api|cowork-mig|${TRIAGE.summary}|agrega la migración|### evidence/summary.md\nlisto|(vacío)|(ninguna: es una skill nueva)`,
  );
  const manual = buildSkillDraftPrompt({ ...input, summary: " ", request: "", evidence: "", current: "---\nname: x\n---\n" }, "{summary}|{request}|{evidence}|{current}");
  assert.equal(manual, `${MANUAL_SUMMARY}|(sin petición registrada)|(sin evidencia)|---\nname: x\n---\n`);
  assert.doesNotMatch(buildSkillDraftPrompt(input, DEFAULT_PROMPTS.skill), /\{(repo|session|summary|request|evidence|catalog|current)\}/);
});

test("parseSkillDraft acepta el borrador o un skip y rechaza lo que no cumple el esquema", () => {
  assert.deepEqual(parseSkillDraft('```json\n{"name":"migracion-reversible","description":"Migra.","body":"1. Paso.","changes":"Agrega rollback"}\n```'), {
    kind: "draft", name: "migracion-reversible", description: "Migra.", body: "1. Paso.", changes: "Agrega rollback",
  });
  assert.deepEqual(parseSkillDraft('{"name":"x","description":"d","body":"b"}'), { kind: "draft", name: "x", description: "d", body: "b", changes: "" });
  assert.deepEqual(parseSkillDraft('{"skip":"no es reutilizable"}'), { kind: "skip", reason: "no es reutilizable" });
  const cases: Array<[string, RegExp]> = [
    ["nada", /no contiene JSON/],
    ["[1]", /no contiene JSON|se esperaba un objeto/],
    ['{"description":"d","body":"b"}', /name/],
    [JSON.stringify({ name: "x", description: "d".repeat(1025), body: "b" }), /description debe tener de 1 a 1024/],
    [JSON.stringify({ name: "x", description: "d", body: "  " }), /body no puede estar vacío/],
    [JSON.stringify({ name: "x", description: "d", body: "b", changes: 3 }), /changes debe ser texto/],
  ];
  for (const [output, error] of cases) assert.throws(() => parseSkillDraft(output), error, output);
});
