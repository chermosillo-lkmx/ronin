import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { singleLine, SKILL_DESCRIPTION_MAX_CHARS, SKILL_SUMMARY_MAX_CHARS, type LaunchSkillRef } from "./learned-skills.js";
import { extractJsonObject } from "./memory-distill.js";
import { getPromptTemplate, renderPrompt } from "./prompts.js";
import { readFlow, readVerifyState } from "./stages.js";

/**
 * Entrada y salida de las skills aprendidas (spec §5): el triaje que viaja dentro de la llamada de
 * memoria, el gate determinista y la redacción. Todo es puro o de sólo lectura: la cola, el estado y
 * el `claude -p` viven en memory-distiller.ts.
 */

export const NO_DETERMINISTIC_GATE = "sin gate determinista aprobado";
export const MANUAL_SUMMARY = "(propuesta manual: sin resumen del triaje)";
const RAW_NAME_MAX_CHARS = 200;

export interface SkillTriage {
  name: string;
  summary: string;
  /** Skill `learned` que la sesión mejoró, o null si es nueva. */
  updates: string | null;
}

export type SkillTriageResult = { ok: true; triage: SkillTriage | null } | { ok: false; error: string };

const schemaError = (detail: string): string => `la salida no cumple el esquema de skill: ${detail}`;

/**
 * Parte `skill` de la salida de la destilación. Tolerante: un `skill` inválido sólo invalida el
 * triaje (las entradas de memoria se juzgan aparte). `null`, ausente o `reusable: false` = nada.
 */
export function parseSkillTriage(stdout: string): SkillTriageResult {
  let raw: unknown;
  try {
    raw = extractJsonObject(stdout);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const skill = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { skill?: unknown }).skill : undefined;
  if (skill === undefined || skill === null) return { ok: true, triage: null };
  if (typeof skill !== "object" || Array.isArray(skill)) return { ok: false, error: schemaError("skill debe ser un objeto o null") };
  const { reusable, name, summary, updates } = skill as Record<string, unknown>;
  if (reusable === false) return { ok: true, triage: null };
  if (reusable !== true) return { ok: false, error: schemaError("skill.reusable debe ser true o false") };
  if (typeof name !== "string" || !name.trim() || name.length > RAW_NAME_MAX_CHARS) {
    return { ok: false, error: schemaError(`skill.name debe tener de 1 a ${RAW_NAME_MAX_CHARS} caracteres`) };
  }
  if (typeof summary !== "string" || !summary.trim() || summary.length > SKILL_SUMMARY_MAX_CHARS) {
    return { ok: false, error: schemaError(`skill.summary debe tener de 1 a ${SKILL_SUMMARY_MAX_CHARS} caracteres`) };
  }
  if (updates !== undefined && updates !== null && (typeof updates !== "string" || !updates.trim())) {
    return { ok: false, error: schemaError("skill.updates debe ser el nombre de una skill o null") };
  }
  return { ok: true, triage: { name: name.trim(), summary: singleLine(summary), updates: typeof updates === "string" ? updates.trim() : null } };
}

export type SkillGate = { ok: true } | { ok: false; reason: string };

function sentinelFiles(cycle: string): Set<string> | null {
  try {
    return new Set(readdirSync(cycle, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch {
    return null;
  }
}

/** Todas las etapas de flow.json tienen su centinela (archivo regular) en el cycle dir. */
export function isFlowComplete(cycle: string): boolean {
  const flow = readFlow(cycle);
  const files = sentinelFiles(cycle);
  if (!flow?.stages?.length || !files) return false;
  return flow.stages.every((stage) => typeof stage?.key === "string" && files.has(stage.key));
}

/**
 * Lo que el modelo no puede saltarse: flujo completo, al menos una etapa con `verifyCmd` en estado
 * `passed` y ninguna etapa con su gate en `failed`. Sólo lee flow.json y verify-<etapa>.json.
 */
export function evaluateSkillGate(cycle: string): SkillGate {
  const flow = readFlow(cycle);
  if (!flow?.stages?.length || !isFlowComplete(cycle)) return { ok: false, reason: NO_DETERMINISTIC_GATE };
  const states = flow.stages.map((stage) => ({ stage, verify: readVerifyState(cycle, stage.key) }));
  if (states.some(({ verify }) => verify?.status === "failed")) return { ok: false, reason: NO_DETERMINISTIC_GATE };
  const passed = states.some(({ stage, verify }) => typeof stage.verifyCmd === "string" && stage.verifyCmd.trim() !== "" && verify?.status === "passed");
  return passed ? { ok: true } : { ok: false, reason: NO_DETERMINISTIC_GATE };
}

/** Skills que el índice de lanzamiento le ofreció a la sesión (launch.json.skills). */
export function readOfferedSkills(cycle: string): LaunchSkillRef[] {
  try {
    const raw = JSON.parse(readFileSync(join(cycle, "launch.json"), "utf8")) as { skills?: unknown } | null;
    if (!Array.isArray(raw?.skills)) return [];
    return raw.skills.flatMap((item): LaunchSkillRef[] => {
      if (!item || typeof item !== "object") return [];
      const { root, name, sourceRepo, hash } = item as Record<string, unknown>;
      if (typeof root !== "string" || typeof name !== "string" || typeof hash !== "string") return [];
      return [{ root, name, ...(typeof sourceRepo === "string" ? { sourceRepo } : {}), hash }];
    });
  } catch {
    return [];
  }
}

export function formatOfferedSkills(skills: LaunchSkillRef[]): string {
  return skills.length ? skills.map((skill) => `- ${skill.name} (${skill.root})`).join("\n") : "(ninguna)";
}

export interface SkillDraftPromptInput {
  repo: string;
  session: string;
  request: string;
  evidence: string;
  /** Resumen del triaje; vacío en la propuesta manual. */
  summary: string;
  catalog: string;
  /** SKILL.md actual cuando el triaje pidió una actualización. */
  current: string | null;
}

export function buildSkillDraftPrompt(input: SkillDraftPromptInput, template = getPromptTemplate("skill")): string {
  return renderPrompt(template, {
    repo: input.repo,
    session: input.session,
    summary: input.summary.trim() || MANUAL_SUMMARY,
    request: input.request.trim() || "(sin petición registrada)",
    evidence: input.evidence || "(sin evidencia)",
    catalog: input.catalog,
    current: input.current ?? "(ninguna: es una skill nueva)",
  });
}

export type SkillDraft =
  | { kind: "skip"; reason: string }
  | { kind: "draft"; name: string; description: string; body: string; changes: string };

/**
 * Salida NO confiable de la redacción: `{ name, description, body, changes }` o `{ skip }`. Si no
 * cumple el esquema lanza; las reglas de contenido (§4) las aplica el store al proponer.
 */
export function parseSkillDraft(stdout: string): SkillDraft {
  const raw = extractJsonObject(stdout);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(schemaError("se esperaba un objeto"));
  const value = raw as Record<string, unknown>;
  if (typeof value.skip === "string" && value.skip.trim()) return { kind: "skip", reason: singleLine(value.skip).slice(0, SKILL_SUMMARY_MAX_CHARS) };
  const { name, description, body, changes } = value;
  if (typeof name !== "string" || !name.trim() || name.length > RAW_NAME_MAX_CHARS) throw new Error(schemaError(`name debe tener de 1 a ${RAW_NAME_MAX_CHARS} caracteres`));
  const line = typeof description === "string" ? singleLine(description) : "";
  if (!line || line.length > SKILL_DESCRIPTION_MAX_CHARS) throw new Error(schemaError(`description debe tener de 1 a ${SKILL_DESCRIPTION_MAX_CHARS} caracteres`));
  if (typeof body !== "string" || !body.trim()) throw new Error(schemaError("body no puede estar vacío"));
  if (changes !== undefined && typeof changes !== "string") throw new Error(schemaError("changes debe ser texto"));
  return { kind: "draft", name: name.trim(), description: line, body, changes: typeof changes === "string" ? changes : "" };
}
