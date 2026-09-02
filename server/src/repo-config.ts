import { readFileSync, writeFileSync } from "node:fs";
import { CLAUDE_CMD, PLANNER_MODEL, WORKER_MODEL } from "./config.js";
import { dataPath } from "./data-dir.js";
import { sanitizeModel } from "./models.js";
import { validateStages, type WorkflowConfig } from "./workflow.js";
import { listRepos } from "./repos.js";

export type SkillRoot = "global" | "repo-claude" | "repo-skills";
export interface SkillRef {
  root: SkillRoot;
  name: string;
  /** Required for a repository root so two repos can legitimately expose the same name. */
  sourceRepo?: string;
}

/**
 * Per-repo overrides of the composable workflow, keyed by repo. Each repo can
 * carry its own full `workflow` (absent → inherit the global default), a set of
 * `vars` (test URLs/tokens written into the cycle's curl.env + exposed as
 * {var:KEY} in the prompt), a `startCommand` (absent → CLAUDE_CMD) and per-role
 * models `plannerModel`/`workerModel` (absent → PLANNER_MODEL/WORKER_MODEL).
 * Mirrors the settings.ts/repos.ts store pattern: mutable in-memory,
 * validate-on-load, writeFileSync + reload on save. server/data/repo-config.json
 * is gitignored (vars may hold tokens); values are never logged.
 */
const FILE = dataPath("repo-config.json");
const COMMENT =
  "Overrides por repo: workflow (opcional; si falta → default global), vars (URLs/tokens de prueba), " +
  "startCommand (opcional; si falta → CLAUDE_CMD), setupCommand (opcional; comando shell que arma el " +
  "entorno de dependencias de cada worktree nuevo: sin él, la copia de la sesión no puede correr sus " +
  "propias pruebas) y plannerModel/workerModel (opcional; si faltan → " +
  "COWORK_PLANNER_MODEL/COWORK_WORKER_MODEL). Las etapas del workflow aquí PUEDEN llevar verifyCmd " +
  "(comando shell que ejecuta el gate por-stage) — sólo se honra aquí (gitignored, mismo trust boundary " +
  "que startCommand/vars); en el workflow global (git-tracked) se ignora. Editable desde ⚙ Configuración → Workflows o a mano.";

interface RepoEntry {
  workflow?: WorkflowConfig; // validated on load; absent → inherit default
  vars?: Record<string, string>;
  startCommand?: string;
  setupCommand?: string;  // arma el entorno de un worktree nuevo; absent → no se provisiona
  plannerModel?: string; // sanitized model alias/id; absent → inherit PLANNER_MODEL
  workerModel?: string;  // sanitized model alias/id; absent → inherit WORKER_MODEL
  skills?: SkillRef[];
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

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
function sanitizeSkillRefs(value: unknown): SkillRef[] {
  if (!Array.isArray(value)) return [];
  const allowedRepos = new Set(listRepos());
  const seen = new Set<string>();
  const refs: SkillRef[] = [];
  for (const raw of value) {
    const candidate = raw as Partial<SkillRef>;
    const root = candidate?.root;
    const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
    const sourceRepo = typeof candidate?.sourceRepo === "string" ? candidate.sourceRepo.trim() : "";
    if ((root !== "global" && root !== "repo-claude" && root !== "repo-skills") || !SKILL_NAME.test(name)) continue;
    if (root === "global") {
      const key = `${root}:${name}`;
      if (!seen.has(key)) { seen.add(key); refs.push({ root, name }); }
      continue;
    }
    if (!sourceRepo || !allowedRepos.has(sourceRepo)) continue;
    const key = `${root}:${sourceRepo}:${name}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ root, name, sourceRepo }); }
  }
  return refs;
}

/** T11: exported for direct unit testing of the tolerant (load) contract — see repo-config.test.ts. */
export function sanitizeEntry(raw: any): RepoEntry {
  const e: RepoEntry = {};
  if (raw?.workflow) {
    // Tolerant contract never throws for a malformed workflow (T11) — the try/catch is
    // defense-in-depth against the one throw validateStages keeps unconditional (RESERVED_KEYS),
    // matching this module's own invariant that load() must never throw (resolveFlow calls it
    // on every live launch). An input with zero surviving stages falls to "no override" (inherit
    // the default) rather than setting an empty workflow.
    try {
      const validated = validateStages(raw.workflow, { allowVerifyCmd: true, strict: false }); // gitignored → verifyCmd allowed (P2/B3)
      if (validated.stages.length) e.workflow = validated;
    } catch {
      /* drop an invalid override on load — fall back to default */
    }
  }
  if (raw?.vars !== undefined) e.vars = sanitizeVars(raw.vars);
  if (typeof raw?.startCommand === "string" && raw.startCommand.trim()) e.startCommand = raw.startCommand.trim();
  if (typeof raw?.setupCommand === "string" && raw.setupCommand.trim()) e.setupCommand = raw.setupCommand.trim();
  // F5: charset defense-in-depth — a hand-edited `opus; rm -rf ~` never survives load.
  const pm = sanitizeModel(typeof raw?.plannerModel === "string" ? raw.plannerModel : "");
  const wm = sanitizeModel(typeof raw?.workerModel === "string" ? raw.workerModel : "");
  if (pm) e.plannerModel = pm;
  if (wm) e.workerModel = wm;
  e.skills = sanitizeSkillRefs(raw?.skills);
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
/**
 * Comando que arma el entorno de dependencias de un worktree recién creado (`.venv`,
 * `node_modules`…). null = este repo no provisiona nada: sus worktrees salen pelados y el gate
 * de una etapa no tendría con qué correr las pruebas.
 */
export function getRepoSetupCommand(repo: string): string | null {
  const sc = S()[slugKey(repo)]?.setupCommand; // "" NO lo atrapa ?? — en blanco es "no declarado"
  return sc && sc.trim() ? sc : null;
}
export function getRepoPlannerModel(repo: string): string {
  const m = S()[slugKey(repo)]?.plannerModel;
  return m && m.trim() ? m : PLANNER_MODEL;
}
export function getRepoWorkerModel(repo: string): string {
  const m = S()[slugKey(repo)]?.workerModel;
  return m && m.trim() ? m : WORKER_MODEL;
}

// ---- read (for the editor UI) / save ----
export interface RepoConfigFull {
  workflow: WorkflowConfig | null;
  vars: Record<string, string>;
  startCommand: string;  // RAW stored value ("" when unset), not the effective CLAUDE_CMD
  setupCommand: string;  // RAW stored value ("" = este repo no provisiona sus worktrees)
  plannerModel: string;  // RAW stored value ("" = inherit PLANNER_MODEL)
  workerModel: string;   // RAW stored value ("" = inherit WORKER_MODEL)
  usesDefaultWorkflow: boolean;
  skills: SkillRef[];
}
export function readRepoConfigFull(repo: string): RepoConfigFull {
  const entry = S()[slugKey(repo)];
  const wf = getRepoWorkflow(repo);
  return {
    workflow: wf,
    vars: getRepoVars(repo),
    startCommand: entry?.startCommand ?? "", // raw: empty means "inherit CLAUDE_CMD"
    setupCommand: entry?.setupCommand ?? "",  // raw: empty means "no provisionar"
    plannerModel: entry?.plannerModel ?? "", // raw: empty means "inherit PLANNER_MODEL"
    workerModel: entry?.workerModel ?? "",   // raw: empty means "inherit WORKER_MODEL"
    usesDefaultWorkflow: !wf,
    skills: (entry?.skills ?? []).map((ref) => ({ ...ref })),
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
  input: {
    workflow?: unknown;
    vars?: unknown;
    startCommand?: unknown;
    setupCommand?: unknown;
    plannerModel?: unknown;
    workerModel?: unknown;
    inheritWorkflow?: boolean;
    skills?: unknown;
  }
): RepoConfigFull {
  const key = slugKey(repo);
  const entry: RepoEntry = {};
  if (!input.inheritWorkflow && input.workflow && Array.isArray((input.workflow as any).stages)) {
    // Per-repo override is gitignored → the ONE place a verifyCmd may live (P2/B3).
    entry.workflow = validateStages(input.workflow as Partial<WorkflowConfig>, { allowVerifyCmd: true, strict: true }); // throw → 400
  }
  entry.vars = sanitizeVars(input.vars);
  const sc = typeof input.startCommand === "string" ? input.startCommand.trim() : "";
  if (sc) entry.startCommand = sc;
  const setup = typeof input.setupCommand === "string" ? input.setupCommand.trim() : "";
  if (setup) entry.setupCommand = setup;
  // F5: model overrides pass through the same charset sanitizer as load.
  const pm = sanitizeModel(typeof input.plannerModel === "string" ? input.plannerModel : "");
  const wm = sanitizeModel(typeof input.workerModel === "string" ? input.workerModel : "");
  if (pm) entry.plannerModel = pm;
  if (wm) entry.workerModel = wm;
  // Settings/workflow saves predate skills[] and don't send it; retain an existing association
  // in that case. An explicit [] is how the Skills UI clears it.
  entry.skills = input.skills === undefined ? (S()[key]?.skills ?? []).map((ref) => ({ ...ref })) : sanitizeSkillRefs(input.skills);

  const next: Store = { ...S() };
  // Drop-empty predicate MUST include the model fields, else a repo overriding only a
  // model would be silently discarded on save.
  if (
    !entry.workflow &&
    Object.keys(entry.vars).length === 0 &&
    !entry.startCommand &&
    !entry.setupCommand &&
    !entry.plannerModel &&
    !entry.workerModel
    && entry.skills.length === 0
  )
    delete next[key];
  else next[key] = entry;

  writeFileSync(FILE, JSON.stringify({ _comment: COMMENT, ...next }, null, 2) + "\n");
  store = next;
  return readRepoConfigFull(repo);
}
