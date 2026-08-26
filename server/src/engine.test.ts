import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createSession } from "./tmux.js";

// engine.ts initializes activeMode from COWORK_MODE (default "simulated") at import — safe,
// no server/tmux side effects until start() is called.
const {
  adoptSession,
  applyContextPressure,
  commitHotApply,
  launchAdhoc,
  ownsBoard,
  owningSession,
  paneTargetFor,
  planHotApply,
  pollLive,
  rediscoverAdopted,
  releaseAdoption,
  StageInFlightError,
  start,
  stopEngine,
  stopWorker,
  workerInput,
  workerPane,
  worktreeReferencedByOthers,
} = await import("./engine.js");
const { cycleDirForSession, ensureCycleDir, evidenceDir, readFlow, writeFlow } = await import("./stages.js");
const { snapshot, workers } = await import("./state.js");

const pexec = promisify(execFile);

function envWithoutTmux(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

async function liveSessionCreatedAt(socket: string, session: string): Promise<number> {
  const { stdout } = await pexec("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name} #{session_created}"], { env: envWithoutTmux() });
  const line = stdout.trim().split("\n").find((l) => l.startsWith(`${session} `))!;
  return Number(line.split(" ")[1]) * 1000;
}

/** Mismo patrón que tmux.test.ts (T0.8/M5): socket propio y desechable, nunca el `default`. */
async function withIsolatedSocket(fn: (socket: string) => Promise<void>): Promise<void> {
  const socket = `ronin-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const previousSocket = process.env.COWORK_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.COWORK_TMUX_SOCKET = socket;
  delete process.env.TMUX;
  try {
    await fn(socket);
  } finally {
    process.env.COWORK_TMUX_SOCKET = previousSocket;
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    await pexec("tmux", ["-L", socket, "kill-server"], { env: envWithoutTmux() }).catch(() => {});
  }
}
type W = { id: string; worktree?: string };

test("ownsBoard: kind:'adopted' se desacopla del tablero, igual que research/action (F2)", () => {
  assert.equal(ownsBoard({ kind: "adopted" } as any), false);
  assert.equal(ownsBoard({ kind: "research" } as any), false);
  assert.equal(ownsBoard({ kind: "action" } as any), false);
  assert.equal(ownsBoard({ kind: undefined } as any), true);
  assert.equal(ownsBoard({ kind: "task" } as any), true);
});

test("owningSession: strips the verifier suffix to find the parent (P1g)", () => {
  assert.equal(owningSession("cowork-CU-123"), "cowork-CU-123");
  assert.equal(owningSession("cowork-CU-123-verify"), "cowork-CU-123");
  assert.equal(owningSession("cowork-CU-123-verify-2"), "cowork-CU-123");
  assert.equal(owningSession("cowork-CU-123-action-review-verify"), "cowork-CU-123-action-review");
  // a task whose key legitimately ends in "verify" is only stripped at the suffix boundary
  assert.equal(owningSession("cowork-verify-login"), "cowork-verify-login");
});

test("worktreeReferencedByOthers: a verifier sharing the parent's worktree keeps it alive (refcount, P1-6)", () => {
  const wt = "/home/u/.cowork/worktrees/abc/cowork-CU-1";
  const main = { id: "w1", worktree: wt };
  const verifier = { id: "v1", worktree: wt }; // inherited the parent's worktree
  const all: W[] = [main, verifier];
  // Tearing down the MAIN worker: the verifier still references the worktree → keep it.
  assert.equal(worktreeReferencedByOthers(all as any, main.id, wt), true);
  // Once the verifier is gone, nothing else references it → safe to remove.
  assert.equal(worktreeReferencedByOthers([main] as any, main.id, wt), false);
  // A worker never counts itself.
  assert.equal(worktreeReferencedByOthers([main] as any, main.id, wt), false);
});

test("applyContextPressure: change-gated set + clear-on-disappearance (P4)", () => {
  const worker: any = { id: "w1" };
  // first detection → changed
  assert.equal(applyContextPressure(worker, "Run /clear to save 45k tokens\n› "), true);
  assert.equal(worker.contextPressure.tokens, 45);
  // same pane again → NOT changed (no SSE churn / log spam)
  assert.equal(applyContextPressure(worker, "Run /clear to save 45k tokens\n› "), false);
  // signal leaves the recent lines → cleared, and that's a change
  assert.equal(applyContextPressure(worker, "just working\n› "), true);
  assert.equal(worker.contextPressure, undefined);
  // still clear → not a change
  assert.equal(applyContextPressure(worker, "still working\n› "), false);
});

test("simulated mode: a launched worker touches NO git worktree and NO tmux session (P1-8)", async () => {
  const w = await launchAdhoc("hacer algo simulado", "sim task", "monorepo");
  try {
    assert.ok(w);
    assert.equal(w!.session, undefined);  // no tmux session
    assert.equal(w!.worktree, undefined); // no git worktree → simulated never touches git
    assert.equal(w!.cwd, undefined);
  } finally {
    if (w) await stopWorker(w.id);
  }
});

test("stopEngine clears the simulated tick before it can continue", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timer = {} as NodeJS.Timeout;
  let scheduled = 0;
  let cleared = 0;
  globalThis.setInterval = (() => { scheduled++; return timer; }) as typeof setInterval;
  globalThis.clearInterval = ((value: NodeJS.Timeout) => {
    assert.equal(value, timer);
    cleared++;
  }) as typeof clearInterval;

  try {
    await start("mock");
    stopEngine();
    assert.equal(scheduled, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    stopEngine();
  }
});

// ---- F2/T4: adoptSession/releaseAdoption contra tmux REAL, en un socket propio (54a/54b) ----

test("adoptSession: adopta una sesión ajena de verdad — kind:'adopted', origin:'adopted', %N real, marca en tmux; releaseAdoption la suelta sin matarla", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-e2e-adopt", "/tmp");
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-e2e-adopt");

    const outcome = await adoptSession({
      session: "foreign-e2e-adopt",
      confirm: true,
      repo: "monorepo",
      expectedSessionCreatedAt,
    });
    assert.equal(outcome.status, "created");

    const worker = snapshot().workers.find((w) => w.session === "foreign-e2e-adopt");
    assert.ok(worker, "el worker adoptado debe existir en el snapshot");
    assert.equal(worker!.kind, "adopted");
    assert.equal(worker!.origin, "adopted");
    assert.match(worker!.adoptedPane ?? "", /^%\d+$/);

    await releaseAdoption("foreign-e2e-adopt");
    assert.equal(snapshot().workers.some((w) => w.session === "foreign-e2e-adopt"), false, "releaseAdoption quita el worker");

    // La sesión SIGUE VIVA — releaseAdoption suelta, nunca mata.
    await assert.doesNotReject(() =>
      pexec("tmux", ["-L", process.env.COWORK_TMUX_SOCKET!, "has-session", "-t", "foreign-e2e-adopt"], { env: envWithoutTmux() })
    );
  });
});

test("pollLive (54c): cuando la sesión adoptada muere por su cuenta, quita el worker pero NO borra el cycle dir", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-e2e-death", "/tmp");
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-e2e-death");

    await adoptSession({ session: "foreign-e2e-death", confirm: true, repo: "monorepo", expectedSessionCreatedAt });
    const cycle = cycleDirForSession("foreign-e2e-death");
    assert.equal(existsSync(cycle), true);

    await pexec("tmux", ["-L", socket, "kill-session", "-t", "foreign-e2e-death"], { env: envWithoutTmux() });
    await pollLive();

    assert.equal(snapshot().workers.some((w) => w.session === "foreign-e2e-death"), false, "el worker se quita al morir la sesión");
    assert.equal(existsSync(cycle), true, "el cycle dir de un adoptado NO se borra cuando la sesión muere sola");
    rmSync(cycle, { recursive: true, force: true });
  });
});

test("rediscoverAdopted (54a): tras un 'reinicio' (worker quitado a mano, marca+flow.json siguen en tmux/disco), reconstruye con kind/origin/%N/flow correctos", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-e2e-rediscover", "/tmp");
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-e2e-rediscover");
    await adoptSession({ session: "foreign-e2e-rediscover", confirm: true, repo: "monorepo", expectedSessionCreatedAt });

    const before = snapshot().workers.find((w) => w.session === "foreign-e2e-rediscover")!;
    assert.ok(before);
    // Simula "el server reinició": el worker en memoria se pierde, pero la marca en tmux y
    // flow.json en disco (la fuente de verdad, T2) sobreviven.
    await stopWorker(before.id); // MODE="simulated" en este proceso ⇒ sólo quita el registro en memoria

    await rediscoverAdopted();

    const after = snapshot().workers.find((w) => w.session === "foreign-e2e-rediscover");
    assert.ok(after, "rediscoverAdopted debe reconstruir el worker");
    assert.equal(after!.kind, "adopted");
    assert.equal(after!.origin, "adopted");
    assert.match(after!.adoptedPane ?? "", /^%\d+$/);
    assert.equal(after!.repo, "monorepo");

    await releaseAdoption("foreign-e2e-rediscover");
    rmSync(cycleDirForSession("foreign-e2e-rediscover"), { recursive: true, force: true });
  });
});

// ---- T13: hot-apply sin falso verde — planHotApply/commitHotApply contra el cycle dir REAL ----

const HOT_SESSION_A = "cowork-t13-hotapply-a";
const HOT_SESSION_B = "cowork-t13-hotapply-b";

function seedLiveWorker(session: string, repo: string, stageKey: string, flow: { stages: any[]; verifyAfter: string | null }) {
  const cycle = cycleDirForSession(session);
  ensureCycleDir(cycle);
  writeFlow(cycle, flow);
  writeFileSync(join(cycle, stageKey), ""); // sentinel — "ya en curso" en esa etapa
  const worker = {
    id: `w-${session}`,
    label: session,
    repo,
    taskId: session,
    state: "busy" as const,
    stage: "test",
    startedAt: Date.now(),
    session,
    cycle,
    stageKey,
  };
  workers.push(worker as any);
  return { cycle, worker };
}

function removeLiveWorker(id: string, cycle: string) {
  const idx = workers.findIndex((w) => w.id === id);
  if (idx >= 0) workers.splice(idx, 1);
  rmSync(cycle, { recursive: true, force: true });
}

test("T13.103 planHotApply: splicea contra el flow.json en disco (no vuelve a resolver contra el workflow global/por-repo actual)", async () => {
  // Keys DELIBERADAMENTE distintas de cualquier workflow real (planning/implementing/curl/done)
  // — si planHotApply cayera a resolveFlow() en vez de leer flow.json, NINGUNA de estas keys
  // podría aparecer en el resultado, así que su sola presencia prueba que leyó disco.
  const oldFlow = {
    stages: [
      { key: "alpha-frozen", label: "Alpha", icon: "📋" },
      { key: "bravo-frozen", label: "Bravo", icon: "⌨️", role: "impl" },
      { key: "charlie-frozen", label: "Charlie", icon: "🌐" },
      { key: "delta-frozen", label: "Delta", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const { cycle, worker } = seedLiveWorker(HOT_SESSION_A, "zz-t13-repo-a", "bravo-frozen", oldFlow);
  try {
    // El "next" (editado en el dashboard) SÓLO toca lo que viene DESPUÉS de bravo-frozen —
    // charlie-frozen se reemplaza por una etapa nueva; alpha/bravo no se tocan.
    const next = {
      stages: [
        { key: "alpha-frozen", label: "Alpha", icon: "📋" },
        { key: "bravo-frozen", label: "Bravo", icon: "⌨️", role: "impl" },
        { key: "security", label: "Security", icon: "🔒" },
        { key: "delta-frozen", label: "Delta", icon: "✓" },
      ],
      verifyAfter: null,
    };
    const ops = planHotApply(next, "zz-t13-repo-a");
    assert.equal(ops.length, 1);
    assert.equal(ops[0].workerId, worker.id);
    // El prefijo (alpha, bravo) viene INTACTO del flow congelado en disco.
    assert.deepEqual(ops[0].flow.stages.slice(0, 2).map((s) => s.key), ["alpha-frozen", "bravo-frozen"]);
    // El sufijo (todo después de bravo) es el nuevo.
    assert.deepEqual(ops[0].flow.stages.slice(2).map((s) => s.key), ["security", "delta-frozen"]);

    commitHotApply(ops);
    const onDisk = readFlow(cycle);
    assert.deepEqual(onDisk?.stages.map((s) => s.key), ["alpha-frozen", "bravo-frozen", "security", "delta-frozen"]);
    // "delta-frozen" sigue siendo la ÚLTIMA etapa del flow spliceado — liveMapFor jamás la
    // confundiría con "bravo-frozen" (la etapa ya reachada), así que reachedDone no dispara.
    assert.equal(onDisk?.stages[onDisk.stages.length - 1].key, "delta-frozen");
  } finally {
    removeLiveWorker(worker.id, cycle);
  }
});

test("T13.106 commitHotApply: no toca evidencia ni sentinels — sólo escribe flow.json", async () => {
  const oldFlow = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const { cycle, worker } = seedLiveWorker(HOT_SESSION_A, "zz-t13-repo-a", "planning", oldFlow);
  try {
    mkdirSync(evidenceDir(cycle), { recursive: true });
    writeFileSync(join(evidenceDir(cycle), "summary.md"), "evidencia real, no debe tocarse");
    const before = existsSync(join(cycle, "planning"));
    assert.equal(before, true);

    const ops = planHotApply({ stages: [...oldFlow.stages, { key: "review", label: "Review", icon: "🔎" }], verifyAfter: null }, "zz-t13-repo-a");
    commitHotApply(ops);

    assert.equal(existsSync(join(cycle, "planning")), true, "el sentinel ya escrito sigue ahí");
    assert.equal(existsSync(join(evidenceDir(cycle), "summary.md")), true, "la evidencia no se borra");
  } finally {
    removeLiveWorker(worker.id, cycle);
  }
});

test("T13.107 planHotApply/commitHotApply sobre 2 workers vivos con flows distintos: toca sólo el sufijo de CADA UNO y reescribe ambos flow.json", async () => {
  // A ya reachó "implementing" con SU PROPIA instrucción congelada; B sigue en "planning" y
  // nunca tuvo su propio "implementing" — su copia saldrá de `next`, no de un flow.json viejo.
  const flowA = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "implementing", label: "Impl", icon: "⌨️", instruction: "A-INSTRUCCION-CONGELADA" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const flowB = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const a = seedLiveWorker(HOT_SESSION_A, "zz-t13-repo-shared", "implementing", flowA); // A ya pasó implementing
  const b = seedLiveWorker(HOT_SESSION_B, "zz-t13-repo-shared", "planning", flowB); // B sigue en planning
  try {
    const next = {
      stages: [
        { key: "planning", label: "Plan", icon: "📋" },
        { key: "implementing", label: "Impl", icon: "⌨️", instruction: "INSTRUCCION-NUEVA-EDITADA" },
        { key: "security", label: "Security", icon: "🔒" }, // nueva etapa añadida
        { key: "done", label: "Done", icon: "✓" },
      ],
      verifyAfter: null,
    };
    const ops = planHotApply(next, "zz-t13-repo-shared");
    assert.equal(ops.length, 2);
    commitHotApply(ops);

    // A: preserva planning+implementing COMO OBJETOS VIEJOS (su propia instrucción congelada
    // sobrevive), luego el sufijo nuevo (security, done) que nunca tocó su prefijo.
    const onDiskA = readFlow(a.cycle);
    assert.deepEqual(onDiskA?.stages.map((s) => s.key), ["planning", "implementing", "security", "done"]);
    assert.equal(onDiskA?.stages[1].instruction, "A-INSTRUCCION-CONGELADA");

    // B: sólo preservó "planning" (su currentKey) — el resto, INCLUIDO "implementing", sale
    // entero de `next` (con la instrucción NUEVA, porque B nunca congeló la suya).
    const onDiskB = readFlow(b.cycle);
    assert.deepEqual(onDiskB?.stages.map((s) => s.key), ["planning", "implementing", "security", "done"]);
    assert.equal(onDiskB?.stages[1].instruction, "INSTRUCCION-NUEVA-EDITADA");
  } finally {
    removeLiveWorker(a.worker.id, a.cycle);
    removeLiveWorker(b.worker.id, b.cycle);
  }
});

test("T13.104-adjacent: planHotApply rechaza (STAGE_IN_FLIGHT) sin escribir NADA cuando la etapa en curso se renombra", async () => {
  const oldFlow = {
    stages: [
      { key: "planning", label: "Plan", icon: "📋" },
      { key: "implementing", label: "Impl", icon: "⌨️" },
      { key: "done", label: "Done", icon: "✓" },
    ],
    verifyAfter: null,
  };
  const { cycle, worker } = seedLiveWorker(HOT_SESSION_A, "zz-t13-repo-rename", "implementing", oldFlow);
  try {
    const renamed = {
      stages: [
        { key: "planning", label: "Plan", icon: "📋" },
        { key: "coding", label: "Coding", icon: "⌨️" }, // "implementing" renombrada
        { key: "done", label: "Done", icon: "✓" },
      ],
      verifyAfter: null,
    };
    assert.throws(() => planHotApply(renamed, "zz-t13-repo-rename"), (e: unknown) => {
      assert.ok(e instanceof StageInFlightError);
      assert.equal(e.code, "STAGE_IN_FLIGHT");
      return true;
    });
    // Nada se escribió: el flow.json en disco sigue siendo el viejo, intacto.
    assert.deepEqual(readFlow(cycle), oldFlow);
  } finally {
    removeLiveWorker(worker.id, cycle);
  }
});

// ---- D2 (bug real, hallado en review): un worker adoptado debe apuntar SIEMPRE a su
// adoptedPane congelado — nunca a worker.session (que tmux resuelve al pane ACTIVO de la
// sesión ajena, que el operador puede cambiar en cualquier momento). ----

test("D2 paneTargetFor: un worker adoptado apunta a su adoptedPane, NUNCA a session — y sin adoptedPane resuelto, undefined (nunca session)", () => {
  assert.equal(paneTargetFor({ origin: "adopted", adoptedPane: "%7", session: "cowork-foreign" }), "%7");
  // adoptedPane ausente (no debería pasar en la práctica, pero degradar visible > asumir):
  assert.equal(paneTargetFor({ origin: "adopted", session: "cowork-foreign" }), undefined);
  // los caminos NO adoptados quedan exactamente como antes (back-compat):
  assert.equal(paneTargetFor({ session: "cowork-task" }), "cowork-task");
  assert.equal(paneTargetFor({ mode: "driver", panes: { driver: "%1" } as any, session: "cowork-driver" }), "%1");
});

test("D2 (integración real): workerPane/workerInput de un worker ADOPTADO leen/escriben su adoptedPane, NUNCA el pane activo de la sesión ajena", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-e2e-d2", "/tmp");
    const paneA = (
      await pexec("tmux", ["-L", socket, "list-panes", "-t", "foreign-e2e-d2", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();
    // Split: la nueva ventana/pane B queda ACTIVA — A (el que se va a adoptar) queda de fondo.
    const paneB = (
      await pexec("tmux", ["-L", socket, "split-window", "-t", "foreign-e2e-d2", "-P", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();
    assert.notEqual(paneA, paneB);

    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-e2e-d2");
    const outcome = await adoptSession({ session: "foreign-e2e-d2", confirm: true, repo: "monorepo", paneId: paneA, expectedSessionCreatedAt });
    assert.equal(outcome.status, "created");
    const worker = snapshot().workers.find((w) => w.session === "foreign-e2e-d2")!;
    assert.equal(worker.adoptedPane, paneA);

    await pexec("tmux", ["-L", socket, "send-keys", "-t", paneA, "-l", "echo MARKER_A"], { env: envWithoutTmux() });
    await pexec("tmux", ["-L", socket, "send-keys", "-t", paneA, "Enter"], { env: envWithoutTmux() });
    await pexec("tmux", ["-L", socket, "send-keys", "-t", paneB, "-l", "echo MARKER_B"], { env: envWithoutTmux() });
    await pexec("tmux", ["-L", socket, "send-keys", "-t", paneB, "Enter"], { env: envWithoutTmux() });

    let paneResult: { hasSession: boolean; pane: string } | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      paneResult = await workerPane(worker.id);
      if (paneResult?.pane.includes("MARKER_A")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(paneResult?.pane.includes("MARKER_A"), "workerPane debe leer el pane ADOPTADO (A)");
    assert.equal(paneResult?.pane.includes("MARKER_B"), false, "workerPane NUNCA debe leer el pane activo ajeno (B)");

    const delivered = await workerInput(worker.id, "echo INPUT_MARKER");
    assert.equal(delivered, "ok");
    let sawInputInA = false;
    let sawInputInB = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const capA = (await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", paneA], { env: envWithoutTmux() })).stdout;
      const capB = (await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", paneB], { env: envWithoutTmux() })).stdout;
      sawInputInA = capA.includes("INPUT_MARKER");
      sawInputInB = capB.includes("INPUT_MARKER");
      if (sawInputInA || sawInputInB) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(sawInputInA, true, "workerInput debe escribir en el pane ADOPTADO (A)");
    assert.equal(sawInputInB, false, "workerInput NUNCA debe escribir en el pane activo ajeno (B)");

    await releaseAdoption("foreign-e2e-d2");
  });
});

test("D2 (cierre, hallado en review 2): un %N adoptado que se MUEVE a OTRA sesión (join-pane) deja de ser legible/escribible — nunca filtra I/O a la sesión ajena que ahora lo tiene", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-e2e-d2-move", "/tmp");
    const paneA = (
      await pexec("tmux", ["-L", socket, "list-panes", "-t", "foreign-e2e-d2-move", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();
    // Segundo pane en la MISMA sesión — así, al mover A fuera, la sesión (y este pane B) sigue viva.
    const paneB = (
      await pexec("tmux", ["-L", socket, "split-window", "-t", "foreign-e2e-d2-move", "-P", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();

    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-e2e-d2-move");
    const outcome = await adoptSession({ session: "foreign-e2e-d2-move", confirm: true, repo: "monorepo", paneId: paneA, expectedSessionCreatedAt });
    assert.equal(outcome.status, "created");
    const worker = snapshot().workers.find((w) => w.session === "foreign-e2e-d2-move")!;
    assert.equal(worker.adoptedPane, paneA);

    // Otra sesión REAL a la que mover el pane adoptado — simula al operador arrastrando el pane.
    await createSession("other-e2e-d2-move", "/tmp");
    await pexec("tmux", ["-L", socket, "join-pane", "-s", paneA, "-t", "other-e2e-d2-move"], { env: envWithoutTmux() });
    // A ya no está en foreign-e2e-d2-move (paneMembership → "elsewhere"), pero SIGUE vivo.
    const stillInOriginal = (
      await pexec("tmux", ["-L", socket, "list-panes", "-t", "foreign-e2e-d2-move", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim().split("\n");
    assert.equal(stillInOriginal.includes(paneA), false, "el pane debe haberse movido de verdad, fuera de la sesión original");

    await pexec("tmux", ["-L", socket, "send-keys", "-t", paneA, "-l", "echo MARKER_MOVED_A"], { env: envWithoutTmux() });
    await pexec("tmux", ["-L", socket, "send-keys", "-t", paneA, "Enter"], { env: envWithoutTmux() });

    const paneResult = await workerPane(worker.id);
    // D2 (review 3): "elsewhere" debe reportarse DISTINGUIBLE de "gone" — hasSession:true (la
    // sesión del worker sigue viva) es justo lo que lo distingue del caso "pane muerto" de abajo.
    assert.equal(paneResult?.hasSession, true);
    assert.equal(paneResult?.pane, "(no se pudo resolver ese pane: layout degradado)", "workerPane NUNCA debe leer un %N que se movió a otra sesión");

    const delivered = await workerInput(worker.id, "echo SHOULD_NEVER_ARRIVE");
    assert.equal(delivered, "elsewhere", "workerInput NUNCA debe escribir en un %N que se movió a otra sesión, y debe reportar el motivo (elsewhere)");
    await new Promise((r) => setTimeout(r, 300));
    const capMoved = (await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", paneA], { env: envWithoutTmux() })).stdout;
    assert.equal(capMoved.includes("SHOULD_NEVER_ARRIVE"), false, "el texto nunca debe haber llegado a la sesión que ahora tiene el pane");

    await releaseAdoption("foreign-e2e-d2-move").catch(() => {});
  });
});

test("D2 (review 3): un %N adoptado que MUERE (kill-pane, sesión sigue viva) reporta gone/exit — distinguible de 'elsewhere'", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-e2e-d2-gone", "/tmp");
    const paneA = (
      await pexec("tmux", ["-L", socket, "list-panes", "-t", "foreign-e2e-d2-gone", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();
    // Segundo pane en la MISMA sesión — así, al matar A, la sesión (y este pane B) sigue viva:
    // sin esto, matar el único pane mata la sesión entera y probaríamos "session-not-found",
    // no "gone" (el caso que este test necesita: pane muerto, sesión viva).
    await pexec("tmux", ["-L", socket, "split-window", "-t", "foreign-e2e-d2-gone", "-P", "-F", "#{pane_id}"], { env: envWithoutTmux() });

    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-e2e-d2-gone");
    const outcome = await adoptSession({ session: "foreign-e2e-d2-gone", confirm: true, repo: "monorepo", paneId: paneA, expectedSessionCreatedAt });
    assert.equal(outcome.status, "created");
    const worker = snapshot().workers.find((w) => w.session === "foreign-e2e-d2-gone")!;
    assert.equal(worker.adoptedPane, paneA);

    await pexec("tmux", ["-L", socket, "kill-pane", "-t", paneA], { env: envWithoutTmux() });
    // La sesión debe seguir viva (con B) — si no, este test estaría probando session-not-found.
    const remaining = (
      await pexec("tmux", ["-L", socket, "list-panes", "-t", "foreign-e2e-d2-gone", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();
    assert.notEqual(remaining, "", "la sesión debe seguir viva tras matar sólo el pane adoptado");

    const paneResult = await workerPane(worker.id);
    assert.equal(paneResult?.hasSession, false, "un pane MUERTO debe reportarse gone/exit (hasSession:false), no el layout degradado de 'elsewhere'");
    assert.match(paneResult?.pane ?? "", /gone|exit/i, "el texto debe indicar gone/exit, no el genérico de layout");

    const delivered = await workerInput(worker.id, "echo SHOULD_NEVER_ARRIVE");
    assert.equal(delivered, "gone", "workerInput debe reportar 'gone' para un pane muerto — distinto de 'elsewhere'");

    await releaseAdoption("foreign-e2e-d2-gone").catch(() => {});
  });
});
