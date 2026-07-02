import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_CMD } from "./config.js";
import { validateStages, type WorkflowConfig } from "./workflow.js";

/**
 * Per-repo overrides of the composable workflow, keyed by repo. Each repo can
 * carry its own full `workflow` (absent → inherit the global default), a set of
 * `vars` (test URLs/tokens written into the cycle's curl.env + exposed as
 * {var:KEY} in the prompt) and a `startCommand` (absent → CLAUDE_CMD). Mirrors
 * the settings.ts/repos.ts store pattern: mutable in-memory, validate-on-load,
 * writeFileSync + reload on save. server/data/repo-config.json is gitignored
 * (vars may hold tokens); values are never logged.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "repo-config.json");
const COMMENT =
  "Overrides por repo: workflow (opcional; si falta → default global), vars (URLs/tokens de prueba) y " +
  "startCommand (opcional; si falta → CLAUDE_CMD). Gitignored. Editable desde ⚙ Configuración → Workflows o a mano.";

interface RepoEntry {
  workflow?: WorkflowConfig; // validated on load; absent → inherit default
  vars?: Record<string, string>;
  startCommand?: string;
}
type Store = Record<string, RepoEntry>;

// env-var-safe key; single-line value (a newline would inject extra curl.env lines).
const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Keep only string→string entries with a valid key and a single-line value. */
function sanitizeVars(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object")
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      if (typeof val === "string" && VAR_KEY.test(k) && !/[\r\n]/.test(val)) out[k] = val;
  return out;
}

function sanitizeEntry(raw: any): RepoEntry {
  const e: RepoEntry = {};
  if (raw?.workflow) {
    try {
      e.workflow = validateStages(raw.workflow);
    } catch {
      /* drop an invalid override on load — fall back to default */
    }
  }
  if (raw?.vars !== undefined) e.vars = sanitizeVars(raw.vars);
  if (typeof raw?.startCommand === "string" && raw.startCommand.trim()) e.startCommand = raw.startCommand.trim();
  return e;
}

// Distrust disk (hand-edited JSON); a missing/invalid file → {} (the normal no-override case).
// resolveFlow() calls getRepoWorkflow → load() on every live launch, so this must never throw.
function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    const out: Store = {};
    for (const [repo, entry] of Object.entries(raw))
      if (!repo.startsWith("_") && entry && typeof entry === "object") out[slugKey(repo)] = sanitizeEntry(entry);
    return out;
  } catch {
    return {};
  }
}

// Lazy init so module evaluation never calls validateStages (breaks the repo-config↔workflow cycle).
let store: Store | null = null;
const S = (): Store => (store ??= load());

/** Normalize a repo key the same way workflow.ts slug()/repos.ts slugKey() do. */
function slugKey(s: string): string {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// ---- getters (per-call; null/{}/CLAUDE_CMD fallbacks = inherit default) ----
export function getRepoWorkflow(repo: string): WorkflowConfig | null {
  const wf = S()[slugKey(repo)]?.workflow;
  return wf ? { stages: wf.stages.map((s) => ({ ...s })), verifyAfter: wf.verifyAfter } : null;
}
export function getRepoVars(repo: string): Record<string, string> {
  return { ...(S()[slugKey(repo)]?.vars ?? {}) };
}
export function getRepoStartCommand(repo: string): string {
  const sc = S()[slugKey(repo)]?.startCommand; // "" is NOT caught by ?? — treat blank as not-set
  return sc && sc.trim() ? sc : CLAUDE_CMD;
}

// ---- read (for the editor UI) / save ----
export interface RepoConfigFull {
  workflow: WorkflowConfig | null;
  vars: Record<string, string>;
  startCommand: string; // RAW stored value ("" when unset), not the effective CLAUDE_CMD
  usesDefaultWorkflow: boolean;
}
export function readRepoConfigFull(repo: string): RepoConfigFull {
  const entry = S()[slugKey(repo)];
  const wf = getRepoWorkflow(repo);
  return {
    workflow: wf,
    vars: getRepoVars(repo),
    startCommand: entry?.startCommand ?? "", // raw: empty means "inherit CLAUDE_CMD"
    usesDefaultWorkflow: !wf,
  };
}

/**
 * Validate + persist a repo's overrides, then reload. vars/startCommand persist
 * regardless of workflow inheritance. inheritWorkflow (or no stages) removes ONLY
 * the workflow field. An entry with no workflow, no vars and no startCommand is
 * dropped entirely to keep the file clean. Throws (→ 400) on an invalid workflow.
 */
export function saveRepoOverrides(
  repo: string,
  input: { workflow?: unknown; vars?: unknown; startCommand?: unknown; inheritWorkflow?: boolean }
): RepoConfigFull {
  const key = slugKey(repo);
  const entry: RepoEntry = {};
  if (!input.inheritWorkflow && input.workflow && Array.isArray((input.workflow as any).stages)) {
    entry.workflow = validateStages(input.workflow as Partial<WorkflowConfig>); // throw → 400
  }
  entry.vars = sanitizeVars(input.vars);
  const sc = typeof input.startCommand === "string" ? input.startCommand.trim() : "";
  if (sc) entry.startCommand = sc;

  const next: Store = { ...S() };
  if (!entry.workflow && Object.keys(entry.vars).length === 0 && !entry.startCommand) delete next[key];
  else next[key] = entry;

  writeFileSync(FILE, JSON.stringify({ _comment: COMMENT, ...next }, null, 2) + "\n");
  store = next;
  return readRepoConfigFull(repo);
}
