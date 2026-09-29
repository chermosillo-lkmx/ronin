import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ClaudePOptions } from "./claude-p.js";
import { createMemoryStore } from "./memory.js";
import {
  createDistiller,
  createDistillStateStore,
  DISTILL_TIMEOUT_MS,
  listCycleSessions,
  startMemoryDistiller,
  type Distiller,
  type DistillerDeps,
} from "./memory-distiller.js";

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
