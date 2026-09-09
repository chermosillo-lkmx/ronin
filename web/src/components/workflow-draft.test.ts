import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptServerConfig,
  cancel,
  createWorkflowDraft,
  createWorkflowWorkspaceDraft,
  deriveGraph,
  editControlValue,
  insertStageAt,
  setFieldError,
  setJsonText,
  setStages,
  switchView,
  toggleHarnessControl,
  toggleHarnessSection,
} from "./workflow-draft.js";
import type { WfStage, WorkflowConfig } from "../types.js";
import { bands, coverage, pendingDiscards, stageControls } from "./harness-controls.js";
import { workflowPayload } from "./workflow-save.js";

const CFG: WorkflowConfig = {
  stages: [
    { key: "planning", label: "Plan", icon: "📋" },
    { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
  ],
  verifyAfter: null,
};

test("T14.108 createWorkflowDraft + setStages: editar en Stepper y cambiar a JSON muestra lo EDITADO, no lo guardado", () => {
  const draft = createWorkflowDraft(CFG);
  const edited: WfStage[] = [...CFG.stages, { key: "curl", label: "Curl", icon: "🌐" }];
  const next = setStages(draft, edited, draft.verifyAfter);
  const json = JSON.parse(next.jsonText);
  assert.deepEqual(json.stages.map((s: WfStage) => s.key), ["planning", "implementing", "curl"]);
  // el "saved" original queda intacto — nada se persistió
  assert.deepEqual(next.saved, CFG);
});

test("WorkflowWorkspace crea el borrador inicial en Grafo y conserva la vista elegida", () => {
  assert.equal(createWorkflowWorkspaceDraft(CFG).view, "graph");
  assert.equal(createWorkflowWorkspaceDraft(CFG, "json").view, "json");
});

test("insertStageAt agrega una etapa nueva al final sin mutar el arreglo de origen", () => {
  const source: WfStage[] = [{ key: "plan", label: "Plan", icon: "📋" }];
  const next = insertStageAt(source, source.length);

  assert.deepEqual(next, [
    source[0],
    { key: "", label: "Nueva etapa", icon: "•", instruction: "" },
  ]);
  assert.deepEqual(source, [{ key: "plan", label: "Plan", icon: "📋" }]);
  assert.notEqual(next, source);
});

test("insertStageAt inserta la etapa nueva en el índice indicado", () => {
  const source: WfStage[] = [
    { key: "plan", label: "Plan", icon: "📋" },
    { key: "impl", label: "Implementar", icon: "⌨️" },
  ];

  const next = insertStageAt(source, 1);

  assert.deepEqual(next.map((stage) => stage.key), ["plan", "", "impl"]);
  assert.deepEqual(next[1], { key: "", label: "Nueva etapa", icon: "•", instruction: "" });
});

test("T14.109 setJsonText: editar en JSON y cambiar a Grafo muestra lo editado; JSON inválido NO contamina el borrador estructurado", () => {
  const draft = createWorkflowDraft(CFG);
  const validEdit = JSON.stringify({ stages: [{ key: "solo", label: "Solo", icon: "x" }], verifyAfter: null });
  const afterValid = setJsonText(draft, validEdit);
  assert.deepEqual(afterValid.stages.map((s) => s.key), ["solo"]);
  assert.equal(afterValid.jsonError, null);

  const afterInvalid = setJsonText(afterValid, "{ esto no es json");
  assert.notEqual(afterInvalid.jsonError, null);
  // el borrador ESTRUCTURADO (Stepper/Grafo) sigue mostrando el último edit VÁLIDO — "solo" —
  // nunca se contamina con el JSON roto.
  assert.deepEqual(afterInvalid.stages.map((s) => s.key), ["solo"]);
});

test("D4 (bloqueante, hallado en review): JSON sintácticamente válido pero de forma inválida ({}) NO sustituye stages/verifyAfter en silencio, y jsonError queda seteado (Guardar deshabilitado)", () => {
  const draft = createWorkflowDraft(CFG); // CFG.verifyAfter es null; probamos con "curl" para distinguir de un default casual
  const withVerify = setStages(draft, CFG.stages, "implementing");
  const shapeInvalid = setJsonText(withVerify, "{}");
  // NO debe "colarse" como un config distinto y guardable: stages/verifyAfter quedan EXACTAMENTE
  // como estaban (mismos valores, no sustituidos por defaults silenciosos).
  assert.deepEqual(shapeInvalid.stages, withVerify.stages);
  assert.equal(shapeInvalid.verifyAfter, "implementing");
  // Y el borrador queda marcado como no-guardable — el mismo gate que un error de sintaxis.
  assert.ok(shapeInvalid.jsonError, "un JSON de forma inválida debe bloquear Guardar igual que uno con sintaxis rota");
  assert.match(shapeInvalid.jsonError!.message, /stages/i);
});

test("D4: JSON con verifyAfter de un tipo inválido (no string, no null) también es un error de forma, no se sustituye por null en silencio", () => {
  const draft = createWorkflowDraft(CFG);
  const withVerify = setStages(draft, CFG.stages, "implementing");
  const shapeInvalid = setJsonText(withVerify, JSON.stringify({ stages: CFG.stages, verifyAfter: 42 }));
  assert.equal(shapeInvalid.verifyAfter, "implementing"); // NO se convirtió en null
  assert.ok(shapeInvalid.jsonError);
});

test("NEW-1 (major, hallado en review 2): stages[i] anidada inválida ({}) también bloquea Guardar, no sólo la forma de primer nivel", () => {
  const draft = createWorkflowDraft(CFG);
  const withVerify = setStages(draft, CFG.stages, "implementing");
  const nestedInvalid = setJsonText(withVerify, JSON.stringify({ stages: [{}], verifyAfter: null }));
  // El primer nivel (stages es array, verifyAfter es null) pasa — pero la etapa ADENTRO no
  // tiene key/label/icon: debe bloquear igual, sin sustituir el borrador estructurado.
  assert.deepEqual(nestedInvalid.stages, withVerify.stages);
  assert.equal(nestedInvalid.verifyAfter, "implementing");
  assert.ok(nestedInvalid.jsonError, "una etapa anidada sin key/label/icon debe bloquear Guardar");
  assert.match(nestedInvalid.jsonError!.path ?? "", /stages\[0\]/);
});

test("NEW-1: un role/verifyCmd/maxRetries de tipo incorrecto en una etapa anidada también bloquea Guardar", () => {
  const draft = createWorkflowDraft(CFG);
  const badRole = setJsonText(
    draft,
    JSON.stringify({ stages: [{ key: "a", label: "A", icon: "x", role: "admin" }], verifyAfter: null })
  );
  assert.ok(badRole.jsonError);
  const badMaxRetries = setJsonText(
    draft,
    JSON.stringify({ stages: [{ key: "a", label: "A", icon: "x", maxRetries: "3" }], verifyAfter: null })
  );
  assert.ok(badMaxRetries.jsonError);
});

test("T14.110 cancel(): restaura el último config GUARDADO sin llamar a la API", () => {
  const draft = createWorkflowDraft(CFG);
  const edited = setStages(draft, [{ key: "changed", label: "Changed", icon: "x" }], null);
  assert.notDeepEqual(edited.stages, CFG.stages);
  const cancelled = cancel(edited);
  assert.deepEqual(cancelled.stages, CFG.stages);
  assert.deepEqual(cancelled.verifyAfter, CFG.verifyAfter);
  assert.equal(JSON.parse(cancelled.jsonText).stages.length, CFG.stages.length);
});

test("B4a cancel(): restaura inputs desde el config guardado", () => {
  const saved = {
    ...CFG,
    inputs: [{ key: "ticket", label: "Ticket" }],
  } as WorkflowConfig;
  const draft = createWorkflowDraft(saved);
  const edited = setJsonText(draft, JSON.stringify({
    stages: CFG.stages,
    verifyAfter: null,
    inputs: [{ key: "issue", label: "Issue" }],
  }));
  assert.deepEqual((edited as any).inputs, [{ key: "issue", label: "Issue" }]);

  const cancelled = cancel(edited);

  assert.deepEqual((cancelled as any).inputs, [{ key: "ticket", label: "Ticket" }]);
});

test("24 inputs sobrevive el round-trip y permanece ausente cuando no existe", () => {
  const withInputs = createWorkflowDraft({
    ...CFG,
    inputs: [{ key: "ticket", label: "Ticket" }],
  });
  assert.deepEqual(JSON.parse(withInputs.jsonText).inputs, [{ key: "ticket", label: "Ticket" }]);
  assert.deepEqual(setJsonText(withInputs, withInputs.jsonText).inputs, [{ key: "ticket", label: "Ticket" }]);

  const withoutInputs = createWorkflowDraft(CFG);
  assert.equal("inputs" in JSON.parse(withoutInputs.jsonText), false);
});

test("INPUT-1 inputs con forma inválida bloquea Guardar y preserva el draft estructurado", () => {
  const draft = createWorkflowDraft({
    ...CFG,
    inputs: [{ key: "ticket", label: "Ticket" }],
  });
  const malformed = JSON.stringify({
    stages: CFG.stages,
    verifyAfter: null,
    inputs: { key: "issue", label: "Issue" },
  });

  const next = setJsonText(draft, malformed);

  assert.deepEqual(next.inputs, [{ key: "ticket", label: "Ticket" }]);
  assert.deepEqual(next.stages, draft.stages);
  assert.equal(next.jsonError?.path, "inputs");
  assert.match(next.jsonError?.message ?? "", /inputs.*array/i);
});

test("T14.111 setJsonText: sintaxis inválida reporta línea y columna, y el borrador queda con jsonError (aplicar deshabilitado)", () => {
  const draft = createWorkflowDraft(CFG);
  const broken = '{\n  "stages": [\n    { "key": "x" broken }\n  ]\n}';
  const next = setJsonText(draft, broken);
  assert.ok(next.jsonError);
  assert.equal(typeof next.jsonError!.line, "number");
  assert.equal(typeof next.jsonError!.column, "number");
  assert.ok(next.jsonError!.line! >= 1);
  assert.ok(next.jsonError!.column! >= 1);
});

test("T14.112 setFieldError: un error semántico se atribuye a una ruta de campo (stages[2].key)", () => {
  const draft = createWorkflowDraft(CFG);
  const next = setFieldError(draft, { path: "stages[2].key", code: "DUPLICATE_KEY", message: 'la key "x" ya está usada' });
  assert.deepEqual(next.fieldError, { path: "stages[2].key", code: "DUPLICATE_KEY", message: 'la key "x" ya está usada' });
  // editar de nuevo limpia el error semántico obsoleto
  const edited = setStages(next, CFG.stages, null);
  assert.equal(edited.fieldError, null);
});

test("T14.114 adoptServerConfig: tras guardar, el borrador adopta el config DEVUELTO POR EL SERVIDOR, no el local", () => {
  const draft = createWorkflowDraft(CFG);
  const editedLocally = setStages(draft, [{ key: "  Local Edit  " as any, label: "x", icon: "x" }], null);
  const serverNormalized: WorkflowConfig = {
    stages: [{ key: "local-edit", label: "Local Edit", icon: "x" }], // normalizado por el servidor (T11, sólo trim)
    verifyAfter: null,
  };
  const next = adoptServerConfig(editedLocally, serverNormalized);
  assert.deepEqual(next.saved, serverNormalized);
  assert.deepEqual(next.stages, serverNormalized.stages);
  assert.deepEqual(JSON.parse(next.jsonText), serverNormalized);
  assert.equal(next.fieldError, null);
  assert.equal(next.jsonError, null);
});

test("deriveGraph: nodos + aristas de secuencia, bifurcación de verify, y self-loop de retry con gate marcado (paridad con toGraph del servidor, T12)", () => {
  const stages: WfStage[] = [
    { key: "a", label: "A", icon: "a" },
    { key: "b", label: "B", icon: "b", role: "impl" },
    { key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test" },
  ];
  const g = deriveGraph(stages, "b");
  assert.deepEqual(g.nodes.map((n) => n.key), ["a", "b", "curl", "verify"]);
  assert.equal(g.nodes.find((n) => n.key === "b")?.role, "impl");
  assert.equal(g.nodes.find((n) => n.key === "curl")?.gate, true);
  const seq = g.edges.filter((e) => e.kind === "sequence");
  assert.deepEqual(seq.map((e) => [e.from, e.to]), [["a", "b"], ["b", "curl"]]);
  assert.deepEqual(g.edges.find((e) => e.kind === "verify"), { from: "b", to: "verify", kind: "verify" });
  assert.deepEqual(g.edges.find((e) => e.kind === "retry"), { from: "curl", to: "curl", kind: "retry" });
});

test("switchView: sólo cambia la vista mostrada, no muta datos", () => {
  const draft = createWorkflowDraft(CFG);
  const next = switchView(draft, "json");
  assert.equal(next.view, "json");
  assert.deepEqual(next.stages, draft.stages);
});

test("B1b verifyCmd sin stash queda armando sin escribir campo ni mover coverage", () => {
  const draft = createWorkflowDraft(CFG);
  const before = coverage(draft.stages);

  const next = toggleHarnessControl(draft, "planning", "verifyCmd", true, true);

  assert.deepEqual((next as any).arming, { stageKey: "planning", id: "verifyCmd" });
  assert.equal(next.stages[0].verifyCmd, undefined);
  assert.deepEqual(coverage(next.stages), before);
});

test("B1c editar verifyCmd armado persiste comando, default de reintentos y queda ON", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "verifyCmd", true, true);

  const next = editControlValue(armed, "planning", { id: "verifyCmd", verifyCmd: "npm test" });
  const stage = next.stages[0];
  const control = stageControls(stage, next.verifyAfter, true).find((item) => item.id === "verifyCmd");

  assert.equal(stage.verifyCmd, "npm test");
  assert.equal(stage.maxRetries, 2);
  assert.deepEqual(next.stash.planning, { verifyCmd: "npm test", maxRetries: 2 });
  assert.equal(control?.on, true);
  assert.equal(next.arming, null);
});

test("B1d editar verifyCmd a vacío borra el campo y devuelve el control a OFF", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "test", label: "Test", icon: "🧪", verifyCmd: "npm test", maxRetries: 2 }],
    verifyAfter: null,
  });

  const next = editControlValue(draft, "test", { id: "verifyCmd", verifyCmd: "  " });
  const control = stageControls(next.stages[0], next.verifyAfter, true).find((item) => item.id === "verifyCmd");

  assert.equal(next.stages[0].verifyCmd, undefined);
  assert.equal(next.stages[0].maxRetries, undefined);
  assert.equal(control?.on, false);
});

test("B1e executor frío arma, codex persiste y hereda borra executor con model", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "executor", true, true);
  assert.deepEqual(armed.arming, { stageKey: "planning", id: "executor" });

  const selected = editControlValue(armed, "planning", { id: "executor", executor: "codex", model: "gpt-5" });
  assert.equal(selected.stages[0].executor, "codex");
  assert.equal(selected.stages[0].model, "gpt-5");

  const inherited = editControlValue(selected, "planning", { id: "executor", executor: undefined });
  assert.equal(inherited.stages[0].executor, undefined);
  assert.equal(inherited.stages[0].model, undefined);
});

test("B1f instruction fría queda armando sin escribir texto", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "plan", label: "Plan", icon: "📋", instruction: "" }],
    verifyAfter: null,
  });

  const next = toggleHarnessControl(draft, "plan", "instruction", true, true);

  assert.deepEqual(next.arming, { stageKey: "plan", id: "instruction" });
  assert.equal(next.stages[0].instruction, "");
});

test("B1f2 editar instruction armada persiste texto y deja el control ON", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "instruction", true, true);
  const next = editControlValue(armed, "planning", { id: "instruction", instruction: "Escribe el plan" });
  const control = stageControls(next.stages[0], next.verifyAfter, true).find((item) => item.id === "instruction");

  assert.equal(next.stages[0].instruction, "Escribe el plan");
  assert.equal(control?.on, true);
  assert.equal(next.arming, null);
});

test("M6a maxRetries cero exacto sobrevive etapa, stash y payload", () => {
  const next = editControlValue(createWorkflowDraft(CFG), "planning", {
    id: "verifyCmd",
    verifyCmd: "npm test",
    maxRetries: 0,
  });

  assert.equal(next.stages[0].maxRetries, 0);
  assert.equal(next.stash.planning.maxRetries, 0);
  assert.equal(workflowPayload(next).stages[0].maxRetries, 0);
});

test("M5a renombrar una etapa mientras arma conserva abierto el editor en la key nueva", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "executor", true, true);
  const renamedStages = armed.stages.map((stage, index) => index === 0 ? { ...stage, key: "plan" } : stage);

  const next = setStages(armed, renamedStages, armed.verifyAfter);

  assert.deepEqual(next.arming, { stageKey: "plan", id: "executor" });
});

test("M5b borrar la etapa armada limpia arming y recrear su key no reabre el editor", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "executor", true, true);
  const afterDelete = setStages(armed, armed.stages.slice(1), armed.verifyAfter);
  const afterRecreate = setStages(afterDelete, [
    { key: "planning", label: "Nueva", icon: "N" },
    ...afterDelete.stages,
  ], afterDelete.verifyAfter);

  assert.equal(afterDelete.arming, null);
  assert.equal(afterRecreate.arming, null);
});

test("B1g el verificador enciende directo sin pasar por arming", () => {
  const draft = createWorkflowDraft(CFG);

  const next = toggleHarnessControl(draft, "implementing", "verifier", true, true);

  assert.equal(next.verifyAfter, "implementing");
  assert.equal(next.arming, null);
  assert.equal(stageControls(next.stages[0], next.verifyAfter, true).find((item) => item.id === "verifier")?.on, false);
  assert.equal(stageControls(next.stages[1], next.verifyAfter, true).find((item) => item.id === "verifier")?.on, true);
});

test("9 encender con stash restaura el valor y queda ON sin arming", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "plan", label: "Plan", icon: "📋", instruction: "" }],
    verifyAfter: null,
  });
  const withStash = { ...draft, stash: { plan: { instruction: "Escribe el plan" } } };

  const next = toggleHarnessControl(withStash, "plan", "instruction", true, true);

  assert.equal(next.stages[0].instruction, "Escribe el plan");
  assert.equal(next.arming, null);
  assert.equal(stageControls(next.stages[0], next.verifyAfter, true).find((item) => item.id === "instruction")?.on, true);
});

test("10 stash y arming nunca aparecen en jsonText", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "instruction", true, true);
  const withStash = { ...armed, stash: { planning: { instruction: "secreto local" } } };
  const json = JSON.parse(setStages(withStash, withStash.stages, withStash.verifyAfter).jsonText);

  assert.equal("stash" in json, false);
  assert.equal("arming" in json, false);
  assert.equal(JSON.stringify(json).includes("secreto local"), false);
});

test("11 el stash sobrevive switchView", () => {
  const draft = createWorkflowDraft(CFG);
  const withStash = { ...draft, stash: { planning: { instruction: "Escribe el plan" } } };

  assert.deepEqual(switchView(withStash, "json").stash, withStash.stash);
});

test("12 cancel, setJsonText y adoptServerConfig limpian stash y arming", () => {
  const armed = toggleHarnessControl(createWorkflowDraft(CFG), "planning", "instruction", true, true);
  const local = { ...armed, stash: { planning: { instruction: "Escribe el plan" } } };
  const replacement = JSON.stringify({ stages: CFG.stages, verifyAfter: null });

  for (const next of [
    cancel(local),
    setJsonText(local, replacement),
    adoptServerConfig(local, CFG),
  ]) {
    assert.deepEqual(next.stash, {});
    assert.equal(next.arming, null);
  }
});

test("B3a apagar instruction, renombrar su etapa y encender restaura el texto", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "planning", label: "Plan", icon: "📋", instruction: "Escribe el plan" }],
    verifyAfter: null,
  });

  const off = toggleHarnessControl(draft, "planning", "instruction", false, true);
  assert.equal(off.stages[0].instruction, "");
  const renamed = setStages(off, [{ ...off.stages[0], key: "plan" }], null);
  assert.equal(renamed.stash.planning, undefined);
  assert.equal(renamed.stash.plan?.instruction, "Escribe el plan");
  const restored = toggleHarnessControl(renamed, "plan", "instruction", true, true);

  assert.equal(restored.stages[0].instruction, "Escribe el plan");
});

test("B3b reordenar etapas no migra ni pierde entradas del stash", () => {
  const draft = createWorkflowDraft(CFG);
  const withStash = {
    ...draft,
    stash: {
      planning: { instruction: "Plan" },
      implementing: { executor: "codex" as const },
    },
  };

  const next = setStages(withStash, [...withStash.stages].reverse(), null);

  assert.deepEqual(next.stash, withStash.stash);
});

test("B3c borrar una etapa poda su stash y pendingDiscards no la menciona", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "plan", label: "Plan", icon: "📋", instruction: "Texto" }],
    verifyAfter: null,
  });
  const off = toggleHarnessControl(draft, "plan", "instruction", false, true);

  const next = setStages(off, [], null);

  assert.deepEqual(next.stash, {});
  assert.deepEqual(pendingDiscards(next.stages, next.stash), []);
});

test("M2a apagar Guías borra y stashea instruction/executor en todas las etapas", () => {
  const draft = createWorkflowDraft({
    stages: [
      { key: "a", label: "A", icon: "A", instruction: "Haz A", executor: "codex", model: "gpt-5" },
      { key: "b", label: "B", icon: "B", instruction: "Haz B", executor: "agy" },
    ],
    verifyAfter: null,
  });

  const next = toggleHarnessSection(draft, "guides", false, true);

  assert.deepEqual(next.stages.map(({ instruction, executor, model }) => ({ instruction, executor, model })), [
    { instruction: "", executor: undefined, model: undefined },
    { instruction: "", executor: undefined, model: undefined },
  ]);
  assert.deepEqual(next.stash, {
    a: { instruction: "Haz A", executor: "codex", model: "gpt-5" },
    b: { instruction: "Haz B", executor: "agy" },
  });
});

test("M2b encender Guías sólo restaura etapas con stash y no inventa ON", () => {
  const draft = createWorkflowDraft({
    stages: [
      { key: "a", label: "A", icon: "A", instruction: "" },
      { key: "b", label: "B", icon: "B", instruction: "" },
    ],
    verifyAfter: null,
  });
  const withStash = {
    ...draft,
    stash: { a: { instruction: "Haz A", executor: "codex" as const } },
  };

  const next = toggleHarnessSection(withStash, "guides", true, true);

  assert.equal(next.stages[0].instruction, "Haz A");
  assert.equal(next.stages[0].executor, "codex");
  assert.equal(next.stages[1].instruction, "");
  assert.equal(next.stages[1].executor, undefined);
  assert.equal(next.arming, null);
});

test("M2c banda inerte no transiciona y banda inferencial restaura un único verifier", () => {
  const draft = createWorkflowDraft({
    stages: [
      { key: "a", label: "A", icon: "A" },
      { key: "b", label: "B", icon: "B" },
    ],
    verifyAfter: "b",
  });

  assert.equal(toggleHarnessSection(draft, "deterministic-sensors", false, true), draft);
  const off = toggleHarnessSection(draft, "inferential-sensors", false, true);
  assert.equal(off.verifyAfter, null);
  assert.deepEqual(off.stash.b, { verifier: true });
  const restored = toggleHarnessSection(off, "inferential-sensors", true, true);
  assert.equal(restored.verifyAfter, "b");
});

test("M2 Gates de avance apaga y restaura comandos stasheados en bloque", () => {
  const draft = createWorkflowDraft({
    stages: [
      { key: "a", label: "A", icon: "A", verifyCmd: "npm test", maxRetries: 0 },
      { key: "b", label: "B", icon: "B", verifyCmd: "npm run lint", maxRetries: 2 },
    ],
    verifyAfter: null,
  });

  const off = toggleHarnessSection(draft, "gates", false, true);
  assert.deepEqual(off.stages.map((stage) => stage.verifyCmd), [undefined, undefined]);
  assert.equal(off.stash.a.verifyCmd, "npm test");
  const restored = toggleHarnessSection(off, "gates", true, true);

  assert.deepEqual(restored.stages.map(({ verifyCmd, maxRetries }) => ({ verifyCmd, maxRetries })), [
    { verifyCmd: "npm test", maxRetries: 0 },
    { verifyCmd: "npm run lint", maxRetries: 2 },
  ]);
});

test("STASH-1 una identidad ambigua congela stash y acciones masivas hasta resolverse", async (t) => {
  await t.test("rename que pasa por una key duplicada conserva el texto para la key final", () => {
    const initial = createWorkflowDraft({
      stages: [
        { key: "planning", label: "Plan", icon: "P", instruction: "secreto" },
        { key: "tests", label: "Pruebas", icon: "T" },
      ],
      verifyAfter: null,
    });
    const off = toggleHarnessControl(initial, "planning", "instruction", false, true);
    const ambiguous = setStages(off, [
      { ...off.stages[0], key: "tests" },
      off.stages[1],
    ], null);

    assert.equal(ambiguous.stash.planning?.instruction, "secreto");
    const resolved = setStages(ambiguous, [
      { ...ambiguous.stages[0], key: "plan-2" },
      ambiguous.stages[1],
    ], null);
    const restored = toggleHarnessControl(resolved, "plan-2", "instruction", true, true);
    assert.equal(restored.stages[0].instruction, "secreto");
  });

  await t.test("una banda no mezcla dos etapas que comparten key", () => {
    const initial = createWorkflowDraft({
      stages: [
        { key: "a", label: "A", icon: "A", instruction: "texto A" },
        { key: "b", label: "B", icon: "B", instruction: "texto B" },
      ],
      verifyAfter: null,
    });
    const ambiguous = setStages(initial, [
      { ...initial.stages[0], key: "same" },
      { ...initial.stages[1], key: "same" },
    ], null);

    assert.equal(toggleHarnessSection(ambiguous, "guides", false, true), ambiguous);
    const actionableBands = bands(ambiguous.stages, null, true)
      .filter((band) => band.id !== "deterministic-sensors");
    assert.equal(actionableBands.every((band) => band.disabled), true);
    assert.equal(actionableBands.every((band) => band.disabledReasonId === "duplicate-key"), true);
  });
});

test("WARN-1 restaurar el verificador no deja un aviso falso de texto descartado", () => {
  const draft = createWorkflowDraft({
    stages: [{ key: "tests", label: "Pruebas", icon: "T" }],
    verifyAfter: "tests",
  });
  const off = toggleHarnessSection(draft, "inferential-sensors", false, true);
  const restored = toggleHarnessSection(off, "inferential-sensors", true, true);

  assert.equal(restored.verifyAfter, "tests");
  assert.deepEqual(pendingDiscards(restored.stages, restored.stash), []);
});

test("STASH-1 JSON con keys duplicadas congela el stash mientras la identidad sea ambigua", () => {
  const draft = createWorkflowDraft({
    stages: [
      { key: "planning", label: "Plan", icon: "P", instruction: "secreto" },
      { key: "tests", label: "Pruebas", icon: "T" },
    ],
    verifyAfter: null,
  });
  const off = toggleHarnessControl(draft, "planning", "instruction", false, true);
  const duplicateJson = JSON.stringify({
    stages: [
      { ...off.stages[0], key: "tests" },
      off.stages[1],
    ],
    verifyAfter: null,
  });

  const ambiguous = setJsonText(off, duplicateJson);

  assert.equal(ambiguous.stash.planning?.instruction, "secreto");
  assert.deepEqual(ambiguous.identitySnapshot, off.stages);
});
