import { readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./data-dir.js";
import { getRepoWorkflow } from "./repo-config.js";
import type { TaskStatus, WorkerState } from "./types.js";

/**
 * Composable workflow: the loop stages live in data/workflow.json so new
 * components (comment code, security review, …) can be added/removed/reordered
 * without touching code. Each stage becomes a numbered step in the worker prompt
 * AND a step in the visual stepper. Edit the JSON and restart the server.
 *
 * T11: `validateStages` (below) speaks TWO deliberately separate contracts, chosen by
 * `options.strict`:
 *   - strict (editing/saving — saveWorkflow, repo-config.ts's saveRepoOverrides, the
 *     /validate routes): throws `WorkflowValidationError {path, code, message}` on the
 *     first invalid field — a save should tell the editor exactly what's wrong, not
 *     silently coerce it into something valid.
 *   - tolerant (loading from disk — `load()`/`normalizeLoadedWorkflow`, repo-config.ts's
 *     sanitizeEntry): never throws (bar the pre-existing RESERVED_KEYS guard, which every
 *     disk-loading caller already defends against with its own try/catch); malformed
 *     fields are dropped or defaulted instead.
 * These are NOT the same rule at two strictness levels — a `load()` that throws has no
 * one to hand a 400 to, and would stop the app from starting on an existing workflow.json
 * or repo-config.json. Tolerance on load is a resilience decision ("distrust disk");
 * strictness on save is a UX decision. Do not merge them back into one behavior.
 */
export interface WfStage {
  key: string;          // sentinel the worker touches + stepper id
  label: string;        // short label for the stepper
  icon: string;         // stepper icon
  instruction?: string; // what to ask the worker to do at this stage
  role?: "impl";        // F0: marks the implementation stage → drives the plan→impl /model switch
  verifyCmd?: string;   // P2: shell cmd (exit 0 = pass) gating advancement past this stage. ONLY honored
                        // from the gitignored per-repo override (stripped everywhere git-tracked — RCE guard).
  maxRetries?: number;  // P2: max verify attempts before the stage is marked failed (default 2).
}

export interface WorkflowConfig {
  stages: WfStage[];
  verifyAfter: string | null; // spawn the independent verifier after this stage (null = none)
}

const WORKFLOW_PATH = dataPath("workflow.json");

/**
 * T11: thrown ONLY by validateStages' strict contract (editing/saving) — never by the
 * tolerant one (loading). Carries `path`/`code` so callers can turn it into an actionable
 * 400 ({error, path, code}) instead of a bare message.
 */
export class WorkflowValidationError extends Error {
  readonly path: string;
  readonly code: string;
  constructor(path: string, code: string, message: string) {
    super(message);
    this.name = "WorkflowValidationError";
    this.path = path;
    this.code = code;
  }
}

/**
 * Drop the executable verifyCmd/maxRetries from a stage — single source for the "git-tracked path
 * strips verifyCmd" rule (B3). Used by the global workflow load; actions strip via validateStages.
 */
export function stripVerifyFields<T extends object>(stage: T): Omit<T, "verifyCmd" | "maxRetries"> {
  const { verifyCmd, maxRetries, ...rest } = stage as any;
  return rest;
}

const DEFAULT: WorkflowConfig = {
  verifyAfter: "curl",
  stages: [
    { key: "planning", label: "Plan", icon: "📋", instruction: "Escribe un plan breve de la implementación y los artefactos a entregar." },
    { key: "implementing", label: "Impl", icon: "⌨️", role: "impl", instruction: "Implementa la solución." },
    { key: "curl", label: "Curl", icon: "🌐", instruction: "Pruebas CURL contra DEV: ejecuta `source {cycle}/curl.env` (te da $DEV_URL, $TOKEN, $ACCOUNTING_FIRM; no los pidas). Corre los curl relevantes y guarda comando + request body + response body en {ev}/curl.md." },
    { key: "done", label: "Done", icon: "✓", instruction: "Escribe {ev}/summary.md (comentario listo para el ticket)." },
  ],
};

// The synthetic step for the independent verifier (managed via verifyAfter, not
// listed in stages). The verifier worker touches this sentinel in the main cycle.
const VERIFY_STAGE: WfStage = { key: "verify", label: "Verify", icon: "🔎" };

let cache: WorkflowConfig | null = null;

/**
 * T11: tolerant normalization of a parsed (possibly malformed) workflow.json — never throws.
 * Pulled out of load() so the "distrust disk" rules go through validateStages' tolerant
 * contract (the same single source of truth the strict/editor contract uses) instead of a
 * separate ad hoc pass, while staying disk/cache-free and directly unit-testable.
 */
export function normalizeLoadedWorkflow(raw: any): WorkflowConfig {
  // "_"-prefixed keys (e.g. a stray _comment-shaped object hand-added inside stages[]) are
  // dropped BEFORE validation, not slugged into a real stage — same guard load() always had.
  const rawStages = Array.isArray(raw?.stages) ? raw.stages.filter((s: any) => s && typeof s.key === "string" && s.key[0] !== "_") : [];
  // Strip verifyCmd/maxRetries: the global workflow.json is git-tracked, so a committed
  // verifyCmd must NOT execute (B3). allowVerifyCmd defaults false, so validateStages already
  // strips it — no separate stripVerifyFields pass needed here.
  const validated = validateStages({ stages: rawStages, verifyAfter: raw?.verifyAfter }, { strict: false });
  // Coordinated fallback: if nothing survived, use DEFAULT wholesale (stages AND verifyAfter
  // together) rather than DEFAULT.stages paired with a verifyAfter re-validated against an
  // empty stage list (which would always come back null).
  return validated.stages.length ? validated : DEFAULT;
}

function load(): WorkflowConfig {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"));
    cache = normalizeLoadedWorkflow(raw);
  } catch {
    cache = DEFAULT;
  }
  return cache;
}

/** The configured main-worker stages (no synthetic verify). */
export function getStages(): WfStage[] {
  return load().stages;
}

export function getVerifyAfter(): string | null {
  return load().verifyAfter;
}

/** Full config (deep copy) — for the editor UI. */
export function getWorkflow(): WorkflowConfig {
  const { stages, verifyAfter } = load();
  return { stages: stages.map((s) => ({ ...s })), verifyAfter };
}

function slug(s: string): string {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// Keys that collide with infrastructure inside the cycle dir and can never work
// as a stage sentinel: "verify" (synthetic verifier step) and "evidence" (the
// evidence/ subdirectory). curl.env is a file but "curl" !== "curl.env", so ok.
export const RESERVED_KEYS = ["verify", "evidence"];

/**
 * Stepper fijo del modo Driver (como RESEARCH_STAGES: desacoplado del workflow.json componible).
 *
 * Tres restricciones que dictan estas keys, todas con dientes:
 * 1. `verifyAfter: null` es OBLIGATORIO. Con valor no nulo, pollLive dispara spawnVerifier, que
 *    crea una sesión tmux ENTERA aparte — anulando en silencio el modelo de 4 panes.
 * 2. La etapa de verificación NO se llama "verify": es RESERVED_KEY y liveMapFor la trataría
 *    como el paso sintético del verificador, clavándola en review para siempre.
 * 3. El switch de modelo (maybeSwitchModel teclea /model en el pane ACTIVO) NO debe correr aquí:
 *    en modo driver los modelos los maneja el skill. OJO: omitir `role:"impl"` NO es suficiente —
 *    implStageIndex cae al match por key "implementing" (workflow.ts:164), así que esta etapa SÍ
 *    califica. Lo que de verdad lo apaga son los dos guards de launchDriverLive: switchEnabled:false
 *    persistido en models.json (sobrevive reinicios) y el early-return por mode==="driver".
 */
export const DRIVER_STAGES: WfStage[] = [
  { key: "planning",     label: "Plan",        icon: "📋", instruction: "el BRAIN escribe plan.md (aún no lo apruebes)." },
  { key: "plan-review",  label: "Review plan", icon: "🔥", instruction: "el REVIEWER ataca el plan; relaya los hallazgos al Brain hasta que quede limpio." },
  { key: "implementing", label: "Impl",        icon: "⌨️", instruction: "mandaste PLAN APPROVED; el IMPLEMENTER ejecuta en ciclos RED→GREEN→REFACTOR (rgr.log)." },
  { key: "diff-review",  label: "Review diff", icon: "🔥", instruction: "el REVIEWER ataca el diff + los tests y AUDITA los refactors de rgr.log; relaya y repite." },
  { key: "verifying",    label: "Verify",      icon: "🔎", instruction: "verificas tú: KB, suites y rgr.log contra el objetivo del ticket." },
  { key: "done",         label: "Done",        icon: "✓",  instruction: "escribe {ev}/summary.md (comentario listo para el ticket)." },
];
export const DRIVER_FLOW: { stages: WfStage[]; verifyAfter: string | null } = {
  stages: DRIVER_STAGES,
  verifyAfter: null,
};

export interface ValidateStagesOptions {
  allowVerifyCmd?: boolean; // P2/B3: verifyCmd only honored from the gitignored per-repo override.
  strict?: boolean;         // T11: strict=editing (throws WorkflowValidationError); tolerant=loading (never throws).
}

/**
 * T11: strict-only pre-pass — runs BEFORE any normalization, so an editor save gets a
 * specific, actionable error instead of the input being silently coerced into something
 * valid. Tolerant (load) callers never run this; they go straight to the normalize pipeline
 * below, which already defaults/drops/strips the same fields this rejects.
 */
function assertStrict(rawStages: any[], verifyAfterRaw: unknown, allowVerifyCmd: boolean): void {
  if (!rawStages.length) throw new WorkflowValidationError("stages", "NO_STAGES", "el workflow necesita al menos una etapa");
  const seen = new Set<string>();
  for (let i = 0; i < rawStages.length; i++) {
    const s: any = rawStages[i];
    const path = `stages[${i}]`;
    const rawKey = typeof s?.key === "string" ? s.key.trim() : "";
    if (!rawKey) throw new WorkflowValidationError(`${path}.key`, "KEY_REQUIRED", "cada etapa necesita un key");
    const slugged = slug(rawKey);
    if (slugged !== rawKey) {
      throw new WorkflowValidationError(`${path}.key`, "KEY_NOT_SLUG", `la key "${rawKey}" debe ser un slug (letras/números/guiones); usa "${slugged}"`);
    }
    if (seen.has(slugged)) throw new WorkflowValidationError(`${path}.key`, "DUPLICATE_KEY", `la key "${slugged}" ya está usada por otra etapa`);
    seen.add(slugged);
    if (RESERVED_KEYS.includes(slugged)) {
      throw new WorkflowValidationError(`${path}.key`, "RESERVED_KEY", `la key "${slugged}" está reservada; usa otra (p. ej. "done", "summary")`);
    }
    if (!String(s?.label ?? "").trim()) throw new WorkflowValidationError(`${path}.label`, "LABEL_REQUIRED", "cada etapa necesita un label");
    if (!String(s?.icon ?? "").trim()) throw new WorkflowValidationError(`${path}.icon`, "ICON_REQUIRED", "cada etapa necesita un icon");
    if (s?.role !== undefined && s.role !== "impl") {
      throw new WorkflowValidationError(`${path}.role`, "INVALID_ROLE", `role "${s.role}" inválido; el único valor soportado es "impl"`);
    }
    if (typeof s?.verifyCmd === "string" && s.verifyCmd.trim() && !allowVerifyCmd) {
      throw new WorkflowValidationError(
        `${path}.verifyCmd`,
        "VERIFY_CMD_NOT_ALLOWED",
        "verifyCmd sólo se honra en el override por-repo (gitignored); este archivo es git-tracked y un verifyCmd committeado ejecutaría shell arbitrario en el próximo git pull + lanzamiento"
      );
    }
  }
  if (typeof verifyAfterRaw === "string" && verifyAfterRaw.trim()) {
    const va = slug(verifyAfterRaw.trim());
    if (!seen.has(va)) {
      throw new WorkflowValidationError(
        "verifyAfter",
        "VERIFY_AFTER_NOT_FOUND",
        `verifyAfter "${verifyAfterRaw}" no coincide con ninguna etapa; keys válidas: ${Array.from(seen).join(", ")}`
      );
    }
  }
}

/**
 * Validate + normalize a workflow config (slug keys, dedupe, reserved-key check, ≥1 stage,
 * verifyAfter must match a stage). Two DELIBERATELY separate contracts (T11):
 *
 * - `strict: true` (editing/saving — saveWorkflow, saveRepoOverrides, the /validate routes):
 *   throws `WorkflowValidationError {path, code, message}` on the FIRST invalid field, so a
 *   400 can point at exactly what's wrong instead of silently coercing it.
 * - `strict: false` (default — loading from disk — load(), sanitizeEntry): never throws
 *   (except the pre-existing RESERVED_KEYS guard, defended against by every disk-loading
 *   caller's own try/catch); malformed fields are dropped/defaulted, same as before T11.
 *
 * A `load()` that throws has no one to hand a 400 to — an existing workflow.json or
 * repo-config.json would stop the app from starting. The tolerance on load is a resilience
 * decision ("distrust disk"); the strictness on save is a UX decision. Don't merge them.
 */
export function validateStages(input: Partial<WorkflowConfig>, options: ValidateStagesOptions = {}): WorkflowConfig {
  const { allowVerifyCmd = false, strict = false } = options;
  const rawStages: any[] = Array.isArray(input.stages) ? input.stages : [];
  if (strict) assertStrict(rawStages, input.verifyAfter, allowVerifyCmd);

  const seen = new Set<string>();
  const stages: WfStage[] = rawStages
    .map((s) => {
      // P2/B3: verifyCmd executes arbitrary shell → only honored from the gitignored per-repo
      // override (allowVerifyCmd=true). Stripped everywhere git-tracked (global workflow.json,
      // actions.json) so a committed verifyCmd can never RCE on `git pull` + live launch.
      const verifyCmd = allowVerifyCmd && typeof s?.verifyCmd === "string" && s.verifyCmd.trim() ? s.verifyCmd.trim() : undefined;
      const maxRetries = verifyCmd
        ? Number.isFinite(s?.maxRetries) ? Math.min(Math.max(0, Math.floor(s!.maxRetries as number)), 10) : 2
        : undefined;
      return {
        key: slug(s?.key ?? ""),
        label: String(s?.label ?? "").trim() || (s?.key ?? "stage"),
        icon: String(s?.icon ?? "").trim() || "•",
        instruction: typeof s?.instruction === "string" ? s.instruction : "",
        ...(s?.role === "impl" ? { role: "impl" as const } : {}),
        ...(verifyCmd ? { verifyCmd } : {}),
        ...(maxRetries !== undefined ? { maxRetries } : {}),
      };
    })
    .filter((s) => s.key && !seen.has(s.key) && (seen.add(s.key), true));
  if (!stages.length) {
    // Strict already rejected an empty/all-invalid input via assertStrict above — unreachable
    // here in practice; kept as a defensive fallback rather than assuming assertStrict is airtight.
    if (strict) throw new WorkflowValidationError("stages", "NO_STAGES", "el workflow necesita al menos una etapa");
    // Tolerant: let the caller decide the fallback (load() falls back to DEFAULT wholesale).
    return { stages: [], verifyAfter: null };
  }
  const bad = stages.find((s) => RESERVED_KEYS.includes(s.key));
  if (bad) {
    if (strict) throw new WorkflowValidationError(`stages.${bad.key}`, "RESERVED_KEY", `la key "${bad.key}" está reservada; usa otra (p. ej. "done", "summary")`);
    throw new Error(`la key "${bad.key}" está reservada; usa otra (p. ej. "done", "summary")`);
  }
  const va = input.verifyAfter ? slug(input.verifyAfter) : null;
  const verifyAfter = va && stages.some((s) => s.key === va) ? va : null;
  return { stages, verifyAfter };
}

/** Validate + persist the workflow to disk, invalidating the cache. */
export function saveWorkflow(input: Partial<WorkflowConfig>): WorkflowConfig {
  const cfg = validateStages(input, { strict: true });
  writeFileSync(
    WORKFLOW_PATH,
    JSON.stringify(
      {
        _comment:
          "Etapas del workflow para tickets. Editable desde el dashboard (⚙ Workflow) o a mano. key=sentinel (touch), label/icon=stepper, instruction=qué pedirle (placeholders {cycle} {ev} {repo}). verifyAfter: etapa tras la cual abrir el verificador (null=ninguno). NOTA: verifyCmd/maxRetries (gate pass/fail por-stage) se IGNORAN aquí — este archivo es git-tracked y verifyCmd ejecuta shell; sólo el override por-repo (gitignored) los honra.",
        ...cfg,
      },
      null,
      2
    ) + "\n"
  );
  cache = cfg;
  return cfg;
}

/**
 * Index of the implementation stage in a flow (F0): the stage flagged `role:"impl"`,
 * or (back-compat for overrides authored before `role`) the stage keyed "implementing".
 * -1 when the flow has no implementation stage (e.g. research/PR read-only flows).
 */
export function implStageIndex(stages: WfStage[]): number {
  const byRole = stages.findIndex((s) => s.role === "impl");
  return byRole >= 0 ? byRole : stages.findIndex((s) => s.key === "implementing");
}

/**
 * F0: pure decision for the plan→impl `/model` switch. True when this launch enabled the
 * switch (implementer launch — PR/research set switchEnabled=false), it hasn't fired yet,
 * the flow HAS an impl stage, and the worker is at that stage OR later (F2: tolerates a
 * skipped `implementing` poll when the worker touches impl+curl in one 2s interval).
 */
export function shouldSwitchModel(
  switchEnabled: boolean,
  alreadySwitched: boolean,
  stages: WfStage[],
  stageKey: string
): boolean {
  if (!switchEnabled || alreadySwitched) return false;
  const implIdx = implStageIndex(stages);
  if (implIdx < 0) return false;
  const curIdx = stages.findIndex((s) => s.key === stageKey);
  // The synthetic "verify" step isn't in stages[] but is always inserted AFTER a real stage
  // (verifyAfter), so reaching it means impl is already past — treat it as "at or after impl".
  if (curIdx < 0) return stageKey === "verify";
  return curIdx >= implIdx;
}

/**
 * P2 (B2 — no false-green): the stage key to CAP the displayed progress at, given the furthest
 * REAL stage the worker reached. If any verifyCmd stage at/before it hasn't passed, the worker
 * can't be shown beyond that gate (so it never reaches `done` on a false green). null = no cap.
 * The cap is always ≤ the furthest reached stage, so it only ever holds progress back.
 */
export function verifyGateCap(
  stages: WfStage[],
  furthestRealKey: string | null,
  isPassed: (key: string) => boolean
): string | null {
  if (!furthestRealKey) return null;
  const fIdx = stages.findIndex((s) => s.key === furthestRealKey);
  if (fIdx < 0) return null;
  for (let p = 0; p <= fIdx; p++) {
    if (stages[p].verifyCmd && !isPassed(stages[p].key)) return stages[p].key;
  }
  return null;
}

/**
 * P2 (B2, incl. TERMINAL gates): true when a stage's unpassed verifyCmd must PREVENT it from
 * being treated as done. Guarding only on "failed" was a false-green — a gate on the last stage
 * maps to `done` while the check is still `pending`/in-flight, firing complete irreversibly.
 */
export function gateHoldsDone(hasVerifyCmd: boolean, status: "pending" | "passed" | "failed" | null): boolean {
  return hasVerifyCmd && status !== "passed";
}

export interface EligibleVerify {
  key: string;
  verifyCmd: string;
  maxRetries: number;
}
/**
 * P2: verifyCmd stages the worker has LEFT (a later real stage was reached, or it's the terminal
 * stage) whose gate isn't yet resolved (not passed/failed) — i.e. eligible to run now.
 */
export function eligibleVerifyStages(
  stages: WfStage[],
  furthestRealKey: string | null,
  statusOf: (key: string) => "pending" | "passed" | "failed" | null
): EligibleVerify[] {
  if (!furthestRealKey) return [];
  const fIdx = stages.findIndex((s) => s.key === furthestRealKey);
  if (fIdx < 0) return [];
  const out: EligibleVerify[] = [];
  for (let p = 0; p <= fIdx; p++) {
    const s = stages[p];
    if (!s.verifyCmd) continue;
    const st = statusOf(s.key);
    if (st === "passed" || st === "failed") continue;
    const left = p === stages.length - 1 ? true : fIdx > p; // moved past it, or it's terminal
    if (left) out.push({ key: s.key, verifyCmd: s.verifyCmd, maxRetries: s.maxRetries ?? 2 });
  }
  return out;
}

/** Insert the synthetic "verify" step right after verifyAfter (when it matches). */
export function stepperFor(stages: WfStage[], verifyAfter: string | null): WfStage[] {
  if (!verifyAfter || !stages.some((s) => s.key === verifyAfter)) return stages;
  const out: WfStage[] = [];
  for (const s of stages) {
    out.push(s);
    if (s.key === verifyAfter) out.push(VERIFY_STAGE);
  }
  return out;
}

export interface SpliceFlowOk {
  ok: true;
  stages: WfStage[];
  verifyAfter: string | null;
}
export interface SpliceFlowRejected {
  ok: false;
  code: "STAGE_IN_FLIGHT";
  message: string;
}
export type SpliceFlowResult = SpliceFlowOk | SpliceFlowRejected;

/**
 * T13: hot-apply a workflow edit onto a LIVE worker's flow without ever orphaning a sentinel
 * it already wrote. `currentKey` is the furthest stage the worker has REACHED (from
 * `detectStage` against its real cycle dir) — everything at/before it is preserved VERBATIM
 * from `oldFlow` (not merely by key: a verifyCmd added to an already-passed stage in `next`
 * must never retroactively apply to a worker already past it, T13 test 105); everything after
 * it comes from `next`. Rejects (STAGE_IN_FLIGHT) instead of silently orphaning a sentinel
 * when the edit renamed, reordered, or removed anything at/before `currentKey` — the caller
 * (engine.ts's applyHot) surfaces this as a 409 BEFORE persisting the edit at all.
 */
export function spliceFlow(oldFlow: WorkflowConfig, nextFlow: WorkflowConfig, currentKey: string | null): SpliceFlowResult {
  if (!currentKey) return { ok: true, stages: nextFlow.stages, verifyAfter: nextFlow.verifyAfter };
  // D5 (bug real, hallado en review): el "verify" sintético (stepperFor lo inserta justo tras
  // verifyAfter) no vive en oldFlow.stages — un worker parado ahí ya alcanzó (o pasó) la etapa
  // verifyAfter, así que el límite protegido se ancla AHÍ, nunca se trata como "nada que
  // proteger" (eso saltaba STAGE_IN_FLIGHT justo para el caso donde el worker está más lejos).
  const anchorKey = currentKey === "verify" ? oldFlow.verifyAfter : currentKey;
  const idx = anchorKey ? oldFlow.stages.findIndex((s) => s.key === anchorKey) : -1;
  if (idx < 0) {
    // Un currentKey que no se puede ubicar de forma segura (ni una etapa real ni "verify"
    // resoluble contra verifyAfter) se rechaza CONSERVADOR — proteger de más nunca es el bug;
    // asumir "no hay nada que proteger" sí lo era.
    return {
      ok: false,
      code: "STAGE_IN_FLIGHT",
      message: `no se pudo ubicar de forma segura la etapa en curso ("${currentKey}") en el flow congelado; se rechaza el cambio en vez de asumir que no hay nada que proteger`,
    };
  }
  const prefix = oldFlow.stages.slice(0, idx + 1);
  for (let i = 0; i < prefix.length; i++) {
    if (nextFlow.stages[i]?.key !== prefix[i].key) {
      return {
        ok: false,
        code: "STAGE_IN_FLIGHT",
        message: `la etapa "${prefix[i].key}" ya está en curso (sentinel escrito); no puede eliminarse, renombrarse ni reordenarse mientras un worker sigue en ella o más allá`,
      };
    }
  }
  const stages = [...prefix, ...nextFlow.stages.slice(prefix.length)];
  const verifyAfter = nextFlow.verifyAfter && stages.some((s) => s.key === nextFlow.verifyAfter) ? nextFlow.verifyAfter : null;
  return { ok: true, stages, verifyAfter };
}

export interface GraphNode {
  key: string;
  label: string;
  icon: string;
  role?: "impl";
  gate?: boolean; // P2: has a verifyCmd gating advancement
}
export type GraphEdgeKind = "sequence" | "verify" | "retry";
export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  maxRetries?: number; // only on kind:"retry"
}
export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * T12: pure derivation of {nodes, edges} for the graph view — draws only the THREE edge
 * classes that already exist in the engine's semantics today (sequence; the verifier branch
 * via stepperFor/VERIFY_STAGE; the retry self-loop via verifyGateCap/gateHoldsDone), never
 * persisted and never a new `WfStage.next[]`. The six engine functions that walk a flow by
 * INDEX (implStageIndex, shouldSwitchModel, verifyGateCap, eligibleVerifyStages, stepperFor,
 * liveMapFor) and detectStage's "furthest sentinel wins" model would all need rewriting to
 * support arbitrary branching that no workflow today expresses — this draws only what's real.
 */
export function toGraph(cfg: WorkflowConfig): WorkflowGraph {
  const nodes: GraphNode[] = cfg.stages.map((s) => ({
    key: s.key,
    label: s.label,
    icon: s.icon,
    ...(s.role === "impl" ? { role: "impl" as const } : {}),
    ...(s.verifyCmd ? { gate: true as const } : {}),
  }));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < cfg.stages.length - 1; i++) {
    edges.push({ from: cfg.stages[i].key, to: cfg.stages[i + 1].key, kind: "sequence" });
  }
  if (cfg.verifyAfter && cfg.stages.some((s) => s.key === cfg.verifyAfter)) {
    nodes.push({ key: VERIFY_STAGE.key, label: VERIFY_STAGE.label, icon: VERIFY_STAGE.icon });
    edges.push({ from: cfg.verifyAfter, to: VERIFY_STAGE.key, kind: "verify" });
  }
  for (const s of cfg.stages) {
    if (s.verifyCmd) edges.push({ from: s.key, to: s.key, kind: "retry", maxRetries: s.maxRetries ?? 2 });
  }
  return { nodes, edges };
}

/**
 * Resolve the flow for a launch: optionally restricted to a subset of stage keys
 * (the per-launch on/off toggles). If `repo` has a workflow override it starts
 * from the override's stages/verifyAfter; otherwise from the global default.
 * Without `repo` (or with no override) this is byte-identical to the previous
 * behavior — the per-launch stageKeys filter is unchanged.
 */
export function resolveFlow(
  stageKeys?: string[],
  repo?: string
): { stages: WfStage[]; verifyAfter: string | null } {
  const override = repo ? getRepoWorkflow(repo) : null;
  const all = override ? override.stages : getStages();
  const va = override ? override.verifyAfter : getVerifyAfter();
  if (!stageKeys || !stageKeys.length) return { stages: all, verifyAfter: va };
  const set = new Set(stageKeys);
  const stages = all.filter((s) => set.has(s.key));
  if (!stages.length) return { stages: all, verifyAfter: va };
  return { stages, verifyAfter: va && set.has(va) ? va : null };
}

/**
 * Stages for the stepper + live board: the configured stages with the synthetic
 * "verify" inserted right after verifyAfter (when it matches a real stage).
 */
export function getStepperStages(): WfStage[] {
  const { stages, verifyAfter } = load();
  return stepperFor(stages, verifyAfter);
}

export interface LiveStage {
  key: string;
  label: string;     // "🌐 Curl" — shown as worker.stage
  task: TaskStatus;
  worker: WorkerState;
}

/** key → board state mapping for an arbitrary flow (drives pollLive). */
export function liveMapFor(stages: WfStage[], verifyAfter: string | null): Map<string, LiveStage> {
  const out = new Map<string, LiveStage>();
  const stepper = stepperFor(stages, verifyAfter);
  // The last configured (main) stage is terminal, regardless of its key — so
  // renaming "done" to anything still completes the card.
  const lastMain = stages[stages.length - 1]?.key;
  for (const s of stepper) {
    const isVerify = s.key === "verify";
    const isDone = !isVerify && (s.key === "done" || s.key === lastMain);
    out.set(s.key, {
      key: s.key,
      label: `${s.icon} ${s.label}`,
      task: isDone ? "done" : isVerify ? "review" : "running",
      worker: isDone ? "done" : isVerify ? "review" : "busy",
    });
  }
  return out;
}

/** key → board state mapping for the full (global) workflow. */
export function liveStageByKey(): Map<string, LiveStage> {
  const { stages, verifyAfter } = load();
  return liveMapFor(stages, verifyAfter);
}
