import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSessionPort, deriveSessionName, toStatus, type SessionPortDeps } from "./mcp-session-port.js";
import { McpToolError } from "./mcp-sessions.js";
import { SessionLaunchError } from "./session-launch.js";
import type { TmuxSessionInfo } from "./types.js";

function session(overrides: Partial<TmuxSessionInfo> = {}): TmuxSessionInfo {
  return {
    name: "cowork-a", kind: "managed", windows: 1, createdAt: 1, attached: false, adopted: false,
    panes: [{ id: "%1" } as TmuxSessionInfo["panes"][number]],
    flow: { workflow: "plan-tdd-evidencia", done: 1, total: 4, stages: [
      { key: "planning", label: "Plan", status: "done" },
      { key: "implementing", label: "Impl", status: "current" },
      { key: "tests", label: "Pruebas", status: "pending" },
      { key: "done", label: "Evidencia", status: "pending" },
    ] },
    attention: { level: "working", paneId: "%1" },
    ...overrides,
  };
}

const CLAUDE_IDLE = [
  "⏺ Listo el plan. ¿Lo implemento?",
  "",
  "❯ ",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");
const CLAUDE_YN = ["¿sigo? [y/n]", "", "❯ ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
const PERMISSION_MENU = [
  "Do you want to make this edit to sessions.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session (shift+tab)",
  "  3. No, and tell Claude what to do differently (esc)",
].join("\n");

function deps(overrides: Partial<SessionPortDeps> = {}, panes: Record<string, string> = {}) {
  const sent: Array<[string, string, boolean]> = [];
  const launched: unknown[] = [];
  const base: SessionPortDeps = {
    listRepos: () => ["todo-api"],
    listWorkflows: () => [{ id: "wf-1", name: "plan-tdd-evidencia", stages: ["planning", "implementing", "tests", "done"] }],
    launch: async (input) => { launched.push(input); return { name: input.name, branch: `ronin/${input.name}`, worktree: `/wt/${input.name}` }; },
    inventory: async () => [session()],
    deliver: async (paneId, text, submit) => { sent.push([paneId, text, submit]); },
    capture: async (paneIds) => new Map(paneIds.map((id) => [id, panes[id] ?? CLAUDE_IDLE])),
    now: () => 1_790_000_000_000,
    ...overrides,
  };
  return { deps: base, sent, launched };
}

test("deriveSessionName usa las primeras palabras de la petición", () => {
  assert.equal(deriveSessionName("Valida títulos vacíos en createTodo ahora", 5), "cowork-valida-t-tulos-vac-os-en");
});

test("deriveSessionName cae a un nombre con marca de tiempo si la petición no tiene letras", () => {
  assert.equal(deriveSessionName("¡¡!!", 1_790_000_000_000), "cowork-sesion-1790000000000");
});

test("deriveSessionName nunca termina en guion tras recortar a 48 caracteres", () => {
  // 47 letras + espacio + palabra: el corte en 48 cae justo sobre el guion separador.
  const name = deriveSessionName(`${"a".repeat(47)} bcd`, 5);
  assert.equal(name, `cowork-${"a".repeat(47)}`);
  assert.doesNotMatch(name, /-$/);
});

test("toStatus resume etapa actual, avance y atención", () => {
  assert.deepEqual(toStatus(session()), {
    name: "cowork-a", workflow: "plan-tdd-evidencia", stage: "implementing", stagesDone: 1, stagesTotal: 4,
    attention: "working", needsInput: false, gate: null,
  });
});

test("toStatus marca needsInput y recorta la pregunta a 500 caracteres", () => {
  const status = toStatus(session({ attention: { level: "decision", paneId: "%1", question: "q".repeat(600) } }));
  assert.equal(status.needsInput, true);
  assert.equal(status.question?.length, 500);
});

test("toStatus considera 'idle' con etapas pendientes como espera del usuario", () => {
  assert.equal(toStatus(session({ attention: { level: "idle", paneId: "%1" } })).needsInput, true);
});

test("toStatus omite question si sobre la caja de input sólo hay ruido", () => {
  const box = "─".repeat(60);
  const pane = [
    "✻ Baked for 45m 34s · done 5:25 PM",
    `${" ".repeat(60)}1 new message (click) ↓`,
    `${" ".repeat(60)}new task? /clear to save 1k tokens`,
    box, "❯ sugerencia de Claude", box, "  cowork-a  ⎇ ronin/cowork-a  ▓░░░░ 20%",
  ].join("\n");
  const status = toStatus(session({ attention: { level: "idle", paneId: "%1" } }), pane);
  assert.equal(status.needsInput, true);
  assert.equal("question" in status, false);
});

test("toStatus no marca needsInput cuando el flujo ya terminó", () => {
  const done = session({ attention: { level: "idle", paneId: "%1" }, flow: { workflow: "w", done: 4, total: 4, stages: [] } });
  assert.equal(toStatus(done).needsInput, false);
});

test("toStatus reporta el gate fallido", () => {
  const failed = session({ flow: { workflow: "w", done: 2, total: 4, stages: [
    { key: "planning", label: "P", status: "done" }, { key: "implementing", label: "I", status: "done" },
    { key: "tests", label: "T", status: "failed", attempts: 2 }, { key: "done", label: "E", status: "pending" },
  ] } });
  assert.deepEqual(toStatus(failed).gate, { stage: "tests", attempts: 2 });
});

test("catalog combina repos y workflows", async () => {
  const port = createSessionPort(deps().deps);
  assert.deepEqual(await port.catalog(), { repos: ["todo-api"], workflows: [{ id: "wf-1", name: "plan-tdd-evidencia", stages: ["planning", "implementing", "tests", "done"] }] });
});

test("launch deriva el nombre, fija modo workflow y pasa el origen", async () => {
  const { deps: d, launched } = deps();
  const result = await createSessionPort(d).launch({ repo: "todo-api", workflowId: "wf-1", request: "Valida títulos", origin: "clickup:86abc1234" });
  assert.deepEqual(launched, [{ repo: "todo-api", workflowId: "wf-1", name: "cowork-valida-t-tulos", mode: "workflow", request: "Valida títulos", origin: "clickup:86abc1234" }]);
  assert.equal(result.name, "cowork-valida-t-tulos");
});

test("launch traduce SessionLaunchError a McpToolError con el mismo código", async () => {
  const { deps: d } = deps({ launch: async () => { throw new SessionLaunchError("SESSION_ALREADY_EXISTS", "ya existe"); } });
  await assert.rejects(
    () => createSessionPort(d).launch({ repo: "todo-api", workflowId: "wf-1", request: "x", name: "cowork-dup" }),
    (error: unknown) => error instanceof McpToolError && error.code === "SESSION_ALREADY_EXISTS",
  );
});

test("status solo lista sesiones gestionadas y respeta el filtro de nombres", async () => {
  const { deps: d } = deps({ inventory: async () => [session(), session({ name: "cowork-b" }), session({ name: "ajena", kind: "foreign" })] });
  const port = createSessionPort(d);
  assert.deepEqual((await port.status()).map((s) => s.name), ["cowork-a", "cowork-b"]);
  assert.deepEqual((await port.status(["cowork-b"])).map((s) => s.name), ["cowork-b"]);
});

test("reply escribe en el pane que pidió atención y envía Enter", async () => {
  const { deps: d, sent } = deps({ inventory: async () => [session({ attention: { level: "decision", paneId: "%7", question: "¿sigo?" } })] }, { "%7": CLAUDE_YN });
  await createSessionPort(d).reply("cowork-a", "sí");
  assert.deepEqual(sent, [["%7", "sí", true]]);
});

test("reply rechaza sesiones que no esperan al usuario sin escribir nada", async () => {
  const { deps: d, sent } = deps();
  await assert.rejects(() => createSessionPort(d).reply("cowork-a", "sí"), (error: unknown) => error instanceof McpToolError && error.code === "SESSION_NOT_WAITING");
  assert.equal(sent.length, 0);
});

test("reply rechaza sesiones inexistentes o ajenas", async () => {
  const { deps: d } = deps({ inventory: async () => [session({ name: "ajena", kind: "foreign", attention: { level: "decision", paneId: "%1" } })] });
  const port = createSessionPort(d);
  await assert.rejects(() => port.reply("nope", "x"), (error: unknown) => error instanceof McpToolError && error.code === "SESSION_NOT_FOUND");
  await assert.rejects(() => port.reply("ajena", "x"), (error: unknown) => error instanceof McpToolError && error.code === "SESSION_NOT_FOUND");
});

test("reply rechaza texto por encima de 16 KB con PAYLOAD_TOO_LARGE sin escribir nada", async () => {
  const { deps: d, sent } = deps({ inventory: async () => [session({ attention: { level: "idle", paneId: "%7" } })] });
  await assert.rejects(
    () => createSessionPort(d).reply("cowork-a", "x".repeat(16 * 1024 + 1)),
    (error: unknown) => error instanceof McpToolError && error.code === "PAYLOAD_TOO_LARGE",
  );
  assert.equal(sent.length, 0);
});

test("reply entrega un texto largo (≤ 16 KB) por el helper compartido, sin NUL", async () => {
  const { deps: d, sent } = deps({ inventory: async () => [session({ attention: { level: "idle", paneId: "%7" } })] });
  const text = `${"línea\n".repeat(1000)}\0fin`;
  await createSessionPort(d).reply("cowork-a", text);
  assert.deepEqual(sent, [["%7", text.split("\0").join(""), true]]);
});

const rejectsNotWaiting = (error: unknown) => error instanceof McpToolError && error.code === "SESSION_NOT_WAITING";

test("reply revisa el pane en vivo: una decisión que quedó en un shell se rechaza sin escribir", async () => {
  // Claude salió (`exec $SHELL -l`): el [y/n] sigue en pantalla, pero debajo ya hay un prompt de shell.
  const shell = ["¿sigo? [y/n]", "", "cesar@mac ronin % "].join("\n");
  const { deps: d, sent } = deps({ inventory: async () => [session({ attention: { level: "decision", paneId: "%7", question: "¿sigo?" } })] }, { "%7": shell });
  await assert.rejects(() => createSessionPort(d).reply("cowork-a", "y"), rejectsNotWaiting);
  assert.equal(sent.length, 0);
});

test("reply rechaza un menú numerado rancio con un prompt de shell debajo", async () => {
  const shell = `${PERMISSION_MENU}\n\ncesar@mac ronin % `;
  const { deps: d, sent } = deps({ inventory: async () => [session({ attention: { level: "decision", paneId: "%7", question: "q" } })] }, { "%7": shell });
  await assert.rejects(() => createSessionPort(d).reply("cowork-a", "1"), rejectsNotWaiting);
  assert.equal(sent.length, 0);
});

test("reply rechaza si el pane ya no existe o dejó de esperar en vivo", async () => {
  const gone = deps({ inventory: async () => [session({ attention: { level: "idle", paneId: "%7" } })], capture: async () => new Map() });
  await assert.rejects(() => createSessionPort(gone.deps).reply("cowork-a", "sigue"), rejectsNotWaiting);
  assert.equal(gone.sent.length, 0);
  const working = deps({ inventory: async () => [session({ attention: { level: "idle", paneId: "%7" } })] }, { "%7": `✢ Beboppin'… (22s · ↓ 631 tokens)\n${CLAUDE_IDLE}` });
  await assert.rejects(() => createSessionPort(working.deps).reply("cowork-a", "sigue"), rejectsNotWaiting);
  assert.equal(working.sent.length, 0);
});

const menuSession = () => session({ attention: { level: "decision", paneId: "%7", question: "Do you want to make this edit to sessions.ts?" } });

test("status expone las opciones de un menú numerado y no las de un y/n", async () => {
  const { deps: d } = deps({ inventory: async () => [menuSession(), session({ name: "cowork-b", attention: { level: "decision", paneId: "%8", question: "¿sigo?" } })] }, { "%7": PERMISSION_MENU, "%8": CLAUDE_YN });
  const [menu, yn] = await createSessionPort(d).status();
  assert.deepEqual(menu!.options, ["Yes", "Yes, allow all edits during this session (shift+tab)", "No, and tell Claude what to do differently (esc)"]);
  assert.equal(yn!.options, undefined);
});

test("reply en un menú numerado acepta sólo el número y envía sólo esa tecla", async () => {
  const { deps: d, sent } = deps({ inventory: async () => [menuSession()] }, { "%7": PERMISSION_MENU });
  await createSessionPort(d).reply("cowork-a", " 2 ");
  assert.deepEqual(sent, [["%7", "2", false]]);
});

test("reply en un menú numerado rechaza texto libre o números fuera de rango sin escribir", async () => {
  const { deps: d, sent } = deps({ inventory: async () => [menuSession()] }, { "%7": PERMISSION_MENU });
  const port = createSessionPort(d);
  for (const text of ["no, espera", "4", "0", "1 y luego 2"]) {
    await assert.rejects(
      () => port.reply("cowork-a", text),
      (error: unknown) => error instanceof McpToolError && error.code === "SESSION_EXPECTS_OPTION" && /1, 2, 3/.test(error.message),
      text,
    );
  }
  assert.equal(sent.length, 0);
});

test("status llena question de una sesión idle con etapas pendientes desde la última línea útil del pane", async () => {
  const idle = session({ attention: { level: "idle", paneId: "%7" } });
  const { deps: d } = deps({ inventory: async () => [idle] }, { "%7": CLAUDE_IDLE });
  const [status] = await createSessionPort(d).status();
  assert.equal(status!.needsInput, true);
  assert.equal(status!.question, "Listo el plan. ¿Lo implemento?");
});

test("status acota a 500 caracteres la question de una sesión idle", async () => {
  const idle = session({ attention: { level: "idle", paneId: "%7" } });
  const long = [`⏺ ${"p".repeat(700)}`, "", "❯ ", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
  const { deps: d } = deps({ inventory: async () => [idle] }, { "%7": long });
  const [status] = await createSessionPort(d).status();
  assert.equal(status!.question, "p".repeat(500));
});

test("status no pone question a una sesión idle que ya terminó su flujo", async () => {
  const done = session({ attention: { level: "idle", paneId: "%7" }, flow: { workflow: "w", done: 4, total: 4, stages: [] } });
  const { deps: d } = deps({ inventory: async () => [done] }, { "%7": CLAUDE_IDLE });
  const [status] = await createSessionPort(d).status();
  assert.equal(status!.needsInput, false);
  assert.equal(status!.question, undefined);
});

test("status toma como question el último párrafo de Claude en un pane real con status line", async () => {
  const pane = readFileSync(new URL("./fixtures/claude-pane-statusline.txt", import.meta.url), "utf8");
  const idle = session({ attention: { level: "idle", paneId: "%7" } });
  const { deps: d } = deps({ inventory: async () => [idle] }, { "%7": pane });
  const [status] = await createSessionPort(d).status();
  assert.equal(status!.needsInput, true);
  assert.equal(
    status!.question,
    "Decision needed: should I relaunch the cycle on a new worktree of ant-liebre-api from origin/main and continue from the implementation stage?",
  );
});

test("reply con texto libre queda registrado; una opción de menú no", async () => {
  const recorded: Array<[string, string]> = [];
  const free = deps({ inventory: async () => [session({ attention: { level: "idle", paneId: "%7" } })], recordReply: (name, text) => { recorded.push([name, text]); } });
  await createSessionPort(free.deps).reply("cowork-a", "usa make\0 test-unit");
  const menu = deps({ inventory: async () => [menuSession()], recordReply: (name, text) => { recorded.push([name, text]); } }, { "%7": PERMISSION_MENU });
  await createSessionPort(menu.deps).reply("cowork-a", "2");
  assert.deepEqual(recorded, [["cowork-a", "usa make test-unit"]]);
  assert.deepEqual(menu.sent, [["%7", "2", false]]);
});
