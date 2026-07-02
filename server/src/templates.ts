import type { CustomAction, Task } from "./types.js";
import { getPromptTemplate, renderPrompt } from "./prompts.js";
import { resolveFlow, type WfStage } from "./workflow.js";

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
  const ev = `${cycleDir}/evidence`;
  const fill = makeFill(cycleDir, task.repo, vars);

  // Pipeline assembled from the composable workflow (data/workflow.json), optionally
  // restricted to the per-launch enabled stages. Each stage → numbered step + sentinel.
  const resolved = flow ?? resolveFlow();
  const { verifyAfter } = resolved;
  const steps = assembleSteps(resolved, cycleDir, fill);

  const desc = (task.body ?? "").trim();
  const isCustom = task.source === "custom";
  return renderPrompt(getPromptTemplate("workflow"), {
    kind: isCustom ? "petición" : "tarea",
    reqline: isCustom
      ? `Requerimiento — petición personal (servicio probable: ${task.repo}):`
      : `Requerimiento — ticket ${task.key} (servicio probable: ${task.repo}):`,
    // Folded into a leading-"\n" block: today `task.title` is a bare filtered line,
    // so an empty title drops entirely (no stray blank). Matches {ref}/{desc}.
    title: task.title ? `\n${task.title}` : "",
    ref: task.url ? `\nRef: ${task.url}` : "",
    desc: desc ? `\nDescripción del ticket:\n${desc}` : "",
    steps,
    verifier: verifyAfter
      ? `\nAl terminar la etapa "${verifyAfter}", un VERIFICADOR independiente (otro pane) revisará tus resultados contra el objetivo.`
      : "",
    cycle: cycleDir,
    ev,
    repo: task.repo,
    key: task.key,
    body: desc,
    url: task.url ?? "",
  });
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
