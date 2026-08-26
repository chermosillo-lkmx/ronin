import type { CustomAction, DriverPanes, Task } from "./types.js";
import { getPromptTemplate, renderPrompt } from "./prompts.js";
import { DRIVER_FLOW, resolveFlow, type WfStage } from "./workflow.js";
import { reviewToolCmd } from "./models.js";
import { PLANNER_MODEL, WORKER_MODEL } from "./config.js";

/**
 * Modelos efectivos de un launch en modo Driver, ya resueltos (opts → repo-config → env).
 * Ambos opcionales: un valor vacío cae al default, nunca produce un `--model ` sin argumento.
 */
export interface DriverModels {
  planner?: string; // Brain + Reviewer
  worker?: string;  // Implementer
}

const DEFAULT_DRIVER_MODELS = { planner: PLANNER_MODEL, worker: WORKER_MODEL } as const;

/**
 * {cycle}/{ev}/{repo}/{var:KEY} → valor, en un solo paso. El retorno del callback se inserta
 * literal (no re-escanea), así que un valor con {var:X}/{cycle} no se re-expande. Key desconocida
 * → deja el literal {var:KEY} (no destructivo). Compartido por buildWorkerPrompt y buildActionPrompt.
 */
export function makeFill(cycleDir: string, repo: string, vars: Record<string, string>) {
  const ev = `${cycleDir}/evidence`;
  return (s: string) =>
    s
      .replace(/\{cycle\}/g, cycleDir)
      .replace(/\{ev\}/g, ev)
      .replace(/\{repo\}/g, repo)
      .replace(/\{var:([A-Za-z0-9_]+)\}/g, (m, k) =>
        Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m
      );
}

/** {steps} desde el flow: cada etapa → paso numerado + sentinel (touch). fill() aplicado a la instrucción. */
export function assembleSteps(
  flow: { stages: WfStage[]; verifyAfter: string | null },
  cycleDir: string,
  fill: (s: string) => string
): string {
  return flow.stages
    .map((s, i) => `${i + 1}. touch ${cycleDir}/${s.key} — ${fill(s.instruction ?? `etapa ${s.label}.`)}`)
    .join("\n");
}

export interface WorkflowPromptValuesInput {
  workflow: { stages: WfStage[]; verifyAfter: string | null };
  cycle: string;
  repo: string;
  kind: string;
  reqline: string;
  title: string;
  key: string;
  ref?: string;
  desc?: string;
  body?: string;
  url?: string;
  vars?: Record<string, string>;
}

/** Valores puros compartidos por tareas del tablero y sesiones iniciadas con una petición. */
export function buildWorkflowPromptValues(input: WorkflowPromptValuesInput): Record<string, string> {
  const ev = `${input.cycle}/evidence`;
  const fill = makeFill(input.cycle, input.repo, input.vars ?? {});
  return {
    kind: input.kind,
    reqline: input.reqline,
    title: input.title ? `\n${input.title}` : "",
    ref: input.ref ?? "",
    desc: input.desc ?? "",
    steps: assembleSteps(input.workflow, input.cycle, fill),
    verifier: input.workflow.verifyAfter
      ? `\nAl terminar la etapa "${input.workflow.verifyAfter}", un VERIFICADOR independiente (otro pane) revisará tus resultados contra el objetivo.`
      : "",
    cycle: input.cycle,
    ev,
    repo: input.repo,
    key: input.key,
    body: input.body ?? "",
    url: input.url ?? "",
  };
}

/** Renderiza el workflow congelado para una petición creada desde Nueva sesión. */
export function buildWorkflowRequestPrompt(input: {
  workflow: { stages: WfStage[]; verifyAfter: string | null };
  cycle: string;
  repo: string;
  request: string;
  title: string;
  key: string;
}): string {
  return renderPrompt(getPromptTemplate("workflow"), buildWorkflowPromptValues({
    workflow: input.workflow,
    cycle: input.cycle,
    repo: input.repo,
    kind: "petición",
    reqline: input.request,
    title: input.title,
    key: input.key,
    body: input.request,
  }));
}

/**
 * The conversation template seeded into the worker's claude pane.
 *
 * Each build* now renders an EDITABLE template (server/src/prompts.ts) instead of
 * a hardcoded array. Without overrides the output is byte-identical to before:
 * the DEFAULT_PROMPTS reproduce today's text and each build* precomputes the same
 * conditional pieces (ref/desc/verifier/…) — with their leading "\n" folded in so
 * the old .filter(Boolean) blank-line behavior is preserved exactly.
 *
 * With USE_WORKER_LOOP (default) the complex/adhoc branch invokes the
 * /tmux-worker-loop skill so the launched claude becomes the DRIVER and
 * orchestrates the full loop. Either way it asks for stage sentinels + evidence
 * the dashboard can read back.
 */
/** Ad-hoc tasks (DMs/mentions): a simple single-agent prompt, no /tmux-worker-loop. */
export function buildAdhocPrompt(task: Task, cycleDir: string): string {
  const ev = `${cycleDir}/evidence`;
  return renderPrompt(getPromptTemplate("adhoc"), {
    body: task.body ?? task.title,
    ev,
    cycle: cycleDir,
    title: task.title,
    key: task.key,
    repo: task.repo,
    url: task.url ?? "",
  });
}

/** Independent verifier (third pane): checks the curl results vs the task objective. */
export function buildVerifierPrompt(task: Task, cycleDir: string): string {
  const ev = `${cycleDir}/evidence`;
  return renderPrompt(getPromptTemplate("verifier"), {
    key: task.key,
    title: task.title,
    ref: task.url ? `\nRef: ${task.url}` : "",
    ev,
    cycle: cycleDir,
    repo: task.repo,
    url: task.url ?? "",
  });
}

/** PR reviewer: checkout the PR branch, verify vs the task, then (after merge) curl-test in dev. */
export function buildPrReviewPrompt(task: Task, cycleDir: string): string {
  const ev = `${cycleDir}/evidence`;
  return renderPrompt(getPromptTemplate("pr"), {
    body: task.body ?? "(sin url)",
    objetivo: task.url ? `\nTarea/objetivo: ${task.url}` : "",
    resumen: task.title ? `\nResumen: ${task.title}` : "",
    repo: task.repo,
    ev,
    cycle: cycleDir,
    url: task.url ?? "",
    title: task.title ?? "",
  });
}

/** Investigador read-only: analiza el ticket y propone un plan. NO modifica archivos. */
export function buildResearchPrompt(task: Task, cycleDir: string): string {
  const ev = `${cycleDir}/evidence`;
  const desc = (task.body ?? "").trim();
  return renderPrompt(getPromptTemplate("research"), {
    key: task.key,
    title: task.title,
    ref: task.url ? `\nRef: ${task.url}` : "",
    desc: desc ? `\nDescripción del ticket:\n${desc}` : "",
    repo: task.repo,
    cycle: cycleDir,
    ev,
    url: task.url ?? "",
    body: desc,
  });
}

export function buildWorkerPrompt(
  task: Task,
  cycleDir: string,
  flow?: { stages: WfStage[]; verifyAfter: string | null },
  vars: Record<string, string> = {}
): string {
  if (task.source === "pr") return buildPrReviewPrompt(task, cycleDir);
  if (task.source === "adhoc") return task.complex ? buildComplexPrompt(task, cycleDir) : buildAdhocPrompt(task, cycleDir);
  // Pipeline assembled from the composable workflow (data/workflow.json), optionally
  // restricted to the per-launch enabled stages. Each stage → numbered step + sentinel.
  const resolved = flow ?? resolveFlow();
  const desc = (task.body ?? "").trim();
  const isCustom = task.source === "custom";
  return renderPrompt(getPromptTemplate("workflow"), buildWorkflowPromptValues({
    workflow: resolved,
    cycle: cycleDir,
    repo: task.repo,
    kind: isCustom ? "petición" : "tarea",
    reqline: isCustom
      ? `Requerimiento — petición personal (servicio probable: ${task.repo}):`
      : `Requerimiento — ticket ${task.key} (servicio probable: ${task.repo}):`,
    title: task.title,
    ref: task.url ? `\nRef: ${task.url}` : "",
    desc: desc ? `\nDescripción del ticket:\n${desc}` : "",
    key: task.key,
    body: desc,
    url: task.url ?? "",
    vars,
  }));
}

/**
 * Acción custom definida por el usuario. Renderiza action.prompt con los values (title/key/…/steps/verifier)
 * y un pase final fill() para resolver {var:KEY}/{cycle} escritos por el usuario en su propio prompt
 * (renderPrompt deja {var:KEY} literal — su name-group casa pero no está en values; fill lo resuelve;
 * no re-escanea los {steps} ya insertados). read-only lo refuerza el propio prompt (como research).
 */
export function buildActionPrompt(
  action: CustomAction,
  task: Task,
  cycleDir: string,
  flow: { stages: WfStage[]; verifyAfter: string | null },
  vars: Record<string, string> = {}
): string {
  const ev = `${cycleDir}/evidence`;
  const desc = (task.body ?? "").trim();
  const fill = makeFill(cycleDir, task.repo, vars);
  const values = {
    title: task.title ?? "",
    key: task.key,
    repo: task.repo,
    body: desc,
    url: task.url ?? "",
    ref: task.url ? `\nRef: ${task.url}` : "",
    cycle: cycleDir,
    ev,
    steps: assembleSteps(flow, cycleDir, fill),
    verifier: flow.verifyAfter
      ? `\nAl terminar la etapa "${flow.verifyAfter}", un VERIFICADOR independiente (otro pane) revisará tus resultados contra el objetivo.`
      : "",
  };
  return fill(renderPrompt(action.prompt, values));
}

/**
 * Modo Driver: prompt CORTO para el pane driver. Delega en el skill (modo provisioned panes)
 * en vez de repetir su protocolo — mismo criterio que buildComplexPrompt, que sólo dice "usa
 * el skill /tmux-worker-loop". Los {steps} salen de DRIVER_FLOW vía assembleSteps, así las
 * keys de sentinel viven en un solo lugar y no pueden divergir de lo que detectStage busca.
 */
export function buildDriverPrompt(
  task: Task,
  cycleDir: string,
  panes: DriverPanes,
  reviewTool: "codex" | "agent",
  vars: Record<string, string> = {},
  models: DriverModels = {}
): string {
  const ev = `${cycleDir}/evidence`;
  const desc = (task.body ?? "").trim();
  const fill = makeFill(cycleDir, task.repo, vars);
  return renderPrompt(getPromptTemplate("driver"), {
    key: task.key,
    title: task.title ?? "",
    ref: task.url ? `\nRef: ${task.url}` : "",
    desc: desc ? `\nDescripción del ticket:\n${desc}` : "",
    repo: task.repo,
    cycle: cycleDir,
    ev,
    url: task.url ?? "",
    body: desc,
    steps: assembleSteps(DRIVER_FLOW, cycleDir, fill),
    driverPane: panes.driver,
    workerPane: panes.worker,
    reviewPane: panes.review,
    verifyPane: panes.verify,
    reviewTool,
    reviewCmd: reviewToolCmd(reviewTool),
    // El Brain planea y el Reviewer juzga → ambos van al modelo de planner; el Implementer
    // ejecuta contra un plan cerrado → modelo de worker. En modo Driver NO hay switch
    // plan→impl (cada rol vive en su pane), así que estos son los modelos definitivos:
    // si no llegan hasta aquí, el override por repo/UI se pierde en silencio.
    brainModel: models.planner || DEFAULT_DRIVER_MODELS.planner,
    reviewerModel: models.planner || DEFAULT_DRIVER_MODELS.planner,
    implModel: models.worker || DEFAULT_DRIVER_MODELS.worker,
  });
}

/** Complex DM tasks (implement-something-new) → orchestrate via /tmux-worker-loop. */
export function buildComplexPrompt(task: Task, cycleDir: string): string {
  const ev = `${cycleDir}/evidence`;
  // Today the body line + Ref line are separate array elements under .filter(Boolean),
  // so an empty body ("") is DROPPED. Fold both into one leading-"\n" block so the
  // filter semantics survive byte-for-byte (body=""/url present, both absent, etc.).
  const firstblock = [task.body ?? task.title, task.url ? `Ref: ${task.url}` : ""].filter(Boolean).join("\n");
  return renderPrompt(getPromptTemplate("adhocComplex"), {
    reqbody: firstblock ? `\n${firstblock}` : "",
    cycle: cycleDir,
    ev,
    body: task.body ?? task.title,
    title: task.title,
    url: task.url ?? "",
    key: task.key,
    repo: task.repo,
  });
}
