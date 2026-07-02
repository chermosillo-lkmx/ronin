import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateStages, type WfStage, type WorkflowConfig } from "./workflow.js";
import type { CustomAction } from "./types.js";

/**
 * Store editable de las acciones/flujos definidos por el usuario (opción A). Mismo patrón
 * que prompts.ts/workflow.ts/repo-config.ts: mutable en memoria, validate-on-load (nunca
 * throw), writeFileSync + reload. data/actions.json NO gitignored (sin secretos; los prompts
 * son plantillas). Las etapas propias se validan con validateStages (reglas RESERVED_KEYS /
 * dedup / ≥1 etapa / verifyAfter viven en un solo sitio). NO importa engine.ts (store puro).
 */
const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "actions.json");
const COMMENT =
  "Acciones/flujos definidos por el usuario. Cada acción = un botón en las tareas con su prompt, " +
  "etapas propias (o inheritWorkflow → workflow global/por-repo) y flags. Editable desde ⚡ Configuración → Acciones o a mano.";

// El key va en /api/tasks/:id/action/:key (subpath distinto, no colisiona de verdad con
// /launch|/research), pero se reservan por claridad + convención.
export const RESERVED_ACTION_KEYS = ["launch", "research"];
const SHOW = ["row", "preview"] as const;

// slug idéntico a workflow.ts/repo-config.ts (mismo alfabeto, 40 chars).
function slug(s: string): string {
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function normShowOn(v: unknown): ("row" | "preview")[] {
  const out = Array.isArray(v) ? SHOW.filter((s) => v.includes(s)) : [];
  return out.length ? out : [...SHOW];
}

// Normaliza una acción. strict=true (saveActions) lanza en dato inválido; strict=false (load)
// descarta la entrada (retorna null) — dos niveles como repo-config.ts/workflow.ts vs saveWorkflow.
function build(raw: any, strict: boolean): CustomAction | null {
  const key = slug(raw?.key ?? "");
  if (!key) {
    if (strict) throw new Error("cada acción necesita un key");
    return null;
  }
  if (RESERVED_ACTION_KEYS.includes(key)) {
    if (strict) throw new Error(`la key "${key}" está reservada; usa otra`);
    return null;
  }
  const inheritWorkflow = raw?.inheritWorkflow === true;
  let stages: WfStage[] = [];
  let verifyAfter: string | null = null;
  if (!inheritWorkflow) {
    try {
      ({ stages, verifyAfter } = validateStages(raw as Partial<WorkflowConfig>)); // throw → 400 (strict) / drop (load)
    } catch (e) {
      if (strict) throw e;
      return null;
    }
  }
  return {
    key,
    label: String(raw?.label ?? "").trim() || key,
    icon: String(raw?.icon ?? "").trim() || "⚡",
    prompt: typeof raw?.prompt === "string" ? raw.prompt : "",
    stages,
    verifyAfter,
    inheritWorkflow,
    readOnly: raw?.readOnly === true,
    showOn: normShowOn(raw?.showOn),
  };
}

// Distrust disk: descarta entradas inválidas/duplicadas. Nunca throw (getAction corre en cada launch).
function load(): CustomAction[] {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    const list = Array.isArray(raw?.actions) ? raw.actions : [];
    const seen = new Set<string>();
    const out: CustomAction[] = [];
    for (const r of list) {
      const a = build(r, false);
      if (a && !seen.has(a.key)) {
        seen.add(a.key);
        out.push(a);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// Lazy init so module eval never does I/O.
let store: CustomAction[] | null = null;
const S = (): CustomAction[] => (store ??= load());

const clone = (a: CustomAction): CustomAction => ({
  ...a,
  stages: a.stages.map((s) => ({ ...s })),
  showOn: [...a.showOn],
});

export function getActions(): CustomAction[] {
  return S().map(clone);
}

export function getAction(key: string): CustomAction | null {
  return S().find((a) => a.key === slug(key)) ?? null; // slug del arg — la ruta lo pasa crudo
}

/** Valida + persiste el registro completo, luego recarga. Dato inválido → throw (→400 en la ruta). */
export function saveActions(input: unknown): CustomAction[] {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: CustomAction[] = [];
  for (const raw of list) {
    const a = build(raw, true)!; // strict → lanza
    if (seen.has(a.key)) throw new Error(`key duplicada: "${a.key}"`);
    seen.add(a.key);
    out.push(a);
  }
  writeFileSync(FILE, JSON.stringify({ _comment: COMMENT, actions: out }, null, 2) + "\n");
  store = out;
  return getActions();
}
