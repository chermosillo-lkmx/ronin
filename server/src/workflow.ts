import { readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./data-dir.js";
import { getRepoWorkflow } from "./repo-config.js";
import { sanitizeModel } from "./models.js";

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
  executor?: "claude" | "codex" | "agy"; // tool that executes this stage; absent inherits the flow's current worker
  model?: string;        // optional executor-specific model, sanitized on input
  verifyCmd?: string;   // P2: shell cmd (exit 0 = pass) gating advancement past this stage. ONLY honored
                        // from the gitignored per-repo override (stripped everywhere git-tracked — RCE guard).
  maxRetries?: number;  // P2: max verify attempts before the stage is marked failed (default 2).
}

/** Entrada declarada de un workflow; habilita lanzamientos estructurados sin petición libre. */
export interface WfInput {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

export interface WorkflowConfig {
  stages: WfStage[];
  verifyAfter: string[]; // stages reviewed by the independent verifier (empty = none)
  /** Ausente conserva el lanzamiento histórico con una única petición libre. */
  inputs?: WfInput[];
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
  verifyAfter: ["curl"],
  stages: [
    { key: "planning", label: "Plan", icon: "📋", instruction: "Escribe un plan breve de la implementación y los artefactos a entregar." },
    { key: "implementing", label: "Impl", icon: "⌨️", role: "impl", instruction: "Implementa la solución." },
    { key: "curl", label: "Curl", icon: "🌐", instruction: "Pruebas CURL contra DEV: ejecuta `source {cycle}/curl.env` (te da $DEV_URL, $TOKEN, $ACCOUNTING_FIRM; no los pidas). Corre los curl relevantes y guarda comando + request body + response body en {ev}/curl.md." },
    { key: "done", label: "Done", icon: "✓", instruction: "Escribe {ev}/summary.md (comentario listo para el ticket)." },
  ],
};

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
  const validated = validateStages({ stages: rawStages, verifyAfter: raw?.verifyAfter, inputs: raw?.inputs }, { strict: false });
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

export function getVerifyAfter(): string[] {
  return [...load().verifyAfter];
}

/** Full config (deep copy) — for the editor UI. */
export function getWorkflow(): WorkflowConfig {
  const { stages, verifyAfter, inputs } = load();
  return { stages: stages.map((s) => ({ ...s })), verifyAfter: [...verifyAfter], ...(inputs ? { inputs: inputs.map((input) => ({ ...input })) } : {}) };
}

function slug(s: string): string {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// Keys that collide with infrastructure inside the cycle dir and can never work
// as a stage sentinel: "verify" (synthetic verifier step) and "evidence" (the
// evidence/ subdirectory). curl.env is a file but "curl" !== "curl.env", so ok.
export const RESERVED_KEYS = ["verify", "evidence"];

// These names are replaced by renderPrompt in the workflow prompt. An input called "steps"
// would overwrite the entire workflow prompt flow, so declared inputs must never use them.
export const WORKFLOW_PROMPT_RESERVED_KEYS = [
  "kind", "reqline", "title", "ref", "desc", "steps", "verifier", "cycle", "ev", "repo", "key", "body", "url",
];

/**
 * Stepper fijo del modo Driver (como RESEARCH_STAGES: desacoplado del workflow.json componible).
 *
 * Tres restricciones que dictan estas keys, todas con dientes:
 * 1. `verifyAfter: []` es OBLIGATORIO: el Driver gestiona sus cuatro panes directamente.
 * 2. La etapa de verificación NO se llama "verify": sigue siendo RESERVED_KEY para no chocar
 *    con los sentinels de sesiones históricas.
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
export const DRIVER_FLOW: WorkflowConfig = {
  stages: DRIVER_STAGES,
  verifyAfter: [],
};

export interface ValidateStagesOptions {
  allowVerifyCmd?: boolean; // P2/B3: verifyCmd only honored from the gitignored per-repo override.
  strict?: boolean;         // T11: strict=editing (throws WorkflowValidationError); tolerant=loading (never throws).
}

export type WorkflowConfigInput = Partial<Omit<WorkflowConfig, "verifyAfter">> & { verifyAfter?: unknown };

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
  if (verifyAfterRaw !== undefined && verifyAfterRaw !== null && typeof verifyAfterRaw !== "string" && !Array.isArray(verifyAfterRaw)) {
    throw new WorkflowValidationError("verifyAfter", "VERIFY_AFTER_TYPE", "verifyAfter debe ser una lista de keys, una key legado o null");
  }
  const entries = Array.isArray(verifyAfterRaw) ? verifyAfterRaw : typeof verifyAfterRaw === "string" ? [verifyAfterRaw] : [];
  for (let i = 0; i < entries.length; i++) {
    if (typeof entries[i] !== "string") {
      throw new WorkflowValidationError(`verifyAfter[${i}]`, "VERIFY_AFTER_TYPE", "cada entrada de verifyAfter debe ser una key string");
    }
    const va = slug(entries[i]);
    if (va && !seen.has(va)) {
      throw new WorkflowValidationError(
        `verifyAfter[${i}]`,
        "VERIFY_AFTER_UNKNOWN",
        `verifyAfter "${entries[i]}" no coincide con ninguna etapa; keys válidas: ${Array.from(seen).join(", ")}`
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
export function validateStages(input: WorkflowConfigInput, options: ValidateStagesOptions = {}): WorkflowConfig {
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
      const executor = s?.executor === "claude" || s?.executor === "codex" || s?.executor === "agy" ? s.executor : undefined;
      const model = sanitizeModel(typeof s?.model === "string" ? s.model : "");
      return {
        key: slug(s?.key ?? ""),
        label: String(s?.label ?? "").trim() || (s?.key ?? "stage"),
        icon: String(s?.icon ?? "").trim() || "•",
        instruction: typeof s?.instruction === "string" ? s.instruction : "",
        ...(s?.role === "impl" ? { role: "impl" as const } : {}),
        ...(executor ? { executor } : {}),
        ...(model ? { model } : {}),
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
    return { stages: [], verifyAfter: [] };
  }
  const bad = stages.find((s) => RESERVED_KEYS.includes(s.key));
  if (bad) {
    if (strict) throw new WorkflowValidationError(`stages.${bad.key}`, "RESERVED_KEY", `la key "${bad.key}" está reservada; usa otra (p. ej. "done", "summary")`);
    throw new Error(`la key "${bad.key}" está reservada; usa otra (p. ej. "done", "summary")`);
  }
  const rawVerifyAfter: unknown = input.verifyAfter;
  const verifyEntries = Array.isArray(rawVerifyAfter)
    ? rawVerifyAfter.filter((entry): entry is string => typeof entry === "string")
    : typeof rawVerifyAfter === "string" ? [rawVerifyAfter] : [];
  const requested = new Set(verifyEntries.map(slug).filter(Boolean));
  const verifyAfter = stages.filter((stage) => requested.has(stage.key)).map((stage) => stage.key);
  const seenInputs = new Set<string>();
  const inputs: WfInput[] = (Array.isArray(input.inputs) ? input.inputs : [])
    .map((raw: any) => {
      const rawKey = typeof raw?.key === "string" ? raw.key.trim() : "";
      const key = slug(rawKey);
      const label = typeof raw?.label === "string" ? raw.label.trim() : "";
      if (!key || key !== rawKey || !label || WORKFLOW_PROMPT_RESERVED_KEYS.includes(key) || seenInputs.has(key)) return null;
      seenInputs.add(key);
      const placeholder = typeof raw?.placeholder === "string" ? raw.placeholder.trim() : undefined;
      return {
        key,
        label,
        ...(placeholder ? { placeholder } : {}),
        ...(raw?.required === true ? { required: true } : {}),
      };
    })
    .filter((entry): entry is WfInput => entry !== null);
  return { stages, verifyAfter, ...(inputs.length ? { inputs } : {}) };
}

/** Validate + persist the workflow to disk, invalidating the cache. */
export function saveWorkflow(input: WorkflowConfigInput): WorkflowConfig {
  const cfg = validateStages(input, { strict: true });
  writeFileSync(
    WORKFLOW_PATH,
    JSON.stringify(
      {
        _comment:
          "Etapas del workflow para tickets. Editable desde el dashboard (⚙ Workflow) o a mano. key=sentinel (touch), label/icon=stepper, instruction=qué pedirle (placeholders {cycle} {ev} {repo}). verifyAfter: lista de etapas tras las cuales pedir revisión ([]=ninguna). NOTA: verifyCmd/maxRetries (gate pass/fail por-stage) se IGNORAN aquí — este archivo es git-tracked y verifyCmd ejecuta shell; sólo el override por-repo (gitignored) los honra.",
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
): WorkflowConfig {
  const override = repo ? getRepoWorkflow(repo) : null;
  const all = override ? override.stages : getStages();
  const va = override ? override.verifyAfter : getVerifyAfter();
  if (!stageKeys || !stageKeys.length) return { stages: all, verifyAfter: va };
  const set = new Set(stageKeys);
  const stages = all.filter((s) => set.has(s.key));
  if (!stages.length) return { stages: all, verifyAfter: va };
  return { stages, verifyAfter: va.filter((key) => set.has(key)) };
}
