import type { WfInput, WfStage, WorkflowConfig } from "../types";
import type { BandId, ControlId, ControlValue, HarnessStash } from "./harness-controls";
import { controlPatch, isPersistable, stageIdentityProblem, valuePatch } from "./harness-controls";

/**
 * T14: pure state machine backing the three synchronized views (Stepper/Grafo/JSON) of the
 * workflow editor — no fetch, no DOM. This is deliberately where "cada vista con su propio
 * borrador rancio" would live if it existed, so it's exhaustively tested here instead of in a
 * component. Validation stays server-side (workflow.ts's validateStages) — this module only
 * does JSON.parse (syntax) and carries whatever semantic {path, code, message} `/validate`
 * returned; it never re-implements the validation rules themselves.
 */

export type DraftView = "stepper" | "graph" | "json" | "harness";

export interface JsonError {
  line?: number;   // present for a syntax error (JSON.parse failed)
  column?: number; // present for a syntax error
  path?: string;   // present for a shape error (parsed fine, but isn't a WorkflowConfig)
  message: string;
}

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export interface WorkflowDraftState {
  saved: WorkflowConfig;   // last known-good config (from the server: initial load or a successful save)
  stages: WfStage[];       // the LIVE edit, shared by the Stepper and Grafo views
  verifyAfter: string | null;
  inputs?: WfInput[];
  stash: Record<string, HarnessStash>;
  identitySnapshot: WfStage[] | null;
  arming: { stageKey: string; id: ControlId } | null;
  jsonText: string;        // the LIVE edit, JSON view's raw text — kept in sync with stages/verifyAfter
  view: DraftView;
  jsonError: JsonError | null;   // set only while jsonText fails to parse
  fieldError: FieldError | null; // last semantic error surfaced from /validate or a failed save
}

function stringifyFlow(flow: { stages: WfStage[]; verifyAfter: string | null; inputs?: WfInput[] }): string {
  return JSON.stringify({
    stages: flow.stages,
    verifyAfter: flow.verifyAfter,
    ...(flow.inputs ? { inputs: flow.inputs } : {}),
  }, null, 2);
}

export function createWorkflowDraft(cfg: WorkflowConfig, view: DraftView = "stepper"): WorkflowDraftState {
  return {
    saved: cfg,
    stages: cfg.stages,
    verifyAfter: cfg.verifyAfter,
    inputs: cfg.inputs,
    stash: {},
    identitySnapshot: null,
    arming: null,
    jsonText: stringifyFlow(cfg),
    view,
    jsonError: null,
    fieldError: null,
  };
}

/** Electron's named-workflow workspace opens in Grafo, unlike the legacy editor's Stepper default. */
export function createWorkflowWorkspaceDraft(cfg: WorkflowConfig, view?: DraftView): WorkflowDraftState {
  return createWorkflowDraft(cfg, view ?? "graph");
}

function renamedStageKeys(before: WfStage[], after: WfStage[]): Map<string, string> {
  const oldKeys = new Set(before.map((stage) => stage.key));
  const nextKeys = new Set(after.map((stage) => stage.key));
  const renames = new Map<string, string>();
  for (let index = 0; index < Math.min(before.length, after.length); index++) {
    const oldKey = before[index].key;
    const nextKey = after[index].key;
    if (oldKey !== nextKey && !oldKeys.has(nextKey) && !nextKeys.has(oldKey)) renames.set(oldKey, nextKey);
  }
  return renames;
}

function migrateStash(
  current: Record<string, HarnessStash>,
  renames: Map<string, string>,
  stages: WfStage[],
): Record<string, HarnessStash> {
  const stash = { ...current };
  for (const [oldKey, newKey] of renames) {
    if (stash[oldKey]) stash[newKey] = stash[oldKey];
    delete stash[oldKey];
  }
  const liveKeys = new Set(stages.map((stage) => stage.key));
  for (const key of Object.keys(stash)) if (!liveKeys.has(key)) delete stash[key];
  return stash;
}

function identityFreeze(state: WorkflowDraftState, stages: WfStage[]) {
  const ambiguous = stageIdentityProblem(stages) !== null;
  return {
    ambiguous,
    snapshot: ambiguous ? state.identitySnapshot ?? state.stages : null,
  };
}

/** Structured edit (Stepper/Grafo) → re-serializes the JSON view so it never shows stale text. */
export function setStages(state: WorkflowDraftState, stages: WfStage[], verifyAfter: string | null): WorkflowDraftState {
  const identity = identityFreeze(state, stages);
  const stableBefore = state.identitySnapshot ?? state.stages;
  const renames = identity.ambiguous ? new Map<string, string>() : renamedStageKeys(stableBefore, stages);
  const stash = identity.ambiguous ? state.stash : migrateStash(state.stash, renames, stages);
  const renamedArming = state.arming && renames.has(state.arming.stageKey)
    ? { ...state.arming, stageKey: renames.get(state.arming.stageKey)! }
    : state.arming;
  const arming = renamedArming && stages.some((stage) => stage.key === renamedArming.stageKey)
    ? renamedArming
    : null;
  return {
    ...state,
    stages,
    verifyAfter,
    stash,
    identitySnapshot: identity.snapshot,
    arming,
    jsonText: stringifyFlow({ stages, verifyAfter, inputs: state.inputs }),
    jsonError: null,
    fieldError: null,
  };
}

/** Inserta una etapa vacía sin tocar el arreglo del borrador que la originó. */
export function insertStageAt(stages: WfStage[], index: number): WfStage[] {
  const next = [...stages];
  next.splice(index, 0, { key: "", label: "Nueva etapa", icon: "•", instruction: "" });
  return next;
}

/** V8's JSON.parse SyntaxError carries a 0-based character offset in its message ("... at position N"). */
function syntaxErrorPosition(text: string, error: unknown): JsonError {
  const message = error instanceof Error ? error.message : String(error);
  const match = /position (\d+)/.exec(message);
  const offset = match ? Number(match[1]) : 0;
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1, message };
}

/**
 * NEW-1 (major, hallado en review 2): `jsonShapeError` sólo validaba el objeto de primer nivel
 * (`stages` es array, `verifyAfter` es string|null) — una etapa DENTRO de `stages` con forma
 * inválida (p.ej. `{}`, sin key/label/icon) pasaba ese chequeo y quedaba en el borrador,
 * guardable, dependiendo de que el servidor la rechazara DESPUÉS de hacer click en Guardar.
 * Chequeo deliberadamente de TIPO (¿es un WfStage estructuralmente?), no de REGLA de negocio
 * (única, no-vacía tras trim, slug válido, no reservada — esas siguen siendo del servidor,
 * vía /validate → fieldError, exactamente lo que N1 pedía no duplicar). `{key:"",...}` (vacío
 * pero presente y string) pasa este chequeo a propósito; `{}` (key ausente, ni siquiera un
 * string) no.
 */
function stageShapeError(stage: unknown, index: number): JsonError | null {
  const path = `stages[${index}]`;
  if (typeof stage !== "object" || stage === null || Array.isArray(stage)) {
    return { path, message: `${path} debe ser un objeto {key, label, icon}` };
  }
  const s = stage as Record<string, unknown>;
  if (typeof s.key !== "string") return { path: `${path}.key`, message: `${path}.key debe ser un string` };
  if (typeof s.label !== "string") return { path: `${path}.label`, message: `${path}.label debe ser un string` };
  if (typeof s.icon !== "string") return { path: `${path}.icon`, message: `${path}.icon debe ser un string` };
  if (s.instruction !== undefined && typeof s.instruction !== "string") {
    return { path: `${path}.instruction`, message: `${path}.instruction debe ser un string` };
  }
  if (s.role !== undefined && s.role !== "impl") {
    return { path: `${path}.role`, message: `${path}.role sólo admite "impl" (o ausente)` };
  }
  if (s.verifyCmd !== undefined && typeof s.verifyCmd !== "string") {
    return { path: `${path}.verifyCmd`, message: `${path}.verifyCmd debe ser un string` };
  }
  if (s.maxRetries !== undefined && typeof s.maxRetries !== "number") {
    return { path: `${path}.maxRetries`, message: `${path}.maxRetries debe ser un número` };
  }
  return null;
}

function inputShapeError(input: unknown, index: number): JsonError | null {
  const path = `inputs[${index}]`;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { path, message: `${path} debe ser un objeto {key, label}` };
  }
  const item = input as Record<string, unknown>;
  if (typeof item.key !== "string") return { path: `${path}.key`, message: `${path}.key debe ser un string` };
  if (typeof item.label !== "string") return { path: `${path}.label`, message: `${path}.label debe ser un string` };
  if (item.placeholder !== undefined && typeof item.placeholder !== "string") {
    return { path: `${path}.placeholder`, message: `${path}.placeholder debe ser un string` };
  }
  if (item.required !== undefined && typeof item.required !== "boolean") {
    return { path: `${path}.required`, message: `${path}.required debe ser boolean` };
  }
  return null;
}

/**
 * D4 (bug real, hallado en review): un JSON sintácticamente válido cuya forma NO es un
 * WorkflowConfig (p.ej. `{}`) parseaba bien, así que caía derecho al camino "válido" — que
 * sustituía `stages` ausente por las viejas y `verifyAfter` no-string por `null`, produciendo
 * un config DISTINTO y guardable sin que nadie lo pidiera. Ahora se valida la FORMA aparte de
 * la sintaxis, con su propia ruta de campo — ninguna de las dos entra en el camino "válido".
 * NEW-1 extiende esto a CADA etapa dentro de `stages` (no sólo el objeto de primer nivel).
 */
function jsonShapeError(parsed: unknown): JsonError | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { path: "", message: "el JSON debe ser un objeto {stages, verifyAfter}" };
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.stages)) {
    return { path: "stages", message: '"stages" debe ser un array de etapas' };
  }
  for (let i = 0; i < obj.stages.length; i++) {
    const stageError = stageShapeError(obj.stages[i], i);
    if (stageError) return stageError;
  }
  if (obj.verifyAfter !== null && typeof obj.verifyAfter !== "string") {
    return { path: "verifyAfter", message: '"verifyAfter" debe ser un string (key de etapa) o null' };
  }
  if (obj.inputs !== undefined) {
    if (!Array.isArray(obj.inputs)) return { path: "inputs", message: '"inputs" debe ser un array de entradas' };
    for (let i = 0; i < obj.inputs.length; i++) {
      const inputError = inputShapeError(obj.inputs[i], i);
      if (inputError) return inputError;
    }
  }
  return null;
}

/**
 * JSON edit → on valid JSON with a valid WorkflowConfig shape, syncs the structured views
 * (Stepper/Grafo) to match; on ANY problem — invalid syntax OR valid-JSON-wrong-shape (D4) —
 * keeps `stages`/`verifyAfter` UNTOUCHED (T14.109/D4 — a broken or malformed JSON edit never
 * contaminates the structured draft, and never silently becomes a different, guardable config)
 * and records `jsonError` instead, which gates Save in both cases identically.
 */
export function setJsonText(state: WorkflowDraftState, text: string): WorkflowDraftState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ...state, jsonText: text, jsonError: syntaxErrorPosition(text, error) };
  }
  const shapeError = jsonShapeError(parsed);
  if (shapeError) return { ...state, jsonText: text, jsonError: shapeError };
  const { stages, verifyAfter, inputs } = parsed as WorkflowConfig;
  const identity = identityFreeze(state, stages);
  return {
    ...state,
    jsonText: text,
    stages,
    verifyAfter,
    inputs,
    stash: identity.ambiguous ? state.stash : {},
    identitySnapshot: identity.snapshot,
    arming: null,
    jsonError: null,
    fieldError: null,
  };
}

/** Switching views never mutates the underlying edit — same stages/verifyAfter/jsonText. */
export function switchView(state: WorkflowDraftState, view: DraftView): WorkflowDraftState {
  return { ...state, view };
}

/** Discards every local edit, restoring the last SAVED config — never touches the network. */
export function cancel(state: WorkflowDraftState): WorkflowDraftState {
  return {
    ...state,
    stages: state.saved.stages,
    verifyAfter: state.saved.verifyAfter,
    inputs: state.saved.inputs,
    stash: {},
    identitySnapshot: null,
    arming: null,
    jsonText: stringifyFlow(state.saved),
    jsonError: null,
    fieldError: null,
  };
}

/** Records a semantic error (from /validate or a failed save) — cleared by the next edit. */
export function setFieldError(state: WorkflowDraftState, error: FieldError | null): WorkflowDraftState {
  return { ...state, fieldError: error };
}

/** After a successful save, the draft adopts the SERVER's normalized config in every view (T14.114). */
export function adoptServerConfig(state: WorkflowDraftState, cfg: WorkflowConfig): WorkflowDraftState {
  return createWorkflowDraft(cfg, state.view);
}

function valueFromStash(id: Exclude<ControlId, "verifier">, stash: HarnessStash): ControlValue | null {
  if (id === "instruction" && stash.instruction !== undefined) {
    return { id, instruction: stash.instruction };
  }
  if (id === "executor" && stash.executor !== undefined) {
    return { id, executor: stash.executor, model: stash.model };
  }
  if (id === "verifyCmd" && stash.verifyCmd !== undefined) {
    return { id, verifyCmd: stash.verifyCmd, maxRetries: stash.maxRetries };
  }
  return null;
}

function restoreStashedControls(
  stage: WfStage,
  stash: HarnessStash,
  ids: ReadonlyArray<Exclude<ControlId, "verifier">>,
): WfStage {
  return ids.reduce((next, id) => {
    const value = valueFromStash(id, stash);
    return value && isPersistable(value) ? { ...next, ...valuePatch(value) } : next;
  }, stage);
}

function turnOffControls(
  stage: WfStage,
  stash: HarnessStash,
  ids: ReadonlyArray<Exclude<ControlId, "verifier">>,
): { stage: WfStage; stash: HarnessStash } {
  return ids.reduce((current, id) => {
    const result = controlPatch(current.stage, id, false, current.stash);
    return { stage: { ...current.stage, ...result.patch }, stash: result.stash };
  }, { stage, stash });
}

export function toggleHarnessControl(
  state: WorkflowDraftState,
  stageKey: string,
  id: ControlId,
  on: boolean,
  allowVerifyCmd: boolean,
): WorkflowDraftState {
  if (stageIdentityProblem(state.stages)) return state;
  if (!state.stages.some((stage) => stage.key === stageKey)) return state;
  if (id === "verifyCmd" && !allowVerifyCmd) return state;
  if (id === "verifier") {
    const verifyAfter = on ? stageKey : null;
    return {
      ...state,
      verifyAfter,
      stash: on
        ? state.stash
        : { ...state.stash, [stageKey]: { ...state.stash[stageKey], verifier: true } },
      arming: null,
      jsonText: stringifyFlow({ stages: state.stages, verifyAfter, inputs: state.inputs }),
      jsonError: null,
      fieldError: null,
    };
  }
  if (on) {
    const stashed = valueFromStash(id, state.stash[stageKey] ?? {});
    if (stashed && isPersistable(stashed)) return editControlValue(state, stageKey, stashed);
    return { ...state, arming: { stageKey, id } };
  }
  const stage = state.stages.find((item) => item.key === stageKey)!;
  const result = controlPatch(stage, id, false, state.stash[stageKey] ?? {});
  return withStagePatch(state, stageKey, result.patch, result.stash);
}

function stashForValue(value: ControlValue): HarnessStash {
  if (value.id === "instruction") return { instruction: value.instruction };
  if (value.id === "executor") {
    return { executor: value.executor, ...(value.model !== undefined ? { model: value.model } : {}) };
  }
  return { verifyCmd: value.verifyCmd, maxRetries: value.maxRetries ?? 2 };
}

function withHarnessStages(
  state: WorkflowDraftState,
  stages: WfStage[],
  stash: Record<string, HarnessStash>,
  arming: WorkflowDraftState["arming"] = null,
): WorkflowDraftState {
  return {
    ...state,
    stages,
    stash,
    arming,
    jsonText: stringifyFlow({ stages, verifyAfter: state.verifyAfter, inputs: state.inputs }),
    jsonError: null,
    fieldError: null,
  };
}

function withStagePatch(
  state: WorkflowDraftState,
  stageKey: string,
  patch: Partial<WfStage>,
  stash: HarnessStash,
): WorkflowDraftState {
  const stages = state.stages.map((stage) => stage.key === stageKey ? { ...stage, ...patch } : stage);
  return withHarnessStages(state, stages, { ...state.stash, [stageKey]: stash });
}

export function editControlValue(
  state: WorkflowDraftState,
  stageKey: string,
  value: ControlValue,
): WorkflowDraftState {
  if (!isPersistable(value)) {
    const stage = state.stages.find((item) => item.key === stageKey);
    if (!stage) return state;
    const result = controlPatch(stage, value.id, false, state.stash[stageKey] ?? {});
    return withStagePatch(state, stageKey, result.patch, result.stash);
  }
  const patch = valuePatch(value);
  const stash = { ...state.stash[stageKey], ...stashForValue(value) };
  return withStagePatch(state, stageKey, patch, stash);
}

export function toggleHarnessSection(
  state: WorkflowDraftState,
  band: BandId,
  on: boolean,
  _allowVerifyCmd: boolean,
): WorkflowDraftState {
  if (stageIdentityProblem(state.stages)) return state;
  if (band === "deterministic-sensors") return state;
  if (band === "inferential-sensors") {
    if (!on) {
      return state.verifyAfter
        ? toggleHarnessControl(state, state.verifyAfter, "verifier", false, _allowVerifyCmd)
        : state;
    }
    const stage = state.stages.find((item) => state.stash[item.key]?.verifier);
    return stage
      ? toggleHarnessControl(state, stage.key, "verifier", true, _allowVerifyCmd)
      : state;
  }
  if (band === "gates") {
    if (!_allowVerifyCmd) return state;
    if (on) {
      const stages = state.stages.map((stage) =>
        restoreStashedControls(stage, state.stash[stage.key] ?? {}, ["verifyCmd"]));
      return withHarnessStages(state, stages, state.stash);
    }
    const stash = { ...state.stash };
    const stages = state.stages.map((stage) => {
      const result = turnOffControls(stage, stash[stage.key] ?? {}, ["verifyCmd"]);
      stash[stage.key] = result.stash;
      return result.stage;
    });
    return withHarnessStages(state, stages, stash);
  }
  if (band === "guides" && on) {
    const stages = state.stages.map((stage) =>
      restoreStashedControls(stage, state.stash[stage.key] ?? {}, ["instruction", "executor"]));
    return withHarnessStages(state, stages, state.stash);
  }
  if (band === "guides" && !on) {
    const stash = { ...state.stash };
    const stages = state.stages.map((stage) => {
      const result = turnOffControls(stage, stash[stage.key] ?? {}, ["instruction", "executor"]);
      stash[stage.key] = result.stash;
      return result.stage;
    });
    return withHarnessStages(state, stages, stash);
  }
  return state;
}

export interface DraftGraphNode {
  key: string;
  label: string;
  icon: string;
  role?: "impl";
  executor?: "claude" | "codex" | "agy";
  model?: string;
  gate?: boolean;
}
export type DraftGraphEdgeKind = "sequence" | "verify" | "retry";
export interface DraftGraphEdge {
  from: string;
  to: string;
  kind: DraftGraphEdgeKind;
}
export interface DraftGraph {
  nodes: DraftGraphNode[];
  edges: DraftGraphEdge[];
}

const VERIFY_NODE: DraftGraphNode = { key: "verify", label: "Verify", icon: "🔎" };

/**
 * Pure presentational derivation for the Grafo view — same three edge classes as the server's
 * toGraph (server/src/workflow.ts), duplicated here deliberately: this is layout/rendering, not
 * a validation rule, so it carries none of the risk N1 warns about (a second copy of
 * validateStages drifting from the server's). The topological order IS `stages`' array order,
 * so layout is deterministic with no separate positioning step.
 */
export function deriveGraph(stages: WfStage[], verifyAfter: string | null): DraftGraph {
  const nodes: DraftGraphNode[] = stages.map((s) => ({
    key: s.key,
    label: s.label,
    icon: s.icon,
    ...(s.role === "impl" ? { role: "impl" as const } : {}),
    executor: s.executor,
    model: s.model,
    ...(s.verifyCmd ? { gate: true as const } : {}),
  }));
  const edges: DraftGraphEdge[] = [];
  for (let i = 0; i < stages.length - 1; i++) edges.push({ from: stages[i].key, to: stages[i + 1].key, kind: "sequence" });
  if (verifyAfter && stages.some((s) => s.key === verifyAfter)) {
    nodes.push(VERIFY_NODE);
    edges.push({ from: verifyAfter, to: VERIFY_NODE.key, kind: "verify" });
  }
  for (const s of stages) if (s.verifyCmd) edges.push({ from: s.key, to: s.key, kind: "retry" });
  return { nodes, edges };
}
