import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRepoWorkflow } from "./repo-config.js";
import type { TaskStatus, WorkerState } from "./types.js";

/**
 * Composable workflow: the loop stages live in data/workflow.json so new
 * components (comment code, security review, …) can be added/removed/reordered
 * without touching code. Each stage becomes a numbered step in the worker prompt
 * AND a step in the visual stepper. Edit the JSON and restart the server.
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

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(here, "..", "data", "workflow.json");

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

function load(): WorkflowConfig {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"));
    const stages: WfStage[] = Array.isArray(raw.stages)
      ? raw.stages
          .filter((s: any) => s && typeof s.key === "string" && s.key[0] !== "_")
          // Strip verifyCmd/maxRetries: the global workflow.json is git-tracked, so a committed
          // verifyCmd must NOT execute (B3). Only the gitignored per-repo override honors it.
          .map((s: any) => stripVerifyFields(s))
      : [];
    cache = {
      stages: stages.length ? stages : DEFAULT.stages,
      verifyAfter: raw.verifyAfter === null ? null : typeof raw.verifyAfter === "string" ? raw.verifyAfter : DEFAULT.verifyAfter,
    };
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
 * Validate + normalize a workflow config (slug keys, dedupe, reserved-key check,
 * ≥1 stage, verifyAfter must match a stage). Throws on invalid input. Shared by
 * saveWorkflow (global) and the per-repo override store (repo-config.ts) so the
 * validation rules live in exactly one place.
 */
export function validateStages(input: Partial<WorkflowConfig>, allowVerifyCmd = false): WorkflowConfig {
  const seen = new Set<string>();
  const stages: WfStage[] = (Array.isArray(input.stages) ? input.stages : [])
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
  if (!stages.length) throw new Error("el workflow necesita al menos una etapa");
  const bad = stages.find((s) => RESERVED_KEYS.includes(s.key));
  if (bad) throw new Error(`la key "${bad.key}" está reservada; usa otra (p. ej. "done", "summary")`);
  const va = input.verifyAfter ? slug(input.verifyAfter) : null;
  const verifyAfter = va && stages.some((s) => s.key === va) ? va : null;
  return { stages, verifyAfter };
}

/** Validate + persist the workflow to disk, invalidating the cache. */
export function saveWorkflow(input: Partial<WorkflowConfig>): WorkflowConfig {
  const cfg = validateStages(input);
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
