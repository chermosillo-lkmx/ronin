import assert from "node:assert/strict";
import test from "node:test";
import * as harnessControls from "./harness-controls.js";
import { bands, controlPatch, coverage, instructionControls, isPersistable, pendingDiscards, stageControls } from "./harness-controls.js";

test("1 stageControls mapea cuatro controles togglables a sus ejes sin maxRetries", () => {
  const controls = stageControls({ key: "plan", label: "Plan", icon: "📋" }, [], true)
    .filter((control) => control.source === "field")
    .map(({ id, axis, kind }) => ({ id, axis, kind }));

  assert.deepEqual(controls, [
    { id: "instruction", axis: "guide", kind: "inferential" },
    { id: "executor", axis: "guide", kind: "deterministic" },
    { id: "verifyCmd", axis: "sensor", kind: "deterministic" },
    { id: "verifier", axis: "sensor", kind: "inferential" },
  ]);
  assert.equal(controls.some((control) => control.id === "maxRetries"), false);
});

test("2 el workflow global deshabilita verifyCmd y su maxRetries con motivo", () => {
  const verify = stageControls(
    { key: "test", label: "Test", icon: "🧪", verifyCmd: "npm test", maxRetries: 3 },
    [],
    false,
  ).find((control) => control.id === "verifyCmd");

  assert.equal(verify?.on, false);
  assert.equal(verify?.disabled, true);
  assert.match(verify?.disabledReason ?? "", /override por-repo.*gitignore/i);
});

test("3 apagar verifyCmd borra maxRetries en cascada y stashea ambos", () => {
  const result = controlPatch(
    { key: "test", label: "Test", icon: "🧪", verifyCmd: "npm test", maxRetries: 0 },
    "verifyCmd",
    false,
    {},
  );

  assert.deepEqual(result.patch, { verifyCmd: undefined, maxRetries: undefined });
  assert.deepEqual(result.stash, { verifyCmd: "npm test", maxRetries: 0 });
});

test("4 apagar executor borra model a la vez y stashea ambos", () => {
  const result = controlPatch(
    { key: "impl", label: "Impl", icon: "⌨️", executor: "codex", model: "gpt-5" },
    "executor",
    false,
    {},
  );

  assert.deepEqual(result.patch, { executor: undefined, model: undefined });
  assert.deepEqual(result.stash, { executor: "codex", model: "gpt-5" });
});

test("5 apagar instruction escribe cadena vacía y stashea el texto", () => {
  const result = controlPatch(
    { key: "plan", label: "Plan", icon: "📋", instruction: "Escribe el plan" },
    "instruction",
    false,
    {},
  );

  assert.deepEqual(result.patch, { instruction: "" });
  assert.deepEqual(result.stash, { instruction: "Escribe el plan" });
});

test("6 el verificador por inclusión permite A y B encendidos", () => {
  const stageA = { key: "a", label: "A", icon: "A" };
  const stageB = { key: "b", label: "B", icon: "B" };
  const verifierA = stageControls(stageA, ["a", "b"], true).find((control) => control.id === "verifier");
  const verifierB = stageControls(stageB, ["a", "b"], true).find((control) => control.id === "verifier");

  assert.equal(verifierA?.on, true);
  assert.equal(verifierB?.on, true);
});

test("7 coverage cuenta gates deterministas, guarda 0/0 y usa sus cuatro tramos", () => {
  assert.deepEqual(coverage([]), {
    covered: 0,
    total: 0,
    note: "Ninguna etapa deja evidencia verificable: el loop entero corre sobre lo que el agente dice de sí mismo.",
  });

  const base = ["a", "b", "c", "d"].map((key) => ({ key, label: key.toUpperCase(), icon: key }));
  const notes = [
    "Ninguna etapa deja evidencia verificable: el loop entero corre sobre lo que el agente dice de sí mismo.",
    "Una sola etapa deja artefacto. Todo lo demás es autoreporte.",
    "Las demás etapas se apoyan en texto. Sólo donde hay artefacto hay evidencia.",
    "Tres o más etapas dejan artefacto: el avance deja de depender de lo que el agente afirma.",
  ];

  for (let active = 0; active < notes.length; active++) {
    const stages = base.map((stage, index) => index < active ? { ...stage, verifyCmd: "npm test" } : stage);
    assert.deepEqual(coverage(stages), { covered: active, total: 4, note: notes[active] });
  }
});

test("8 bands conserva las cuatro bandas por control y sus cuentas mixtas", () => {
  const result = bands([
    { key: "a", label: "A", icon: "A", instruction: "Haz A", verifyCmd: "npm test" },
    { key: "b", label: "B", icon: "B", executor: "codex" },
  ], ["b"], true);

  assert.deepEqual(result.map(({ id, label, note }) => ({ id, label, note })), [
    { id: "gates", label: "Gate por comando", note: "exit code manda antes de avanzar" },
    { id: "verifiers", label: "Revisión por modelo", note: "un modelo juzga después del hecho" },
    { id: "instruction", label: "Instrucción", note: "qué debe hacer cada etapa" },
    { id: "executor", label: "Ejecutor fijo", note: "qué herramienta ejecuta cada etapa" },
  ]);
  assert.deepEqual(result.map(({ active, total, mixed }) => ({ active, total, mixed })), [
    { active: 1, total: 2, mixed: true },
    { active: 1, total: 2, mixed: true },
    { active: 1, total: 2, mixed: true },
    { active: 1, total: 2, mixed: true },
  ]);
});

test("B1a isPersistable rechaza comandos e instrucciones vacías y executor heredado", () => {
  assert.equal(isPersistable({ id: "verifyCmd", verifyCmd: "  " }), false);
  assert.equal(isPersistable({ id: "instruction", instruction: "" }), false);
  assert.equal(isPersistable({ id: "executor", executor: undefined }), false);
});

test("13 pendingDiscards lista pérdidas vivas y omite entradas huérfanas", () => {
  const result = pendingDiscards([
    { key: "plan", label: "Plan", icon: "📋", instruction: "" },
    { key: "test", label: "Test", icon: "🧪" },
    { key: "live", label: "Live", icon: "✓", executor: "codex" },
  ], {
    plan: { instruction: "Escribe el plan" },
    test: { verifyCmd: "npm test", maxRetries: 2 },
    live: { executor: "agy" },
    deleted: { instruction: "huérfano" },
  });

  assert.deepEqual(result, [
    { stageKey: "plan", id: "instruction" },
    { stageKey: "test", id: "verifyCmd" },
  ]);
});

test("17 instructionControls aplica la tabla de patrones y omite texto sin coincidencias", () => {
  const controls = instructionControls(
    "Publica JUNIT, cobertura y REPORTAR_PRUEBAS; consulta plan.md y deja {EV}.",
  );

  assert.deepEqual(controls.map(({ id, axis, kind }) => ({ id, axis, kind })), [
    { id: "junit.xml", axis: "sensor", kind: "deterministic" },
    { id: "coverage.xml", axis: "sensor", kind: "deterministic" },
    { id: "ingesta", axis: "sensor", kind: "deterministic" },
    { id: "plan.md", axis: "guide", kind: "inferential" },
    { id: "evidencia", axis: "guide", kind: "inferential" },
  ]);
  assert.deepEqual(instructionControls("Implementa y revisa el resultado."), []);
});

test("18 los chips de prosa son inertes y no mueven coverage", () => {
  const prose = instructionControls("Genera junit y coverage");

  assert.equal(prose.every((control) => control.source === "instruction" && control.disabled), true);
  assert.deepEqual(coverage([
    { key: "test", label: "Test", icon: "🧪", instruction: "Genera junit y coverage" },
  ]), {
    covered: 0,
    total: 1,
    note: "Ninguna etapa deja evidencia verificable: el loop entero corre sobre lo que el agente dice de sí mismo.",
  });
});

test("executor claude sin modelo advierte que no cambia el prompt", () => {
  const executor = stageControls(
    { key: "impl", label: "Impl", icon: "⌨️", executor: "claude" },
    [],
    true,
  ).find((control) => control.id === "executor");

  assert.match(executor?.warning ?? "", /igual que heredar: no cambia el prompt/i);
});

test("stageIdentityReason bloquea ambas etapas con key duplicada usando id estable y etiqueta aparte", () => {
  const stages = [
    { key: "tests", label: "Pruebas A", icon: "A" },
    { key: "tests", label: "Pruebas B", icon: "B" },
  ];

  const stageIdentityReason = (harnessControls as { stageIdentityReason?: (value: typeof stages, index: number) => unknown }).stageIdentityReason;
  assert.equal(typeof stageIdentityReason, "function");
  assert.deepEqual(stageIdentityReason?.(stages, 0), {
    id: "duplicate-key",
    label: "Esta key identifica más de una etapa; corrígela antes de configurar su harness.",
  });
  assert.deepEqual(stageIdentityReason?.(stages, 1), {
    id: "duplicate-key",
    label: "Esta key identifica más de una etapa; corrígela antes de configurar su harness.",
  });
  assert.deepEqual(stageIdentityReason?.([{ key: "", label: "Nueva", icon: "+" }], 0), {
    id: "empty-key",
    label: "Esta etapa necesita una key antes de configurar su harness.",
  });
  assert.equal(stageIdentityReason?.([{ key: "plan", label: "Plan", icon: "P" }], 0), null);
});

test("RETRY-1 maxRetries vacío usa default y cero explícito se conserva", () => {
  const parseMaxRetriesInput = (harnessControls as {
    parseMaxRetriesInput?: (value: string) => number | undefined;
  }).parseMaxRetriesInput;

  assert.equal(typeof parseMaxRetriesInput, "function");
  assert.equal(parseMaxRetriesInput?.(""), undefined);
  assert.equal(parseMaxRetriesInput?.("0"), 0);
  assert.equal(parseMaxRetriesInput?.("3"), 3);
});

test("B1 v2: las bandas corresponden uno-a-uno con controles y cuentan etapas", () => {
  const result = bands([
    { key: "a", label: "A", icon: "A", instruction: "Haz A", verifyCmd: "npm test" },
    { key: "b", label: "B", icon: "B", executor: "codex" },
  ], ["b"] as any, true);

  assert.deepEqual(result.map(({ id, label, active, total }) => ({ id, label, active, total })), [
    { id: "gates", label: "Gate por comando", active: 1, total: 2 },
    { id: "verifiers", label: "Revisión por modelo", active: 1, total: 2 },
    { id: "instruction", label: "Instrucción", active: 1, total: 2 },
    { id: "executor", label: "Ejecutor fijo", active: 1, total: 2 },
  ]);
});

test("B1 v2: verifier usa inclusión y permite dos etapas encendidas", () => {
  const selected = ["a", "b"] as any;
  assert.equal(stageControls({ key: "a", label: "A", icon: "A" }, selected, true)
    .find((control) => control.id === "verifier")?.on, true);
  assert.equal(stageControls({ key: "b", label: "B", icon: "B" }, selected, true)
    .find((control) => control.id === "verifier")?.on, true);
});

test("B1 v2: coverage conserva los cuatro tramos 0, 1, 2 y 3+", () => {
  const stages = ["a", "b", "c", "d"].map((key, index) => ({
    key,
    label: key,
    icon: key,
    ...(index < 3 ? { verifyCmd: "npm test" } : {}),
  }));
  assert.equal(coverage([]).note.includes("Ninguna"), true);
  assert.equal(coverage(stages.slice(0, 1)).note.includes("Una sola"), true);
  assert.equal(coverage(stages.slice(0, 2)).note.includes("demás etapas"), true);
  assert.equal(coverage(stages).note.includes("Tres o más"), true);
});
