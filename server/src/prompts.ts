import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Store editable de las 6 plantillas de prompt de los workers. Mismo patrón que
 * workflow.ts/repo-config.ts: mutable en memoria, validate-on-load, writeFileSync
 * + reload. data/prompts.json guarda SÓLO overrides (una key ausente o vacía = usar
 * el default). NO gitignored (los prompts no son secretos). Los DEFAULT_PROMPTS
 * reproducen byte-a-byte el texto que hoy generan los build* de templates.ts.
 *
 * Placeholders {name} se sustituyen al lanzar (renderPrompt, un solo paso; los
 * condicionales que hoy se filtran vienen precompuestos con su \n inicial). Las 5
 * plantillas filtradas son DENSAS (sin líneas en blanco: hoy .filter() las borra);
 * sólo `adhoc` conserva blancos (su build* usa join sin filtro).
 */
export type PromptKey = "adhoc" | "adhocComplex" | "workflow" | "research" | "pr" | "verifier";

export const PROMPT_KEYS: PromptKey[] = ["adhoc", "adhocComplex", "workflow", "research", "pr", "verifier"];

const LABELS: Record<PromptKey, string> = {
  adhoc: "Ad-hoc simple",
  adhocComplex: "Ad-hoc complejo (/tmux-worker-loop)",
  workflow: "Worker principal (lanzar flujo)",
  research: "Investigar (read-only)",
  pr: "PR reviewer",
  verifier: "Verificador independiente",
};

// Placeholders disponibles por plantilla (para el panel de ayuda del editor).
const PLACEHOLDERS: Record<PromptKey, string[]> = {
  adhoc: ["{body}", "{ev}", "{cycle}", "{title}", "{key}", "{repo}", "{url}"],
  adhocComplex: ["{reqbody}", "{cycle}", "{ev}", "{body}", "{title}", "{url}", "{key}", "{repo}"],
  workflow: ["{kind}", "{reqline}", "{title}", "{ref}", "{desc}", "{steps}", "{verifier}", "{cycle}", "{ev}", "{repo}", "{key}", "{body}", "{url}"],
  research: ["{key}", "{title}", "{ref}", "{desc}", "{repo}", "{cycle}", "{ev}", "{url}", "{body}"],
  pr: ["{body}", "{objetivo}", "{resumen}", "{repo}", "{cycle}", "{ev}", "{url}", "{title}"],
  verifier: ["{key}", "{title}", "{ref}", "{cycle}", "{ev}", "{repo}", "{url}"],
};

// DEFAULT_PROMPTS: texto ACTUAL de cada build*, con placeholders. IMPORTANTE: las
// 5 filtradas son densas (un solo \n). Sólo `adhoc` conserva blancos.
export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  adhoc: [
    "Tarea ad-hoc (no es de ClickUp/Jira). Resuelve/responde esto directamente —",
    "NO uses /tmux-worker-loop. Trabajas desde la raíz del monorepo (knowledge base + todos los servicios).",
    "",
    "{body}",
    "",
    "Cuando termines, escribe la respuesta/resultado en {ev}/summary.md",
    "(listo para copiar y responder el DM/mención). Si produces un script o comandos, inclúyelos ahí.",
  ].join("\n"),

  adhocComplex: [
    "Usa el skill /tmux-worker-loop para orquestar este requerimiento de principio a fin",
    "(plan → revisión codex → implementación TDD → revisión codex → KB + tests), vigilando que no se desvíe.{reqbody}",
    "Marca etapas (touch): {cycle}/planning · {cycle}/implementing · {cycle}/done",
    "Deja evidencia en {ev}/summary.md (listo para pegar/responder).",
  ].join("\n"),

  workflow: [
    "Eres el MAIN WORKER. Trabaja esta {kind} de principio a fin dejando evidencia.",
    "{reqline}{title}{ref}{desc}",
    "Trabajas desde la raíz del monorepo (knowledge base + todos los servicios); un ticket puede tocar varios proyectos.",
    "Flujo (marca cada etapa con touch al INICIAR cada una):",
    "{steps}{verifier}",
  ].join("\n"),

  research: [
    "Eres un INVESTIGADOR read-only. PROHIBIDO ABSOLUTAMENTE modificar el repo o el mundo exterior:",
    "- No edites/crees/borres archivos de código; no git add/commit/push/checkout/reset/rebase/stash; no rm/mv.",
    "- No corras build/test/app/migraciones (npm run build, npm test/install, make, alembic/migrate, ni levantar servidores):",
    "  generan dist/coverage o reescriben lockfiles.",
    "- No hagas ninguna escritura por red: nada de curl que no sea GET (prohibido -X POST/PUT/PATCH/DELETE y -d),",
    "  ni gh pr create / gh ... comment, ni comentar/actualizar ClickUp/Jira/GitLab.",
    "SOLO puedes: leer archivos, grep/rg/find, git log/diff/show/blame (lectura), y ESCRIBIR ÚNICAMENTE",
    "{ev}/research.md y {ev}/summary.md (más los touch de centinelas en {cycle}).",
    "Investiga este ticket de principio a fin y deja un PLAN de implementación propuesto (que otro worker ejecutará luego).",
    "Requerimiento — {key}: {title}{ref}{desc}",
    "Servicio probable: {repo}. Trabajas desde la raíz del monorepo (knowledge base + todos los servicios); un ticket puede tocar varios proyectos.",
    "Flujo (marca cada etapa con touch al INICIAR cada una):",
    "1. touch {cycle}/investigating — entiende el objetivo y lee el código/contexto relevante. Solo lectura.",
    "2. touch {cycle}/plan — escribe {ev}/research.md con estas secciones:",
    "   • Análisis del problema: qué pide el ticket y cómo funciona hoy el código relacionado.",
    "   • Archivos/áreas afectadas: lista con referencias file:line (p. ej. server/src/engine.ts:474).",
    "   • Plan de implementación propuesto: pasos concretos y ordenados para resolverlo.",
    "   • Riesgos/dudas: supuestos, casos borde y preguntas abiertas.",
    "3. Escribe {ev}/summary.md con un resumen corto (listo para pegar/responder). touch {cycle}/done.",
    "Recuerda: esto es SOLO análisis. Si sientes la necesidad de cambiar código, NO lo hagas: descríbelo como paso del plan en research.md.",
  ].join("\n"),

  pr: [
    "Eres un PR REVIEWER. Revisa este PR contra el objetivo de la tarea. NO hagas merge.",
    "PR: {body}{objetivo}{resumen}",
    "Trabajas desde la raíz del monorepo (knowledge base + todos los servicios).",
    "Flujo:",
    "1. touch {cycle}/planning — haz checkout del branch del PR (gh pr checkout <url/número> en el repo correspondiente).",
    "2. touch {cycle}/implementing — verifica que la implementación cumple el objetivo de la tarea; pruébala localmente lo que puedas.",
    "3. Escribe tu veredicto en {ev}/verdict.md (APROBADO o CAMBIOS REQUERIDOS + razones concretas). touch {cycle}/verify.",
    "4. Si APROBADO: NO mergees. Indica que está listo para merge y ESPERA. Cuando te respondan que YA se hizo el merge:",
    "   • source {cycle}/curl.env → $DEV_URL, $TOKEN, $ACCOUNTING_FIRM (ya configurados). Corre los curl relevantes contra dev,",
    "     guarda comando + request body + response body en {ev}/curl.md. touch {cycle}/curl.",
    "   • Ingesta al backup-tester: curl -X POST $BACKUP_TESTER_URL/api/test-coverage/ingest -H \"Authorization: Bearer $BACKUP_TESTER_INGEST_TOKEN\" -F project={repo} -F suite=curl -F junit=@<junit.xml>",
    "5. Escribe {ev}/summary.md y touch {cycle}/done.",
  ].join("\n"),

  verifier: [
    "Eres un VERIFICADOR independiente. NO implementes nada.",
    "Tarea original — {key}: {title}{ref}",
    "1. Lee los resultados de las pruebas curl en {ev}/curl.md (request body + response body de cada llamada).",
    "2. Compara los resultados contra el OBJETIVO de la tarea: ¿la implementación logra lo pedido?",
    "3. Escribe tu veredicto en {ev}/verdict.md: APROBADO o RECHAZADO + razones concretas + qué falta.",
    "4. touch {cycle}/verify al terminar.",
  ].join("\n"),
};

/**
 * Sustituye placeholders {name} → values[name] en un SOLO paso (los valores
 * insertados NO se re-escanean, como fill() de templates.ts). Replacer de FUNCIÓN
 * (evita corrupción por $&/$1/$$ en un valor) + hasOwnProperty (un valor "" cuenta
 * como presente). Placeholder desconocido → se deja literal (no destructivo).
 */
export function renderPrompt(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-zA-Z][\w:]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "prompts.json");
const COMMENT =
  "Overrides de las plantillas de prompt de los workers. Una key ausente o vacía usa el default " +
  "(el texto original de templates.ts). Editable desde ⚙ Configuración → Prompts o a mano. " +
  "Placeholders {name} se sustituyen al lanzar; {var:KEY} sólo se resuelve dentro de los pasos.";

type Store = Partial<Record<PromptKey, string>>;

// Distrust disk: sólo keys conocidas con valor string. Nunca throw
// (getPromptTemplate corre en cada launch, como getRepoStartCommand).
function load(): Store {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8"));
    const out: Store = {};
    for (const k of PROMPT_KEYS) if (typeof raw[k] === "string") out[k] = raw[k];
    return out;
  } catch {
    return {};
  }
}

// Lazy init so module eval never does I/O.
let store: Store | null = null;
const S = (): Store => (store ??= load());

/** Texto efectivo: override (si no vacío) o el default. "" no lo atrapa ?? → usar trim. */
export function getPromptTemplate(key: PromptKey): string {
  const ov = S()[key];
  return ov && ov.trim() ? ov : DEFAULT_PROMPTS[key];
}

export interface PromptTemplate {
  key: PromptKey;
  label: string;
  template: string; // texto efectivo (override o default)
  isDefault: boolean;
  placeholders: string[];
}

/** Config de las 6 plantillas para el editor (texto efectivo + isDefault + placeholders). */
export function readPromptConfig(): PromptTemplate[] {
  return PROMPT_KEYS.map((key) => {
    const ov = S()[key];
    return {
      key,
      label: LABELS[key],
      template: getPromptTemplate(key),
      isDefault: !(ov && ov.trim()),
      placeholders: PLACEHOLDERS[key],
    };
  });
}

function persist(next: Store): void {
  writeFileSync(FILE, JSON.stringify({ _comment: COMMENT, ...next }, null, 2) + "\n");
  store = next;
}

/** Guarda (o borra si vacío/espacios) un override. key inválida → throw (→400 en la ruta). */
export function savePromptTemplate(key: string, template: string): PromptTemplate[] {
  if (!PROMPT_KEYS.includes(key as PromptKey)) throw new Error(`prompt desconocido: "${key}"`);
  const k = key as PromptKey;
  const next: Store = { ...S() };
  if (typeof template === "string" && template.trim()) next[k] = template;
  else delete next[k]; // vacío/espacios → usar default
  persist(next);
  return readPromptConfig();
}

/** Restaura el default (borra el override). key inválida → throw (→400). */
export function resetPromptTemplate(key: string): PromptTemplate[] {
  if (!PROMPT_KEYS.includes(key as PromptKey)) throw new Error(`prompt desconocido: "${key}"`);
  const next: Store = { ...S() };
  delete next[key as PromptKey];
  persist(next);
  return readPromptConfig();
}
