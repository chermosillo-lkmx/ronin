import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
