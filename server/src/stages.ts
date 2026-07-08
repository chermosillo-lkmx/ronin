import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStepperStages } from "./workflow.js";

/** Loop stages in order, derived from the composable workflow (data/workflow.json). */
export function stageOrder(): string[] {
  return getStepperStages().map((s) => s.key);
}

/**
 * Cycle dir keyed by the (stable) tmux session name, not the ephemeral worker id.
 * This way a server restart that rediscovers the session lands on the same dir,
 * preserving stage sentinels and evidence.
 */
export function cycleDirForSession(session: string): string {
  return `/tmp/cowork-cycle-${session}`;
}

export function evidenceDir(cycle: string): string {
  return join(cycle, "evidence");
}

export function ensureCycleDir(cycle: string): void {
  mkdirSync(cycle, { recursive: true });
  mkdirSync(evidenceDir(cycle), { recursive: true });
}

export function removeCycleDir(cycle: string): void {
  try {
    rmSync(cycle, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

// ---- F0: per-launch model info + plan→impl switch latch (persisted in the cycle dir
// so it survives a server restart; keyed by session like everything else here). ----

export interface ModelsInfo {
  worker: string;        // sanitized Worker model to switch to at plan→impl
  switchEnabled: boolean; // true only for implementer launches (not research/PR)
}
const MODELS_FILE = "models.json";
const SWITCHED_LATCH = "model-switched";
const SWITCH_FAILED_LATCH = "model-switch-failed";

/** Persist the per-launch model info for the plan→impl switch. */
export function writeModelsInfo(cycle: string, info: ModelsInfo): void {
  try {
    writeFileSync(join(cycle, MODELS_FILE), JSON.stringify(info));
  } catch {
    /* best-effort */
  }
}

/** Read the per-launch model info (null when absent/unreadable). */
export function readModelsInfo(cycle: string): ModelsInfo | null {
  try {
    const raw = JSON.parse(readFileSync(join(cycle, MODELS_FILE), "utf8"));
    if (raw && typeof raw.worker === "string") return { worker: raw.worker, switchEnabled: !!raw.switchEnabled };
  } catch {
    /* absent */
  }
  return null;
}

/** True once the plan→impl `/model` switch has been sent+applied for this cycle. */
export function modelSwitched(cycle: string): boolean {
  return existsSync(join(cycle, SWITCHED_LATCH));
}
/** Latch the switch (idempotent across the 2s poller and across restarts). */
export function markModelSwitched(cycle: string): void {
  try {
    writeFileSync(join(cycle, SWITCHED_LATCH), "");
  } catch {
    /* best-effort */
  }
}

/**
 * True once the switch has been abandoned after N failed confirmations. Stops the retry loop
 * WITHOUT claiming success — the worker also gets a visible note. Kept separate from the
 * success latch so we never silently pretend the model changed (point 1).
 */
export function modelSwitchFailed(cycle: string): boolean {
  return existsSync(join(cycle, SWITCH_FAILED_LATCH));
}
export function markModelSwitchFailed(cycle: string): void {
  try {
    writeFileSync(join(cycle, SWITCH_FAILED_LATCH), "");
  } catch {
    /* best-effort */
  }
}

// P1h: persisted latch (in the PARENT cycle dir) recording that the independent verifier was
// already spawned — so a rediscovered main worker parked at verifyAfter doesn't spawn a second
// verifier after a restart (the in-memory verifierFor set is lost on restart).
const VERIFIER_LATCH = "verifier-spawned";
export function verifierSpawned(cycle: string): boolean {
  return existsSync(join(cycle, VERIFIER_LATCH));
}
export function markVerifierSpawned(cycle: string): void {
  try {
    writeFileSync(join(cycle, VERIFIER_LATCH), "");
  } catch {
    /* best-effort */
  }
}

// ---- P2: per-stage verifyCmd gate state (persisted in the cycle dir → survives restart, so a
// restart can't reset the retry counter and loop the command forever). ----

export type VerifyStatus = "pending" | "passed" | "failed";
export interface VerifyState {
  attempts: number;
  status: VerifyStatus;
}
// stage keys are slugs ([a-z0-9-]) so they're safe as a filename component.
const verifyFile = (stageKey: string): string => `verify-${stageKey}.json`;

export function readVerifyState(cycle: string, stageKey: string): VerifyState | null {
  try {
    const raw = JSON.parse(readFileSync(join(cycle, verifyFile(stageKey)), "utf8"));
    if (raw && typeof raw.attempts === "number" && typeof raw.status === "string")
      return { attempts: raw.attempts, status: raw.status as VerifyStatus };
  } catch {
    /* absent */
  }
  return null;
}

export function writeVerifyState(cycle: string, stageKey: string, state: VerifyState): void {
  try {
    writeFileSync(join(cycle, verifyFile(stageKey)), JSON.stringify(state));
  } catch {
    /* best-effort */
  }
}

/** A stage's verifyCmd has confirmed pass (advancement past it is allowed). */
export function verifyPassed(cycle: string, stageKey: string): boolean {
  return readVerifyState(cycle, stageKey)?.status === "passed";
}

/** Furthest stage whose sentinel file exists in the cycle dir, or null. */
export function detectStage(cycle: string, order: string[] = stageOrder()): string | null {
  let found: string | null = null;
  try {
    // Only count regular files: the `evidence/` subdir must never be mistaken for
    // a stage sentinel (a stage keyed "evidence" would otherwise always match).
    const files = new Set(
      readdirSync(cycle, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name)
    );
    for (const k of order) if (files.has(k)) found = k;
  } catch {
    return null;
  }
  return found;
}

export interface Evidence {
  summary: string | null;
  research: string | null;
  curl: string | null;
  ui: string | null;
  verdict: string | null;
  images: string[];
}

function readIf(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), "utf8");
  } catch {
    return null;
  }
}

/** Read the worker's evidence artifacts (markdown + screenshot filenames). */
export function readEvidence(cycle: string): Evidence {
  const dir = evidenceDir(cycle);
  let images: string[] = [];
  try {
    images = readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
  } catch {
    /* no evidence dir yet */
  }
  return {
    summary: readIf(dir, "summary.md"),
    research: readIf(dir, "research.md"),
    curl: readIf(dir, "curl.md"),
    ui: readIf(dir, "ui.md"),
    verdict: readIf(dir, "verdict.md"),
    images,
  };
}
