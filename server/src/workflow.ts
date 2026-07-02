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
}

export interface WorkflowConfig {
  stages: WfStage[];
  verifyAfter: string | null; // spawn the independent verifier after this stage (null = none)
}

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = join(here, "..", "data", "workflow.json");

const DEFAULT: WorkflowConfig = {
  verifyAfter: "curl",
  stages: [
    { key: "planning", label: "Plan", icon: "📋", instruction: "Escribe un plan breve de la implementación y los artefactos a entregar." },
    { key: "implementing", label: "Impl", icon: "⌨️", instruction: "Implementa la solución." },
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
      ? raw.stages.filter((s: any) => s && typeof s.key === "string" && s.key[0] !== "_")
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
export function validateStages(input: Partial<WorkflowConfig>): WorkflowConfig {
  const seen = new Set<string>();
  const stages: WfStage[] = (Array.isArray(input.stages) ? input.stages : [])
    .map((s) => ({
      key: slug(s?.key ?? ""),
      label: String(s?.label ?? "").trim() || (s?.key ?? "stage"),
      icon: String(s?.icon ?? "").trim() || "•",
      instruction: typeof s?.instruction === "string" ? s.instruction : "",
    }))
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
          "Etapas del workflow para tickets. Editable desde el dashboard (⚙ Workflow) o a mano. key=sentinel (touch), label/icon=stepper, instruction=qué pedirle (placeholders {cycle} {ev} {repo}). verifyAfter: etapa tras la cual abrir el verificador (null=ninguno).",
        ...cfg,
      },
      null,
      2
    ) + "\n"
  );
  cache = cfg;
  return cfg;
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
