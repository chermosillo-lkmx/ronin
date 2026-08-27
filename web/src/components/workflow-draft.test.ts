import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptServerConfig,
  cancel,
  createWorkflowDraft,
  createWorkflowWorkspaceDraft,
  deriveGraph,
  setFieldError,
  setJsonText,
  setStages,
  switchView,
} from "./workflow-draft.js";
import type { WfStage, WorkflowConfig } from "../types.js";

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
