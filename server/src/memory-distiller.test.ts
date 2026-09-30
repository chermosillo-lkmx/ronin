import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClaudePOptions } from "./claude-p.js";
import { createLearnedSkillStore } from "./learned-skills.js";
import { createMemoryStore } from "./memory.js";
import {
  createDistiller,
  createDistillStateStore,
  DISTILL_TIMEOUT_MS,
  listCycleSessions,
  startMemoryDistiller,
  type Distiller,
  type DistillerDeps,
  type SkillDistillDeps,
} from "./memory-distiller.js";
import { MEMORY_TRIAGE_WARNING } from "./prompts.js";
import { MANUAL_SUMMARY, NO_DETERMINISTIC_GATE } from "./skill-distill.js";

const SINCE = 1_790_000_000_000;
const FINISHED = 1_790_000_100_000;
const NOW = 1_790_000_200_000;
const TEMPLATE = "sesión={session} repo={repo} workflow={workflow}\npetición={request}\n{evidence}\nrespuestas:\n{replies}\nconocida:\n{known}";
const ONE = JSON.stringify({ entries: [{ text: "Tests: usar `make test-unit`", kind: "comando" }] });
const NONE = '{"entries": []}';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ronin-distiller-"));
  const cycles = join(root, "cycles");
  const store = createMemoryStore({ directory: join(root, "memory"), listRepos: () => ["acme-api", "acme-web"], now: () => NOW });
  const stateFile = join(root, "memory", "state.json");
  const state = createDistillStateStore(stateFile);
  const sessions: string[] = [];
  const calls: Array<{ prompt: string; options: ClaudePOptions }> = [];

  function cycle(session: string, repo: string, options: { evidence?: string | null; complete?: boolean; finishedAt?: number } = {}): string {
    const { evidence = "Resumen: las pruebas corren con make test-unit.", complete = true, finishedAt = FINISHED } = options;
    const dir = join(cycles, session);
    mkdirSync(join(dir, "evidence"), { recursive: true });
    writeFileSync(join(dir, "flow.json"), JSON.stringify({ stages: [{ key: "planning", label: "Plan", icon: "P" }, { key: "done", label: "Fin", icon: "F" }], verifyAfter: [] }));
    writeFileSync(join(dir, "launch.json"), JSON.stringify({ version: 1, repo, name: session, mode: "workflow", workflowName: "plan-tdd", request: "agrega reintentos al importador" }));
    if (evidence !== null) writeFileSync(join(dir, "evidence", "summary.md"), evidence);
    for (const key of complete ? ["planning", "done"] : ["planning"]) {
      writeFileSync(join(dir, key), "");
      utimesSync(join(dir, key), finishedAt / 1000, finishedAt / 1000);
    }
    sessions.push(session);
    return dir;
  }

  function deps(overrides: Partial<DistillerDeps> = {}): DistillerDeps {
    return {
      store,
      state,
      cycleFor: (session) => join(cycles, session),
      listCycleSessions: () => [...sessions],
      cwdFor: () => root,
      readEngine: () => ({ tool: "agy" }),
      runClaudeP: async (prompt, options) => { calls.push({ prompt, options }); return ONE; },
      readReplies: () => ["usa make, no pytest suelto"],
      globalEnabled: () => true,
      now: () => NOW,
      promptTemplate: () => TEMPLATE,
      ...overrides,
    };
  }

  return { root, store, state, stateFile, cycle, deps, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("destila una sesión terminada: prompt con evidencia y respuestas, motor de ajustes, 10 min y todo pending", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-csv", "acme-api");
    const distiller = createDistiller(f.deps());
    assert.equal(distiller.request("cowork-csv", "manual"), "queued");
    assert.equal(distiller.stateOf("cowork-csv")?.status, "running");
    await distiller.idle();
    assert.equal(f.calls.length, 1);
    const [{ prompt, options }] = f.calls;
    assert.match(prompt, /^sesión=cowork-csv repo=acme-api workflow=plan-tdd\npetición=agrega reintentos al importador/);
    assert.match(prompt, /### evidence\/summary\.md\nResumen: las pruebas corren con make test-unit\./);
    assert.match(prompt, /- usa make, no pytest suelto/);
    assert.equal(options.timeoutMs, DISTILL_TIMEOUT_MS);
    assert.equal(DISTILL_TIMEOUT_MS, 600_000);
    assert.equal(options.command, "agy");
    assert.deepEqual(options.args, ["-p"]);
    assert.equal(options.cwd, f.root);
    assert.deepEqual(distiller.stateOf("cowork-csv"), { status: "done", repo: "acme-api", at: NOW, proposed: 1 });
    assert.deepEqual(f.store.pending("acme-api").map((e) => [e.text, e.kind, e.source]), [["Tests: usar `make test-unit`", "comando", "cowork-csv"]]);
  } finally {
    f.cleanup();
  }
});

test("una salida que no cumple el esquema deja failed con el error y no agrega nada", async () => {
  const f = fixture();
  try {
    const outputs = [
      "no es json",
      JSON.stringify({ entries: Array.from({ length: 6 }, (_, i) => ({ text: `a${i}`, kind: "comando" })) }),
      JSON.stringify({ entries: [{ text: "x".repeat(201), kind: "comando" }] }),
    ];
    for (const [index, output] of outputs.entries()) {
      const session = `cowork-mala-${index}`;
      f.cycle(session, "acme-api");
      const distiller = createDistiller(f.deps({ runClaudeP: async () => output }));
      distiller.request(session, "manual");
      await distiller.idle();
      const state = distiller.stateOf(session);
      assert.equal(state?.status, "failed", output);
      assert.match(state?.error ?? "", /JSON|esquema/);
    }
    assert.deepEqual(f.store.pending("acme-api"), []);
  } finally {
    f.cleanup();
  }
});

test("{\"entries\": []} termina done con 0 propuestas", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-nada", "acme-api");
    const distiller = createDistiller(f.deps({ runClaudeP: async () => NONE }));
    distiller.request("cowork-nada", "manual");
    await distiller.idle();
    assert.deepEqual(distiller.stateOf("cowork-nada"), { status: "done", repo: "acme-api", at: NOW, proposed: 0 });
  } finally {
    f.cleanup();
  }
});

test("limpia caracteres de control, descarta duplicados y le pasa al prompt la memoria conocida", async () => {
  const f = fixture();
  try {
    f.store.add("acme-api", { text: "Tests: usar make test-unit", kind: "comando" });
    f.cycle("cowork-dup", "acme-api");
    let seen = "";
    const output = JSON.stringify({ entries: [
      { text: "TESTS:  usar make   test-unit", kind: "comando" },
      { text: "Ojo:\u0007 el puerto\n 5432 lo usa docker", kind: "trampa" },
    ] });
    const distiller = createDistiller(f.deps({ runClaudeP: async (prompt) => { seen = prompt; return output; } }));
    distiller.request("cowork-dup", "manual");
    await distiller.idle();
    assert.match(seen, /conocida:\n- \[comando\] Tests: usar make test-unit/);
    assert.equal(distiller.stateOf("cowork-dup")?.proposed, 1);
    assert.deepEqual(f.store.pending("acme-api").map((e) => e.text), ["Ojo: el puerto 5432 lo usa docker"]);
  } finally {
    f.cleanup();
  }
});

test("sin evidencia o con la memoria apagada (global o del repo) queda skipped sin llamar al motor", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-sin-evidencia", "acme-api", { evidence: null });
    f.cycle("cowork-global-off", "acme-api");
    f.cycle("cowork-repo-off", "acme-web");
    f.store.setEnabled("acme-web", false);
    const on = createDistiller(f.deps());
    on.request("cowork-sin-evidencia", "manual");
    on.request("cowork-repo-off", "manual");
    await on.idle();
    const off = createDistiller(f.deps({ globalEnabled: () => false }));
    off.request("cowork-global-off", "manual");
    await off.idle();
    for (const session of ["cowork-sin-evidencia", "cowork-global-off", "cowork-repo-off"]) {
      assert.equal(on.stateOf(session)?.status, "skipped", session);
      assert.equal(typeof on.stateOf(session)?.reason, "string", session);
    }
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test("cada sesión se destila una sola vez, aunque Ronin se reinicie", async () => {
  const f = fixture();
  try {
    f.state.setSince(SINCE);
    f.cycle("cowork-una", "acme-api");
    const first = createDistiller(f.deps());
    assert.deepEqual(first.scan(), ["cowork-una"]);
    assert.deepEqual(first.scan(), []);
    await first.idle();
    assert.deepEqual(first.scan(), []);
    const restarted = createDistiller(f.deps({ state: createDistillStateStore(f.stateFile) }));
    assert.deepEqual(restarted.scan(), []);
    assert.equal(restarted.request("cowork-una", "auto"), "exists");
    assert.equal(f.calls.length, 1);
  } finally {
    f.cleanup();
  }
});

test("el barrido ignora flujos que no terminaron", () => {
  const f = fixture();
  try {
    f.state.setSince(SINCE);
    f.cycle("cowork-a-medias", "acme-api", { complete: false });
    assert.deepEqual(createDistiller(f.deps()).scan(), []);
  } finally {
    f.cleanup();
  }
});

test("una sola destilación por repo: la segunda espera; repos distintos corren en paralelo", async () => {
  const f = fixture();
  try {
    const started: string[] = [];
    const gates: Array<{ resolve: (value: string) => void }> = [];
    const distiller = createDistiller(f.deps({
      runClaudeP: (prompt) => {
        started.push(prompt.split(" ")[0]);
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
    }));
    f.cycle("cowork-uno", "acme-api");
    f.cycle("cowork-dos", "acme-api");
    f.cycle("cowork-web", "acme-web");
    for (const session of ["cowork-uno", "cowork-dos", "cowork-web"]) assert.equal(distiller.request(session, "manual"), "queued");
    await tick();
    assert.deepEqual(started, ["sesión=cowork-uno", "sesión=cowork-web"]);
    assert.equal(distiller.stateOf("cowork-dos")?.status, "running");
    assert.equal(f.state.get("cowork-dos"), null);
    gates.splice(0).forEach((gate) => gate.resolve(NONE));
    await tick();
    assert.deepEqual(started, ["sesión=cowork-uno", "sesión=cowork-web", "sesión=cowork-dos"]);
    gates.splice(0).forEach((gate) => gate.resolve(NONE));
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-dos")?.status, "done");
  } finally {
    f.cleanup();
  }
});

test("timeout: la destilación que no responde queda failed con el error, sin colgar la cola", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-lenta", "acme-api");
    const distiller = createDistiller(f.deps({ timeoutMs: 20, runClaudeP: () => new Promise<string>(() => {}) }));
    distiller.request("cowork-lenta", "manual");
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-lenta")?.status, "failed");
    assert.match(distiller.stateOf("cowork-lenta")?.error ?? "", /tiempo límite/);
  } finally {
    f.cleanup();
  }
});

test("manual: busy mientras está en cola o corriendo; un failed se puede reintentar", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-r", "acme-api");
    let attempt = 0;
    const gate = deferred<string>();
    const distiller = createDistiller(f.deps({
      runClaudeP: async () => {
        attempt++;
        if (attempt === 1) throw new Error("claude -p salió con código 1: sin cuota");
        return gate.promise;
      },
    }));
    distiller.request("cowork-r", "manual");
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-r")?.status, "failed");
    assert.match(distiller.stateOf("cowork-r")?.error ?? "", /sin cuota/);
    assert.equal(distiller.request("cowork-r", "auto"), "exists");
    assert.equal(distiller.request("cowork-r", "manual"), "queued");
    assert.equal(distiller.request("cowork-r", "manual"), "busy");
    gate.resolve(NONE);
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-r")?.status, "done");
  } finally {
    f.cleanup();
  }
});

test("una sesión sin ciclo, con nombre inseguro o de un repo desconocido es unknown", () => {
  const f = fixture();
  try {
    const distiller = createDistiller(f.deps());
    f.cycle("cowork-otro-repo", "acme-desconocido");
    assert.equal(distiller.request("../etc", "manual"), "unknown");
    assert.equal(distiller.request("cowork-sin-ciclo", "manual"), "unknown");
    assert.equal(distiller.request("cowork-otro-repo", "manual"), "unknown");
  } finally {
    f.cleanup();
  }
});

test("un running huérfano (Ronin murió a media destilación) se ve como failed y se puede reintentar", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-huerfana", "acme-api");
    f.state.set("cowork-huerfana", { status: "running", repo: "acme-api", at: SINCE });
    const distiller = createDistiller(f.deps());
    assert.deepEqual(distiller.stateOf("cowork-huerfana"), { status: "failed", repo: "acme-api", at: SINCE, error: "interrumpida: Ronin se reinició antes de terminar" });
    assert.equal(distiller.request("cowork-huerfana", "auto"), "exists");
    assert.equal(distiller.request("cowork-huerfana", "manual"), "queued");
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-huerfana")?.status, "done");
  } finally {
    f.cleanup();
  }
});

test("el primer barrido fija la marca de tiempo y nunca destila ciclos que terminaron antes", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-vieja", "acme-api", { finishedAt: NOW - 60_000 });
    const distiller = createDistiller(f.deps());
    assert.deepEqual(distiller.scan(), []);
    assert.equal(f.state.since(), NOW);
    assert.deepEqual(distiller.scan(), []);
    f.cycle("cowork-nueva", "acme-api", { finishedAt: NOW + 1_000 });
    assert.deepEqual(distiller.scan(), ["cowork-nueva"]);
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-vieja"), null);
    assert.equal(distiller.request("cowork-vieja", "manual"), "queued");
    await distiller.idle();
    assert.equal(f.calls.length, 2);
  } finally {
    f.cleanup();
  }
});

test("una propuesta de arquitectura, al aprobarse, pasa a kbSuggestions", async () => {
  const f = fixture();
  try {
    f.cycle("cowork-arq", "acme-api");
    const distiller = createDistiller(f.deps({ runClaudeP: async () => JSON.stringify({ entries: [{ text: "El importador vive en src/csv", kind: "arquitectura" }] }) }));
    distiller.request("cowork-arq", "manual");
    await distiller.idle();
    const [pending] = f.store.pending("acme-api");
    f.store.resolve("acme-api", pending.id, "approve");
    const memory = f.store.read("acme-api");
    assert.deepEqual(memory.entries, []);
    assert.deepEqual(memory.kbSuggestions.map((s) => [s.text, s.source]), [["El importador vive en src/csv", "cowork-arq"]]);
  } finally {
    f.cleanup();
  }
});

test("listCycleSessions lista sólo cycle dirs de Ronin con nombre seguro", () => {
  const root = mkdtempSync(join(tmpdir(), "ronin-cycles-"));
  try {
    mkdirSync(join(root, "cowork-cycle-cowork-a"));
    mkdirSync(join(root, "cowork-cycle-cowork-b"));
    mkdirSync(join(root, "otra-carpeta"));
    writeFileSync(join(root, "cowork-cycle-archivo"), "");
    assert.deepEqual(listCycleSessions(root).sort(), ["cowork-a", "cowork-b"]);
    assert.deepEqual(listCycleSessions(join(root, "no-existe")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startMemoryDistiller barre periódicamente, sobrevive a un barrido que lanza y stop lo detiene", async () => {
  let scans = 0;
  const fake: Pick<Distiller, "scan"> = { scan: () => { scans++; if (scans === 1) throw new Error("disco"); return []; } };
  const handle = startMemoryDistiller(fake, 10);
  await new Promise((resolve) => setTimeout(resolve, 60));
  handle.stop();
  const seen = scans;
  assert.ok(seen >= 2, String(seen));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(scans, seen);
});

const SKILL_TEMPLATE = `${TEMPLATE}\ncatálogo:\n{skillCatalog}\nofrecidas:\n{offeredSkills}`;
const DRAFT_TEMPLATE = "REDACTA sesión={session} resumen={summary}\nactual:\n{current}\ncatálogo:\n{catalog}";
const TRIAGE = { reusable: true, name: "migracion-reversible", summary: "Cómo agregar una migración reversible.", updates: null };
const DRAFT = { name: "migracion-reversible", description: "Agrega una migración reversible y la prueba ida y vuelta.", body: "1. Crea la migración.\n2. Pruébala ida y vuelta.", changes: "" };
const DRAFT_OUT = JSON.stringify(DRAFT);
const NOT_REUSABLE = "la destilación no encontró un procedimiento reutilizable";
const withSkill = (skill: unknown, entries: unknown[] = [{ text: "Tests: usar `make test-unit`", kind: "comando" }]) => JSON.stringify({ entries, skill });

function skillFixture() {
  const f = fixture();
  const learned = createLearnedSkillStore({
    root: join(f.root, "skills", "learned"),
    metaFile: join(f.root, "skills", "learned.json"),
    historyDir: join(f.root, "skills", "history"),
    listRepos: () => ["acme-api", "acme-web"],
    contextFor: (repo) => ({ repo }),
    associate: () => {},
    now: () => NOW,
  });
  const outputs: string[] = [];
  const prompts: string[] = [];

  function gated(session: string, repo: string, options: { verify?: "passed" | "failed" | "pending" | null; verifyCmd?: boolean; complete?: boolean; evidence?: string | null } = {}): string {
    const dir = f.cycle(session, repo, { complete: options.complete, ...(options.evidence !== undefined ? { evidence: options.evidence } : {}) });
    const { verify = "passed", verifyCmd = true } = options;
    writeFileSync(join(dir, "flow.json"), JSON.stringify({
      stages: [{ key: "planning", label: "Plan", icon: "P", ...(verifyCmd ? { verifyCmd: "make test" } : {}) }, { key: "done", label: "Fin", icon: "F" }],
      verifyAfter: [],
    }));
    if (verify) writeFileSync(join(dir, "verify-planning.json"), JSON.stringify({ attempts: 1, status: verify }));
    return dir;
  }

  function skills(overrides: Partial<SkillDistillDeps> = {}): SkillDistillDeps {
    return { store: learned, globalEnabled: () => true, reservedNames: () => ["api-review"], promptTemplate: () => DRAFT_TEMPLATE, ...overrides };
  }

  function deps(overrides: Partial<DistillerDeps> = {}): DistillerDeps {
    return f.deps({
      promptTemplate: () => SKILL_TEMPLATE,
      runClaudeP: async (prompt, options) => {
        f.calls.push({ prompt, options });
        prompts.push(prompt);
        const next = outputs.shift();
        if (next === undefined) throw new Error("sin respuesta preparada");
        return next;
      },
      skills: skills(),
      ...overrides,
    });
  }

  function approveLearned(): void {
    const proposal = learned.propose({ repo: "acme-api", source: "cowork-previa", ...DRAFT });
    learned.resolve(proposal.id, "approve", { contentHash: proposal.contentHash });
  }

  return { ...f, learned, outputs, prompts, gated, skills, deps, approveLearned };
}

test("skills: con el gate aprobado, el triaje viaja en la llamada de memoria y la redacción en una segunda; queda pending", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-mig", "acme-api");
    f.outputs.push(withSkill(TRIAGE), DRAFT_OUT);
    const distiller = createDistiller(f.deps());
    assert.equal(distiller.request("cowork-mig", "auto"), "queued");
    await distiller.idle();
    assert.equal(f.prompts.length, 2);
    assert.match(f.prompts[0], /catálogo:\n\(vacío\)\nofrecidas:\n\(ninguna\)/);
    assert.match(f.prompts[1], /^REDACTA sesión=cowork-mig resumen=Cómo agregar una migración reversible\.\nactual:\n\(ninguna: es una skill nueva\)/);
    assert.equal(f.calls[1].options.timeoutMs, DISTILL_TIMEOUT_MS);
    assert.equal(f.calls[1].options.command, "agy");
    assert.equal(f.calls[1].options.cwd, f.root);
    assert.deepEqual(distiller.stateOf("cowork-mig"), { status: "done", repo: "acme-api", at: NOW, proposed: 1 });
    const [pending] = f.learned.pending();
    assert.deepEqual([pending.name, pending.kind, pending.source], ["migracion-reversible", "new", "cowork-mig"]);
    assert.deepEqual(distiller.skillStateOf("cowork-mig"), { status: "done", at: NOW, proposalId: pending.id });
  } finally {
    f.cleanup();
  }
});

test("skills: un skill inválido deja failed sólo la parte de skill y la memoria se acepta igual; null deja skipped", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-invalido", "acme-api");
    f.gated("cowork-nulo", "acme-api");
    f.outputs.push(withSkill({ ...TRIAGE, summary: "" }), withSkill(null));
    const distiller = createDistiller(f.deps());
    distiller.request("cowork-invalido", "manual");
    distiller.request("cowork-nulo", "manual");
    await distiller.idle();
    assert.equal(f.prompts.length, 2);
    assert.equal(distiller.stateOf("cowork-invalido")?.status, "done");
    assert.equal(distiller.skillStateOf("cowork-invalido")?.status, "failed");
    assert.match(distiller.skillStateOf("cowork-invalido")?.error ?? "", /skill\.summary/);
    assert.deepEqual(distiller.skillStateOf("cowork-nulo"), { status: "skipped", at: NOW, reason: NOT_REUSABLE });
    assert.equal(f.store.pending("acme-api").length, 1);
    assert.deepEqual(f.learned.pending(), []);
  } finally {
    f.cleanup();
  }
});

test("skills: se omite sin verifyCmd aprobado, sin verifyCmd, con un gate failed o con 10 propuestas pendientes", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-sin-verify", "acme-api", { verify: null });
    f.gated("cowork-sin-cmd", "acme-api", { verifyCmd: false });
    f.gated("cowork-fallido", "acme-api", { verify: "failed" });
    const distiller = createDistiller(f.deps());
    for (const session of ["cowork-sin-verify", "cowork-sin-cmd", "cowork-fallido"]) {
      f.outputs.push(withSkill(TRIAGE));
      distiller.request(session, "manual");
      await distiller.idle();
      assert.deepEqual(distiller.skillStateOf(session), { status: "skipped", at: NOW, reason: NO_DETERMINISTIC_GATE }, session);
      assert.equal(distiller.stateOf(session)?.status, "done", session);
    }
    assert.equal(f.prompts.length, 3);
    for (let index = 0; index < 10; index++) f.learned.propose({ repo: "acme-api", source: "cowork-x", ...DRAFT, name: `skill-${index}` });
    f.gated("cowork-lleno", "acme-api");
    f.outputs.push(withSkill(TRIAGE));
    distiller.request("cowork-lleno", "manual");
    await distiller.idle();
    assert.match(distiller.skillStateOf("cowork-lleno")?.reason ?? "", /10 propuestas de skills pendientes/);
    assert.equal(f.prompts.length, 4);
  } finally {
    f.cleanup();
  }
});

test("skills: con una actualización ya pendiente para la misma skill se omite sin redactar", async () => {
  const f = skillFixture();
  try {
    f.approveLearned();
    f.learned.propose({ repo: "acme-api", source: "cowork-otra", ...DRAFT, body: `${DRAFT.body}\n3. Otra mejora.` });
    f.gated("cowork-mejora", "acme-api");
    f.outputs.push(withSkill({ ...TRIAGE, updates: "migracion-reversible" }));
    const distiller = createDistiller(f.deps());
    distiller.request("cowork-mejora", "manual");
    await distiller.idle();
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(distiller.skillStateOf("cowork-mejora"), { status: "skipped", at: NOW, reason: "ya hay una actualización pendiente para migracion-reversible" });
  } finally {
    f.cleanup();
  }
});

test("skills: un triaje que nombra una learned existente redacta una actualización con el SKILL.md actual", async () => {
  const f = skillFixture();
  try {
    f.approveLearned();
    f.gated("cowork-refina", "acme-api");
    f.outputs.push(withSkill({ ...TRIAGE, name: "Migración Reversible" }), JSON.stringify({ ...DRAFT, body: `${DRAFT.body}\n3. Prueba el rollback.`, changes: "Agrega el rollback" }));
    const distiller = createDistiller(f.deps());
    distiller.request("cowork-refina", "manual");
    await distiller.idle();
    assert.match(f.prompts[1], /actual:\n---\nname: migracion-reversible\n/);
    const [pending] = f.learned.pending();
    assert.equal(pending.kind, "update");
    assert.equal(f.learned.detail(pending.id).changes, "Agrega el rollback");
  } finally {
    f.cleanup();
  }
});

test("skills: corre con la memoria apagada y el aprendizaje encendido (las entradas se ignoran); con ambos apagados no llama al motor", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-solo-skill", "acme-api");
    f.outputs.push(withSkill(TRIAGE), DRAFT_OUT);
    const memoryOff = createDistiller(f.deps({ globalEnabled: () => false }));
    memoryOff.request("cowork-solo-skill", "manual");
    await memoryOff.idle();
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(memoryOff.stateOf("cowork-solo-skill"), { status: "skipped", repo: "acme-api", at: NOW, reason: "la memoria está desactivada" });
    assert.deepEqual(f.store.pending("acme-api"), []);
    assert.equal(memoryOff.skillStateOf("cowork-solo-skill")?.status, "done");

    f.learned.setLearning("acme-web", false);
    f.gated("cowork-nada", "acme-web");
    memoryOff.request("cowork-nada", "manual");
    await memoryOff.idle();
    assert.equal(f.prompts.length, 2);
    assert.equal(memoryOff.skillStateOf("cowork-nada"), null);
    assert.equal(memoryOff.stateOf("cowork-nada")?.status, "skipped");
  } finally {
    f.cleanup();
  }
});

test("skills: una plantilla memory sin {skillCatalog} no hace el triaje y lo dice", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-plantilla-vieja", "acme-api");
    f.outputs.push(withSkill(TRIAGE));
    const distiller = createDistiller(f.deps({ promptTemplate: () => TEMPLATE }));
    distiller.request("cowork-plantilla-vieja", "manual");
    await distiller.idle();
    assert.equal(f.prompts.length, 1);
    assert.equal(distiller.stateOf("cowork-plantilla-vieja")?.status, "done");
    assert.deepEqual(distiller.skillStateOf("cowork-plantilla-vieja"), { status: "skipped", at: NOW, reason: MEMORY_TRIAGE_WARNING });
  } finally {
    f.cleanup();
  }
});

test("redacción: JSON inválido y reglas de §4 dejan failed, un skip deja skipped y un timeout no cuelga la cola", async () => {
  const f = skillFixture();
  try {
    for (const session of ["cowork-json", "cowork-skip", "cowork-ruta"]) f.gated(session, "acme-api");
    f.outputs.push(
      withSkill(TRIAGE), "no es json",
      withSkill(TRIAGE), '{"skip":"es demasiado específico del repo"}',
      withSkill(TRIAGE), JSON.stringify({ ...DRAFT, body: "cd /Users/alguien/code && make" }),
    );
    const distiller = createDistiller(f.deps());
    for (const session of ["cowork-json", "cowork-skip", "cowork-ruta"]) distiller.request(session, "manual");
    await distiller.idle();
    assert.equal(distiller.skillStateOf("cowork-json")?.status, "failed");
    assert.match(distiller.skillStateOf("cowork-json")?.error ?? "", /JSON/);
    assert.deepEqual(distiller.skillStateOf("cowork-skip"), { status: "skipped", at: NOW, reason: "la redacción la omitió: es demasiado específico del repo" });
    assert.equal(distiller.skillStateOf("cowork-ruta")?.status, "failed");
    assert.match(distiller.skillStateOf("cowork-ruta")?.error ?? "", /ruta absoluta \(\/Users\/\)/);
    assert.deepEqual(f.learned.pending(), []);

    f.gated("cowork-lenta", "acme-api");
    let call = 0;
    const slow = createDistiller(f.deps({ timeoutMs: 20, runClaudeP: () => (++call === 1 ? Promise.resolve(withSkill(TRIAGE)) : new Promise<string>(() => {})) }));
    slow.request("cowork-lenta", "manual");
    await slow.idle();
    assert.equal(slow.stateOf("cowork-lenta")?.status, "done");
    assert.equal(slow.skillStateOf("cowork-lenta")?.status, "failed");
    assert.match(slow.skillStateOf("cowork-lenta")?.error ?? "", /tiempo límite/);
  } finally {
    f.cleanup();
  }
});

test("skills: cada sesión propone una sola vez, aunque Ronin se reinicie o se vuelva a destilar la memoria", async () => {
  const f = skillFixture();
  try {
    f.state.setSince(SINCE);
    f.gated("cowork-una", "acme-api");
    f.outputs.push(withSkill(TRIAGE), DRAFT_OUT);
    const first = createDistiller(f.deps());
    assert.deepEqual(first.scan(), ["cowork-una"]);
    await first.idle();
    assert.equal(first.skillStateOf("cowork-una")?.status, "done");
    const restarted = createDistiller(f.deps({ state: createDistillStateStore(f.stateFile) }));
    assert.deepEqual(restarted.scan(), []);
    assert.equal(restarted.skillStateOf("cowork-una")?.status, "done");
    f.outputs.push(withSkill(TRIAGE));
    assert.equal(restarted.request("cowork-una", "manual"), "queued");
    await restarted.idle();
    assert.equal(f.prompts.length, 3);
    assert.equal(f.learned.pending().length, 1);
  } finally {
    f.cleanup();
  }
});

test("manual: salta el triaje y el verifyCmd pero exige el flujo completo; busy, reintento y apagado global", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-manual", "acme-api", { verify: null, verifyCmd: false });
    f.gated("cowork-incompleta", "acme-api", { complete: false });
    const distiller = createDistiller(f.deps());
    assert.equal(distiller.requestSkill("cowork-incompleta"), "incomplete");
    assert.equal(distiller.requestSkill("../etc"), "unknown");
    assert.equal(distiller.requestSkill("cowork-sin-ciclo"), "unknown");
    f.outputs.push("no es json");
    assert.equal(distiller.requestSkill("cowork-manual"), "queued");
    assert.equal(distiller.skillStateOf("cowork-manual")?.status, "running");
    assert.equal(distiller.requestSkill("cowork-manual"), "busy");
    assert.equal(distiller.request("cowork-manual", "manual"), "busy");
    await distiller.idle();
    assert.equal(f.prompts.length, 1);
    assert.ok(f.prompts[0].includes(`resumen=${MANUAL_SUMMARY}`));
    assert.equal(distiller.skillStateOf("cowork-manual")?.status, "failed");
    assert.equal(distiller.stateOf("cowork-manual"), null);
    f.outputs.push(DRAFT_OUT);
    assert.equal(distiller.requestSkill("cowork-manual"), "queued");
    await distiller.idle();
    assert.equal(distiller.skillStateOf("cowork-manual")?.status, "done");

    f.state.setSince(SINCE);
    f.outputs.push(withSkill(TRIAGE));
    assert.deepEqual(distiller.scan(), ["cowork-manual"]);
    await distiller.idle();
    assert.equal(f.prompts.length, 3);
    assert.equal(distiller.stateOf("cowork-manual")?.status, "done");
    assert.equal(createDistiller(f.deps({ skills: f.skills({ globalEnabled: () => false }) })).requestSkill("cowork-manual"), "disabled");
  } finally {
    f.cleanup();
  }
});

test("manual: la redacción comparte la cola por repo con la destilación", async () => {
  const f = skillFixture();
  try {
    const started: string[] = [];
    const gates: Array<{ resolve: (value: string) => void }> = [];
    f.gated("cowork-a", "acme-api", { verify: null });
    f.gated("cowork-b", "acme-api");
    const distiller = createDistiller(f.deps({
      runClaudeP: (prompt) => {
        started.push(prompt.startsWith("REDACTA") ? "redacción" : "memoria");
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
    }));
    distiller.request("cowork-a", "manual");
    assert.equal(distiller.requestSkill("cowork-b"), "queued");
    await tick();
    assert.deepEqual(started, ["memoria"]);
    gates[0].resolve(NONE);
    await tick();
    assert.deepEqual(started, ["memoria", "redacción"]);
    gates[1].resolve(DRAFT_OUT);
    await distiller.idle();
    assert.equal(distiller.skillStateOf("cowork-b")?.status, "done");
  } finally {
    f.cleanup();
  }
});

test("un running huérfano de la parte de skill se ve como failed (interrumpida) y se puede reintentar", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-huerfana-skill", "acme-api");
    f.state.setSkill("cowork-huerfana-skill", "acme-api", { status: "running", at: SINCE });
    const distiller = createDistiller(f.deps());
    assert.deepEqual(distiller.skillStateOf("cowork-huerfana-skill"), { status: "failed", at: SINCE, error: "interrumpida: Ronin se reinició antes de terminar" });
    f.outputs.push(DRAFT_OUT);
    assert.equal(distiller.requestSkill("cowork-huerfana-skill"), "queued");
    await distiller.idle();
    assert.equal(distiller.skillStateOf("cowork-huerfana-skill")?.status, "done");
  } finally {
    f.cleanup();
  }
});

test("state.json: la parte de skill es un subcampo que convive con la de memoria", () => {
  const f = skillFixture();
  try {
    f.state.setSkill("cowork-s", "acme-api", { status: "done", at: 1, proposalId: "s_1" });
    assert.equal(f.state.get("cowork-s"), null);
    f.state.set("cowork-s", { status: "done", repo: "acme-api", at: 2, proposed: 0 });
    assert.deepEqual(f.state.skill("cowork-s"), { status: "done", at: 1, proposalId: "s_1" });
    assert.deepEqual(JSON.parse(readFileSync(f.stateFile, "utf8")).sessions["cowork-s"], {
      status: "done", repo: "acme-api", at: 2, proposed: 0, skill: { status: "done", at: 1, proposalId: "s_1" },
    });
    f.state.set("cowork-s", { status: "failed", repo: "acme-api", at: 3, error: "x" });
    assert.equal(f.state.skill("cowork-s")?.proposalId, "s_1");
  } finally {
    f.cleanup();
  }
});

test("F1: mientras se redacta, la memoria ya guardada se ve done y la parte de skill running", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-redactando", "acme-api");
    const gates: Array<{ resolve: (value: string) => void }> = [];
    const distiller = createDistiller(f.deps({
      runClaudeP: () => {
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
    }));
    assert.equal(distiller.request("cowork-redactando", "manual"), "queued");
    while (gates.length < 1) await tick();
    assert.equal(distiller.stateOf("cowork-redactando")?.status, "running");
    gates[0].resolve(withSkill(TRIAGE));
    while (gates.length < 2) await tick();
    assert.deepEqual(distiller.stateOf("cowork-redactando"), { status: "done", repo: "acme-api", at: NOW, proposed: 1 });
    assert.equal(distiller.skillStateOf("cowork-redactando")?.status, "running");
    gates[1].resolve(DRAFT_OUT);
    await distiller.idle();
    assert.equal(distiller.stateOf("cowork-redactando")?.status, "done");
    assert.equal(distiller.skillStateOf("cowork-redactando")?.status, "done");
  } finally {
    f.cleanup();
  }
});

test("F2: un error de E/S en el triaje deja failed sólo la parte de skill; la memoria sigue done", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-es", "acme-api");
    f.outputs.push(withSkill(TRIAGE));
    const store = { ...f.learned, names: (): string[] => { throw new Error("EIO: no se pudo leer learned.json"); } };
    const distiller = createDistiller(f.deps({ skills: f.skills({ store }) }));
    distiller.request("cowork-es", "manual");
    await distiller.idle();
    assert.deepEqual(distiller.stateOf("cowork-es"), { status: "done", repo: "acme-api", at: NOW, proposed: 1 });
    assert.equal(distiller.skillStateOf("cowork-es")?.status, "failed");
    assert.match(distiller.skillStateOf("cowork-es")?.error ?? "", /EIO/);
  } finally {
    f.cleanup();
  }
});

test("F3: una redacción que cae en una learned existente sin el SKILL.md actual queda failed, sin propuesta a ciegas", async () => {
  const f = skillFixture();
  try {
    f.approveLearned();
    f.gated("cowork-ciega-manual", "acme-api", { verify: null });
    f.gated("cowork-ciega-auto", "acme-api");
    const distiller = createDistiller(f.deps());
    f.outputs.push(JSON.stringify({ ...DRAFT, name: "Migración Reversible" }));
    assert.equal(distiller.requestSkill("cowork-ciega-manual"), "queued");
    await distiller.idle();
    assert.deepEqual(distiller.skillStateOf("cowork-ciega-manual"), { status: "failed", at: NOW, error: "actualización sin texto actual" });
    f.outputs.push(withSkill({ ...TRIAGE, name: "otra-cosa" }), DRAFT_OUT);
    distiller.request("cowork-ciega-auto", "manual");
    await distiller.idle();
    assert.equal(f.prompts.length, 3);
    assert.match(f.prompts[2], /actual:\n\(ninguna: es una skill nueva\)/);
    assert.deepEqual(distiller.skillStateOf("cowork-ciega-auto"), { status: "failed", at: NOW, error: "actualización sin texto actual" });
    assert.equal(distiller.stateOf("cowork-ciega-auto")?.status, "done");
    assert.deepEqual(f.learned.pending(), []);
  } finally {
    f.cleanup();
  }
});

test("F4: entradas de memoria inválidas con un skill válido: la memoria queda failed y el triaje redacta igual", async () => {
  const f = skillFixture();
  try {
    f.gated("cowork-entradas", "acme-api");
    f.outputs.push(withSkill(TRIAGE, [{ text: "algo", kind: "inventado" }]), DRAFT_OUT);
    const distiller = createDistiller(f.deps());
    distiller.request("cowork-entradas", "manual");
    await distiller.idle();
    assert.equal(f.prompts.length, 2);
    assert.equal(distiller.stateOf("cowork-entradas")?.status, "failed");
    assert.match(distiller.stateOf("cowork-entradas")?.error ?? "", /kind inválido/);
    assert.deepEqual(f.store.pending("acme-api"), []);
    const [pending] = f.learned.pending();
    assert.equal(pending.name, "migracion-reversible");
    assert.deepEqual(distiller.skillStateOf("cowork-entradas"), { status: "done", at: NOW, proposalId: pending.id });
  } finally {
    f.cleanup();
  }
});
