import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildDriverPrompt } from "./templates.js";
import { DRIVER_STAGES } from "./workflow.js";
import type { Task } from "./types.js";

const PANES = { driver: "%1", worker: "%2", review: "%3", verify: "%4" };
const CYCLE = "/tmp/cowork-cycle-cowork-CU-42-driver";

const TASK: Task = {
  id: "t1",
  key: "CU-42",
  title: "Arreglar el login",
  repo: "ant-liebre-api",
  source: "clickup",
  status: "running",
  url: "https://app.clickup.com/t/abc",
  body: "El login truena con SSO.",
};

const build = (tool: "codex" | "agent" = "codex", task: Task = TASK) =>
  buildDriverPrompt(task, CYCLE, PANES, tool);

test("buildDriverPrompt: incluye los 4 pane ids (targets fijos, no índices)", () => {
  const p = build();
  for (const id of Object.values(PANES)) assert.match(p, new RegExp(id));
  // Los índices .0/.1 se renumeran al morir un pane → el driver relayearía al pane equivocado.
  assert.equal(/:driver\.\d\b/.test(p), false);
});

test("buildDriverPrompt: fija el CYCLE_DIR de Ronin, no el del skill", () => {
  const p = build();
  assert.match(p, new RegExp(CYCLE));
  // El Paso 3 del skill genera /tmp/tmux-worker-cycle-<timestamp>; si el driver lo obedeciera,
  // sus sentinels caerían donde detectStage nunca mira y el stepper se quedaría congelado.
  assert.equal(/tmux-worker-cycle-/.test(p), false);
});

test("buildDriverPrompt: pide touch de las 6 etapas de DRIVER_STAGES (keys de una sola fuente)", () => {
  const p = build();
  for (const s of DRIVER_STAGES) assert.match(p, new RegExp(`touch ${CYCLE}/${s.key}\\b`), s.key);
});

test("buildDriverPrompt: el comando del pane de review depende de reviewTool", () => {
  assert.match(build("codex"), /\bcodex\b/);
  const agent = build("agent");
  assert.match(agent, /\bagent\b/);
  assert.match(agent, /\bclaude\b/);
});

test("buildDriverPrompt: delega en el skill en vez de reimplementar el protocolo", () => {
  const p = build();
  assert.match(p, /tmux-worker-loop/);
  assert.match(p, /provisioned-panes/);
  assert.ok(p.split("\n").length < 30, "el prompt del driver debe ser corto (delega, no repite)");
});

test("buildDriverPrompt: incluye el requerimiento (key, título, ref y descripción)", () => {
  const p = build();
  assert.match(p, /CU-42/);
  assert.match(p, /Arreglar el login/);
  assert.match(p, /app\.clickup\.com/);
  assert.match(p, /SSO/);
});

test("buildDriverPrompt: no deja ningún placeholder sin resolver", () => {
  for (const tool of ["codex", "agent"] as const) {
    const leftovers = build(tool).match(/\{[a-zA-Z][\w:]*\}/g);
    assert.equal(leftovers, null, `placeholders sin resolver: ${leftovers}`);
  }
});

test("buildDriverPrompt: una tarea sin url ni body no deja líneas colgando ni placeholders", () => {
  const bare: Task = { ...TASK, url: undefined, body: undefined };
  const p = buildDriverPrompt(bare, CYCLE, PANES, "codex");
  assert.equal(p.match(/\{[a-zA-Z][\w:]*\}/g), null);
  assert.equal(/Ref:\s*$/m.test(p), false);
  assert.equal(/\n\n\n/.test(p), false);
});

// ---- modelos por rol (modo Driver no tiene switch plan→impl que los aplique) ----

// El bug que esto cubre: launchDriverLive persiste models.json con worker:"" para apagar el
// /model switch, y ANTES de este cableo el workerModel resuelto (override por repo o elegido en
// la UI) moría ahí. El repo lo respetaba en modo rápido y lo ignoraba en silencio en modo Driver.
test("buildDriverPrompt: el modelo del Implementer viene del launch, no de un default hardcodeado", () => {
  const p = buildDriverPrompt(TASK, CYCLE, PANES, "agent", {}, { planner: "opus", worker: "haiku" });
  assert.match(p, /--model haiku/, "el workerModel resuelto debe llegar al pane del Implementer");
  assert.equal(/--model sonnet/.test(p), false, "no debe caer al default cuando hay override");
});

test("buildDriverPrompt: Brain y Reviewer comparten el modelo de planner; el Implementer no", () => {
  const p = buildDriverPrompt(TASK, CYCLE, PANES, "agent", {}, { planner: "opus", worker: "sonnet" });
  // Brain y Reviewer son los roles de juicio (diseño y ataque adversarial) → planner.
  assert.equal((p.match(/--model opus/g) ?? []).length, 2, "brain + reviewer en el modelo planner");
  assert.equal((p.match(/--model sonnet/g) ?? []).length, 1, "sólo el Implementer en el de worker");
});

test("buildDriverPrompt: sin modelos explícitos cae a los defaults, nunca a `--model` vacío", () => {
  for (const models of [undefined, {}, { planner: "", worker: "" }]) {
    const p = buildDriverPrompt(TASK, CYCLE, PANES, "agent", {}, models);
    // Un `--model` sin argumento se lo comería el shell y el pane arrancaría con el modelo
    // de la cuenta — justo el default caro que las aserciones del skill buscan atrapar.
    assert.equal(/--model\s*`/.test(p), false, `--model vacío con ${JSON.stringify(models)}`);
    assert.equal(/--model\s*$/m.test(p), false, `--model colgando con ${JSON.stringify(models)}`);
    assert.equal(p.match(/\{[a-zA-Z][\w:]*\}/g), null);
  }
});
