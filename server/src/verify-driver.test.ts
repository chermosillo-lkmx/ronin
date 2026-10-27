import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { DEFAULT_GATE_RETRIES, selectGate, startVerifyDriver, tickOnce, verdictMessage, type DriverDeps, type GateReport, type GateSlots, type GateStage } from "./verify-driver.js";
import { readVerifyState, writeVerifyState, type VerifyState } from "./stages.js";

const STAGES: GateStage[] = [
  { key: "planning", label: "Plan" },
  { key: "implementing", label: "Impl" },
  { key: "tests", label: "Pruebas", verifyCmd: "correr-pruebas", maxRetries: 2 },
  { key: "curl", label: "Curl" },
  { key: "done", label: "Evidencia" },
];

const sinEstado = () => null;

/** Los desenlaces del gate de merge llevan `at` (reloj real): se comprueba que exista y se quita. */
function sinAt<T extends { at?: number } | undefined>(state: T): Omit<NonNullable<T>, "at"> {
  assert.equal(typeof state?.at, "number");
  const { at: _at, ...resto } = state as NonNullable<T>;
  return resto;
}
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

test("selectGate: sin etapa alcanzada no hay nada que ejecutar", () => {
  assert.equal(selectGate(STAGES, null, sinEstado), null);
});

test("selectGate: una etapa anterior al gate no lo dispara", () => {
  assert.equal(selectGate(STAGES, "implementing", sinEstado), null);
});

test("selectGate: al alcanzar la etapa con verifyCmd, ése es el gate", () => {
  const gate = selectGate(STAGES, "tests", sinEstado);
  assert.deepEqual(gate, { key: "tests", cmd: "correr-pruebas", maxRetries: 2, attempts: 0, mergeGate: false });
});

test("selectGate: el gate sigue vigente aunque el worker se haya adelantado", () => {
  // El worker es autónomo: puede tocar `curl` sin esperar a nadie. El gate de `tests`
  // no se cancela por eso — se sigue debiendo.
  assert.equal(selectGate(STAGES, "curl", sinEstado)?.key, "tests");
});

test("selectGate: un gate resuelto (passed o failed) ya no se vuelve a correr", () => {
  const passed = (): VerifyState => ({ attempts: 0, status: "passed" });
  const failed = (): VerifyState => ({ attempts: 2, status: "failed" });
  assert.equal(selectGate(STAGES, "curl", passed), null);
  assert.equal(selectGate(STAGES, "curl", failed), null);
});

test("selectGate: pendiente conserva los intentos ya gastados", () => {
  const pending = (): VerifyState => ({ attempts: 1, status: "pending" });
  assert.equal(selectGate(STAGES, "tests", pending)?.attempts, 1);
});

test("selectGate: con varios gates pendientes gana el más temprano del flujo", () => {
  const dos: GateStage[] = [
    { key: "tests", label: "Pruebas", verifyCmd: "a" },
    { key: "curl", label: "Curl", verifyCmd: "b" },
  ];
  assert.equal(selectGate(dos, "curl", sinEstado)?.cmd, "a");
});

test("selectGate: sin maxRetries declarado usa el default del driver", () => {
  const sinRetries: GateStage[] = [{ key: "tests", label: "Pruebas", verifyCmd: "a" }];
  assert.equal(selectGate(sinRetries, "tests", sinEstado)?.maxRetries, DEFAULT_GATE_RETRIES);
});

// ---- tickOnce: el bucle en sí ----

/**
 * Las pruebas de veredicto: un tick con cupo de sobra que espera a que terminen sus corridas y
 * devuelve los informes. Las marcas de lanzamiento (`running: true`) no son veredicto — se filtran
 * aquí y las cubren las pruebas de concurrencia.
 */
async function tick(d: DriverDeps, armed: Map<string, boolean>): Promise<GateReport[]> {
  const informes: GateReport[] = [];
  const slots: GateSlots = { max: 99, inFlight: new Map() };
  const sinMarcas: DriverDeps = { ...d, writeState: (c, k, state) => { if (state.running !== true) d.writeState(c, k, state); } };
  await tickOnce(sinMarcas, armed, slots, (r) => void informes.push(r));
  await Promise.all([...slots.inFlight.values()]);
  return informes;
}

function deps(over: Partial<DriverDeps> & { cycle: string }): DriverDeps {
  const escrito: VerifyState[] = [];
  return {
    listSessions: async () => [{ name: "cowork-x", busy: false }],
    launchOf: () => ({ mode: "workflow", repo: "api", worktree: "/wt" }),
    flowFor: () => STAGES,
    cycleFor: () => over.cycle,
    detect: () => "tests",
    readState: () => null,
    writeState: (_c, _k, state) => void escrito.push(state),
    run: async () => ({ ok: true, code: 0, output: "verde" }),
    provisionOf: () => null,
    heads: async () => [{ repo: "api", sha: SHA_A, dirty: false }],
    cacheHit: async () => false,
    gateConfig: () => ({ timeoutMs: 45 * 60_000, env: { UNIT_GATE_REPORTS_DIR: "reports/ronin-gate" } }),
    ...over,
  };
}

test("tickOnce: corre el gate en el WORKTREE de la sesión, no en la raíz del repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const vistos: { cmd: string; cwd: string }[] = [];
    const d = deps({ cycle: dir, run: async (cmd, cwd) => { vistos.push({ cmd, cwd }); return { ok: true, code: 0, output: "" }; } });
    const informes = await tick(d, new Map());

    assert.deepEqual(vistos, [{ cmd: "correr-pruebas", cwd: "/wt" }]);
    assert.deepEqual(informes.map((i) => [i.session, i.stageKey, i.status]), [["cowork-x", "tests", "passed"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4: tickOnce pide el flow congelado usando sesión y repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-flow-"));
  try {
    const llamadas: Array<[string, string]> = [];
    const d = deps({
      cycle: dir,
      flowFor: ((session: string, repo: string) => {
        llamadas.push([session, repo]);
        return session === "cowork-x" ? STAGES : [];
      }) as DriverDeps["flowFor"],
    });
    const informes = await tick(d, new Map());

    assert.deepEqual(llamadas, [["cowork-x", "api"]]);
    assert.deepEqual(informes.map((informe) => informe.stageKey), ["tests"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: nunca corre mientras el worker está ocupado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const d = deps({ cycle: dir, listSessions: async () => [{ name: "cowork-x", busy: true }], run: async () => { corridas++; return { ok: true, code: 0, output: "" }; } });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(corridas, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: un fallo con reintentos disponibles deja el gate pendiente, no fallido", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const guardado: VerifyState[] = [];
    const d = deps({
      cycle: dir,
      run: async () => ({ ok: false, code: 1, output: "177 fallos" }),
      writeState: (_c, _k, state) => void guardado.push(state),
    });
    const [informe] = await tick(d, new Map());

    assert.equal(informe.status, "pending");
    assert.equal(informe.output, "177 fallos");
    assert.deepEqual(guardado, [{ attempts: 1, status: "pending" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: agotados los reintentos el gate queda failed y no se vuelve a intentar", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const guardado: VerifyState[] = [];
    const d = deps({
      cycle: dir,
      readState: () => ({ attempts: 1, status: "pending" }),
      run: async () => ({ ok: false, code: 1, output: "sigue rojo" }),
      writeState: (_c, _k, state) => void guardado.push(state),
    });
    const armado = new Map([["cowork-x:tests", true]]);
    const [informe] = await tick(d, armado);

    assert.equal(informe.status, "failed");
    assert.deepEqual(guardado, [{ attempts: 2, status: "failed" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: un reintento espera a estar armado — un reinicio no quema los intentos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const d = deps({
      cycle: dir,
      readState: () => ({ attempts: 1, status: "pending" }),
      run: async () => { corridas++; return { ok: true, code: 0, output: "" }; },
    });
    assert.deepEqual(await tick(d, new Map()), []); // ocioso, con intentos, sin armar → se salta
    assert.equal(corridas, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: el worker ocupado ARMA el reintento para cuando vuelva a quedar ocioso", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const armado = new Map<string, boolean>();
    const d = deps({
      cycle: dir,
      listSessions: async () => [{ name: "cowork-x", busy: true }],
      readState: () => ({ attempts: 1, status: "pending" }),
    });
    await tick(d, armado);
    assert.equal(armado.get("cowork-x:tests"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: ignora terminales normales y sesiones sin lanzamiento gestionado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const terminal = deps({ cycle: dir, launchOf: () => ({ mode: "terminal", repo: "api" }), run: async () => { corridas++; return { ok: true, code: 0, output: "" }; } });
    assert.deepEqual(await tick(terminal, new Map()), []);

    const ajena = deps({ cycle: dir, launchOf: () => null, run: async () => { corridas++; return { ok: true, code: 0, output: "" }; } });
    assert.deepEqual(await tick(ajena, new Map()), []);
    assert.equal(corridas, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: una sesión de workflow sin worktree no corre nada (no hay qué probar)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const d = deps({ cycle: dir, launchOf: () => ({ mode: "workflow", repo: "api" }), run: async () => { corridas++; return { ok: true, code: 0, output: "" }; } });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(corridas, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: un fallo del propio driver no tumba el resto de las sesiones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const d = deps({
      cycle: dir,
      listSessions: async () => [{ name: "rota", busy: false }, { name: "cowork-x", busy: false }],
      launchOf: (session) => {
        if (session === "rota") throw new Error("launch.json ilegible");
        return { mode: "workflow", repo: "api", worktree: "/wt" };
      },
    });
    const informes = await tick(d, new Map());
    assert.deepEqual(informes.map((i) => i.session), ["cowork-x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


/**
 * Provisión del entorno: mientras se instala, el worktree no tiene con qué correr las pruebas.
 * Y si la instalación falló, el gate NO debe inventar un rojo — un entorno roto es un problema de
 * setup, no un veredicto sobre el código.
 */
test("tickOnce: no corre el gate mientras el entorno se está provisionando", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const d = deps({
      cycle: dir,
      provisionOf: () => ({ status: "running", startedAt: 1 }),
      run: async () => { corridas++; return { ok: true, code: 0, output: "" }; },
    });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(corridas, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: con la provisión fallida se salta el gate y no se le toca el estado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const escrito: unknown[] = [];
    const d = deps({
      cycle: dir,
      provisionOf: () => ({ status: "failed", startedAt: 1, finishedAt: 2, output: "pip falló" }),
      run: async () => { corridas++; return { ok: false, code: 1, output: "" }; },
      writeState: (_c, _k, state) => void escrito.push(state),
    });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(corridas, 0);
    assert.deepEqual(escrito, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: con la provisión lista el gate corre normal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const d = deps({ cycle: dir, provisionOf: () => ({ status: "ok", startedAt: 1, finishedAt: 2 }) });
    const informes = await tick(d, new Map());
    assert.deepEqual(informes.map((i) => i.status), ["passed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- mergeGate: árbol limpio, caché por SHA, re-arme por commit nuevo ----

const MERGE: GateStage[] = [
  { key: "implementing", label: "Impl" },
  { key: "pre-merge", label: "Gate pre-merge", verifyCmd: "unit-gate", maxRetries: 3, mergeGate: true },
  { key: "pr", label: "PR" },
];
const limpio = (sha: string) => [{ repo: "api", sha, dirty: false }];

function mergeDeps(over: Partial<DriverDeps> & { cycle: string }): { d: DriverDeps; escrito: VerifyState[]; corridas: { cmd: string; cwd: string; opts: unknown }[] } {
  const escrito: VerifyState[] = [];
  const corridas: { cmd: string; cwd: string; opts: unknown }[] = [];
  const d = deps({
    flowFor: () => MERGE,
    detect: () => "pre-merge",
    writeState: (_c, _k, state) => void escrito.push(state),
    run: async (cmd, cwd, opts) => { corridas.push({ cmd, cwd, opts }); return { ok: true, code: 0, output: "verde" }; },
    heads: async () => limpio(SHA_A),
    ...over,
  });
  return { d, escrito, corridas };
}

test("selectGate: mergeGate failed se re-arma cuando cambia el SHA", () => {
  const failed = (): VerifyState => ({ attempts: 1, status: "failed", shas: { api: SHA_A } });
  assert.equal(selectGate(MERGE, "pr", failed, () => limpio(SHA_B))?.key, "pre-merge");
  assert.equal(selectGate(MERGE, "pr", failed, () => limpio(SHA_B))?.mergeGate, true);
});

test("selectGate: mergeGate failed con el mismo SHA no vuelve a correr", () => {
  const failed = (): VerifyState => ({ attempts: 1, status: "failed", shas: { api: SHA_A } });
  assert.equal(selectGate(MERGE, "pr", failed, () => limpio(SHA_A)), null);
});

test("selectGate: mergeGate failed sin headsFor conserva el comportamiento de antes (se salta)", () => {
  const failed = (): VerifyState => ({ attempts: 1, status: "failed", shas: { api: SHA_A } });
  assert.equal(selectGate(MERGE, "pr", failed), null);
});

test("selectGate: mergeGate failed por árbol sucio (sin shas) se re-arma en cuanto el árbol está limpio", () => {
  const sucio = (): VerifyState => ({ attempts: 0, status: "failed", reason: "hay cambios sin commitear" });
  assert.equal(selectGate(MERGE, "pr", sucio, () => limpio(SHA_A))?.key, "pre-merge");
  // Con el árbol todavía sucio no se re-arma: no hay nada nuevo que probar.
  assert.equal(selectGate(MERGE, "pr", sucio, () => [{ repo: "api", sha: SHA_A, dirty: true }]), null);
});

test("selectGate: mergeGate failed no se re-arma si los HEADs no se pueden leer", () => {
  const failed = (): VerifyState => ({ attempts: 1, status: "failed", shas: { api: SHA_A } });
  assert.equal(selectGate(MERGE, "pr", failed, () => null), null);
  assert.equal(selectGate(MERGE, "pr", failed, () => []), null);
});

test("selectGate: mergeGate con los reintentos agotados (commits distintos) queda failed aunque cambie el SHA", () => {
  const agotado = (): VerifyState => ({ attempts: 3, status: "failed", shas: { api: SHA_A } });
  assert.equal(selectGate(MERGE, "pr", agotado, () => limpio(SHA_B)), null);
});

test("selectGate: mergeGate passed se vuelve a considerar con un commit nuevo (la caché decide si corre)", () => {
  const passed = (): VerifyState => ({ attempts: 0, status: "passed", shas: { api: SHA_A } });
  assert.equal(selectGate(MERGE, "pr", passed, () => limpio(SHA_A)), null);
  assert.equal(selectGate(MERGE, "pr", passed, () => limpio(SHA_B))?.key, "pre-merge");
  assert.equal(selectGate(MERGE, "pr", passed, () => [{ repo: "api", sha: SHA_B, dirty: true }]), null);
  assert.equal(selectGate(MERGE, "pr", passed), null);
});

test("selectGate: un gate sin mergeGate failed no se re-arma aunque cambie el SHA", () => {
  const failed = (): VerifyState => ({ attempts: 2, status: "failed", shas: { api: SHA_A } });
  assert.equal(selectGate(STAGES, "curl", failed, () => limpio(SHA_B)), null);
});

test("tickOnce: mergeGate con árbol sucio: failed con reason y sin llamar a run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let cache = 0;
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      heads: async () => [{ repo: "api", sha: SHA_A, dirty: true }],
      readState: () => ({ attempts: 1, status: "pending" }),
      cacheHit: async () => { cache++; return true; },
    });
    const informes = await tick(d, new Map());
    assert.equal(corridas.length, 0);
    assert.equal(cache, 0);
    assert.deepEqual(escrito.map(sinAt), [{ status: "failed", reason: "hay cambios sin commitear", attempts: 1 }]);
    assert.deepEqual(informes.map((i) => i.status), ["failed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate sucio con SHAs de un PASS cacheado sigue siendo failed, nunca passed", async () => {
  // cacheHit ignora `dirty`: el driver tiene que mirar la suciedad ANTES de consultar la caché.
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      heads: async () => [{ repo: "api", sha: SHA_A, dirty: true }],
      readState: () => null,
      cacheHit: async () => true,
    });
    await tick(d, new Map());
    assert.equal(corridas.length, 0);
    assert.equal(escrito.length, 1);
    assert.equal(escrito[0].status, "failed");
    assert.equal(escrito[0].reason, "hay cambios sin commitear");
    assert.equal(escrito[0].shas, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate con cacheHit: passed sin llamar a run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const previo: VerifyState = { attempts: 0, status: "passed", shas: { api: SHA_A } };
    const vistos: unknown[][] = [];
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      heads: async () => limpio(SHA_B),
      readState: () => previo,
      cacheHit: async (...args) => { vistos.push(args); return true; },
    });
    const informes = await tick(d, new Map());
    assert.equal(corridas.length, 0);
    assert.deepEqual(vistos, [[previo, limpio(SHA_B), "/wt", ["e2e_dev/"]]]);
    assert.equal(escrito.length, 1);
    const { at, ...resto } = escrito[0];
    assert.equal(typeof at, "number");
    assert.deepEqual(resto, { attempts: 0, status: "passed", shas: { api: SHA_B }, durationMs: 0, reason: "caché" });
    assert.deepEqual(informes.map((i) => i.status), ["passed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate: PASS se guarda con los SHAs leídos ANTES de correr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const llamadas: string[] = [];
    const { d, escrito } = mergeDeps({
      cycle: dir,
      heads: async () => { llamadas.push("heads"); return limpio(SHA_A); },
      run: async () => { llamadas.push("run"); return { ok: true, code: 0, output: "verde" }; },
    });
    await tick(d, new Map());
    assert.equal(llamadas[0], "heads"); // la foto de HEADs se toma antes de correr
    assert.equal(escrito.length, 1);
    assert.equal(escrito[0].status, "passed");
    assert.deepEqual(escrito[0].shas, { api: SHA_A });
    assert.equal(typeof escrito[0].durationMs, "number");
    assert.equal(typeof escrito[0].at, "number");
    assert.equal(escrito[0].reason, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate: un commit durante la corrida no deja passed (ni con los SHAs viejos ni con los nuevos)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let commiteado = false;
    const { d, escrito } = mergeDeps({
      cycle: dir,
      readState: () => ({ attempts: 1, status: "pending" }),
      heads: async () => (commiteado ? limpio(SHA_B) : limpio(SHA_A)),
      run: async () => { commiteado = true; return { ok: true, code: 0, output: "verde" }; },
    });
    await tick(d, new Map());
    assert.deepEqual(escrito.map(sinAt), [{ status: "failed", reason: "el árbol cambió durante la corrida", attempts: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate: árbol limpio antes y sucio después de un PASS → no passed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corrio = false;
    const { d, escrito } = mergeDeps({
      cycle: dir,
      heads: async () => (corrio ? [{ repo: "api", sha: SHA_A, dirty: true }] : limpio(SHA_A)),
      run: async () => { corrio = true; return { ok: true, code: 0, output: "verde" }; },
    });
    await tick(d, new Map());
    assert.deepEqual(escrito.map(sinAt), [{ status: "failed", reason: "el árbol cambió durante la corrida", attempts: 0 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate: HEADs ilegibles después de un PASS → no passed", async () => {
  for (const despues of [null, []]) {
    const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
    try {
      let corrio = false;
      const { d, escrito } = mergeDeps({
        cycle: dir,
        heads: async () => (corrio ? despues : limpio(SHA_A)),
        run: async () => { corrio = true; return { ok: true, code: 0, output: "verde" }; },
      });
      await tick(d, new Map());
      assert.equal(escrito.length, 1);
      assert.equal(escrito[0].status, "failed");
      assert.equal(escrito[0].shas, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("tickOnce: mergeGate un FAIL no vuelve a leer los HEADs (sólo un PASS se re-valida)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let lecturas = 0;
    const { d, escrito } = mergeDeps({
      cycle: dir,
      heads: async () => { lecturas++; return limpio(SHA_A); },
      run: async () => ({ ok: false, code: 1, output: "rojo" }),
    });
    await tick(d, new Map());
    assert.equal(lecturas, 1);
    assert.equal(escrito[0].status, "failed");
    assert.deepEqual(escrito[0].shas, { api: SHA_A });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate heads null → failed con reason, sin gastar intento, sin run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const errores: unknown[] = [];
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      readState: () => ({ attempts: 1, status: "pending" }),
      heads: async () => null,
      logError: (e) => void errores.push(e),
    });
    const informes = await tick(d, new Map());
    assert.equal(corridas.length, 0);
    assert.deepEqual(escrito.map(sinAt), [{ status: "failed", reason: "no se pudieron leer los HEADs del worktree", attempts: 1 }]);
    assert.deepEqual(informes.map((i) => i.status), ["failed"]);
    assert.equal(errores.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate heads vacío → failed con reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito, corridas } = mergeDeps({ cycle: dir, heads: async () => [], logError: () => {} });
    await tick(d, new Map());
    assert.equal(corridas.length, 0);
    assert.deepEqual(escrito.map(sinAt), [{ status: "failed", reason: "no encontré repos con tests en el worktree", attempts: 0 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate HEADs ilegibles no repite logError ni reescribe en ticks sucesivos; legibles después → se re-arma y corre", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const errores: unknown[] = [];
    let estado: VerifyState | null = null;
    let heads: Awaited<ReturnType<DriverDeps["heads"]>> = null;
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      heads: async () => heads,
      readState: () => estado,
      writeState: (_c, _k, state) => { estado = state; escrito.push(state); },
      logError: (e) => void errores.push(e),
    });
    await tick(d, new Map());
    await tick(d, new Map());
    await tick(d, new Map());
    assert.equal(errores.length, 1);
    assert.equal(escrito.length, 1);
    assert.equal(corridas.length, 0);

    heads = limpio(SHA_A);
    await tick(d, new Map());
    assert.equal(corridas.length, 1);
    assert.equal(escrito.length, 2);
    assert.equal(escrito[1].status, "passed");
    assert.deepEqual(escrito[1].shas, { api: SHA_A });
    assert.equal(errores.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: con el worker en una etapa anterior al gate de merge no se leen HEADs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let lecturas = 0;
    const { d, corridas } = mergeDeps({ cycle: dir, detect: () => "implementing", heads: async () => { lecturas++; return limpio(SHA_A); } });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(lecturas, 0);
    assert.equal(corridas.length, 0);
    // Sin etapa alcanzada tampoco.
    const { d: d2 } = mergeDeps({ cycle: dir, detect: () => null, heads: async () => { lecturas++; return limpio(SHA_A); } });
    await tick(d2, new Map());
    assert.equal(lecturas, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate passed en A → commit B limpio no-e2e → corre → FAIL: failed, attempts+1, shas B", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      readState: () => ({ attempts: 1, status: "passed", shas: { api: SHA_A } }),
      heads: async () => limpio(SHA_B),
      cacheHit: async () => false, // el diff A→B toca código de producto
      run: async (cmd, cwd, opts) => { corridas.push({ cmd, cwd, opts }); return { ok: false, code: 1, output: "rojo" }; },
    });
    await tick(d, new Map());
    assert.equal(corridas.length, 1);
    assert.equal(escrito.length, 1);
    assert.equal(escrito[0].status, "failed");
    assert.equal(escrito[0].attempts, 2);
    assert.deepEqual(escrito[0].shas, { api: SHA_B });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate FAIL queda failed con sus SHAs y gasta un intento (maxRetries cuenta commits)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito } = mergeDeps({ cycle: dir, run: async () => ({ ok: false, code: 1, output: "rojo" }) });
    await tick(d, new Map());
    assert.equal(escrito.length, 1);
    assert.equal(escrito[0].status, "failed");
    assert.equal(escrito[0].attempts, 1);
    assert.deepEqual(escrito[0].shas, { api: SHA_A });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate failed con el mismo SHA no vuelve a correr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      readState: () => ({ attempts: 1, status: "failed", shas: { api: SHA_A } }),
    });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(corridas.length, 0);
    assert.deepEqual(escrito, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate failed se re-arma cuando cambia el SHA (sin esperar al armado en memoria)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito, corridas } = mergeDeps({
      cycle: dir,
      heads: async () => limpio(SHA_B),
      readState: () => ({ attempts: 1, status: "failed", shas: { api: SHA_A } }),
    });
    await tick(d, new Map());
    assert.equal(corridas.length, 1);
    assert.equal(escrito[0].status, "passed");
    assert.equal(escrito[0].attempts, 1);
    assert.deepEqual(escrito[0].shas, { api: SHA_B });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: mergeGate nunca corre con el worker ocupado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const { d, escrito, corridas } = mergeDeps({ cycle: dir, listSessions: async () => [{ name: "cowork-x", busy: true }] });
    assert.deepEqual(await tick(d, new Map()), []);
    assert.equal(corridas.length, 0);
    assert.deepEqual(escrito, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: run recibe timeoutMs del repo o, si falta, el global, y env con UNIT_GATE_REPORTS_DIR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const repos: string[] = [];
    const config = { timeoutMs: 90 * 60_000, env: { UNIT_GATE_REPORTS_DIR: "reports/ronin-gate", UNIT_GATE_XDIST: "4" } };
    // Merge gate y gate normal: los dos toman el timeout y el entorno de gateConfig(repo).
    for (const stages of [MERGE, STAGES]) {
      const { d, corridas } = mergeDeps({
        cycle: dir,
        flowFor: () => stages,
        detect: () => (stages === MERGE ? "pre-merge" : "tests"),
        gateConfig: (repo) => { repos.push(repo); return config; },
      });
      await tick(d, new Map());
      assert.deepEqual(corridas.map((c) => c.opts), [config]);
    }
    assert.deepEqual(repos, ["api", "api"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: un gate sin mergeGate no lee HEADs ni consulta la caché", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let git = 0;
    const d = deps({
      cycle: dir,
      heads: async () => { git++; return limpio(SHA_A); },
      cacheHit: async () => { git++; return true; },
    });
    const informes = await tick(d, new Map());
    assert.equal(git, 0);
    assert.deepEqual(informes.map((i) => i.status), ["passed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- concurrencia: un cupo global de corridas y una cola visible ----

function diferido<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Resultado = Awaited<ReturnType<DriverDeps["run"]>>;

/**
 * Varias sesiones de workflow sin disco: el estado vive en un Map por `ciclo:etapa` (el ciclo es el
 * nombre de la sesión) y cada corrida queda colgada en un diferido hasta que la prueba la suelta.
 */
function flota(over: Partial<DriverDeps> & { sesiones: string[] }) {
  const estados = new Map<string, VerifyState>();
  const escrituras: Array<[string, VerifyState]> = [];
  const corridas = new Map<string, ReturnType<typeof diferido<Resultado>>>();
  const lanzadas: string[] = [];
  const informes: GateReport[] = [];
  let sesiones = over.sesiones;
  const d = deps({
    cycle: "",
    listSessions: async () => sesiones.map((name) => ({ name, busy: false })),
    launchOf: (s) => ({ mode: "workflow", repo: "api", worktree: `/wt/${s}` }),
    cycleFor: (s) => s,
    readState: (c, k) => estados.get(`${c}:${k}`) ?? null,
    writeState: (c, k, state) => { estados.set(`${c}:${k}`, state); escrituras.push([c, state]); },
    run: (_cmd, cwd) => {
      const s = cwd.replace("/wt/", "");
      lanzadas.push(s);
      const x = diferido<Resultado>();
      corridas.set(s, x);
      return x.promise;
    },
    ...over,
  });
  const slots: GateSlots = { max: 2, inFlight: new Map() };
  return {
    d,
    slots,
    estados,
    escrituras,
    corridas,
    lanzadas,
    informes,
    estado: (s: string, k = "tests") => estados.get(`${s}:${k}`),
    setSesiones: (xs: string[]) => { sesiones = xs; },
    tick: (armed = new Map<string, boolean>()) => tickOnce(d, armed, slots, (r) => void informes.push(r)),
    /** Suelta la corrida de `s` y espera a que su desenlace quede escrito. */
    terminar: async (s: string, ok = true, k = "tests") => {
      const enVuelo = slots.inFlight.get(`${s}:${k}`);
      corridas.get(s)!.resolve({ ok, code: ok ? 0 : 1, output: ok ? "verde" : "rojo" });
      await enVuelo;
    },
  };
}

test("concurrencia: con max 2 y 3 sesiones listas, corren 2 y la tercera queda queued", async () => {
  const f = flota({ sesiones: ["s1", "s2", "s3"] });
  await f.tick(); // no espera a las corridas: vuelve con dos colgadas
  assert.deepEqual(f.lanzadas, ["s1", "s2"]);
  assert.deepEqual([...f.slots.inFlight.keys()], ["s1:tests", "s2:tests"]);
  assert.deepEqual(f.estado("s1"), { attempts: 0, status: "pending", running: true, queued: false });
  assert.deepEqual(f.estado("s2"), { attempts: 0, status: "pending", running: true, queued: false });
  assert.deepEqual(f.estado("s3"), { attempts: 0, status: "pending", queued: true });
  assert.deepEqual(f.informes, []);

  // Otro tick con los cupos llenos: nada nuevo corre y la cola no se reescribe.
  const antes = f.escrituras.length;
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "s2"]);
  assert.equal(f.escrituras.length, antes);
});

test("concurrencia: al terminar una, el siguiente tick lanza la encolada", async () => {
  const f = flota({ sesiones: ["s1", "s2", "s3"] });
  await f.tick();
  await f.terminar("s1");

  // El desenlace limpia `running` y se informa una vez, con la misma forma de siempre.
  assert.deepEqual(f.estado("s1"), { attempts: 0, status: "passed" });
  assert.deepEqual(f.informes, [{ session: "s1", stageKey: "tests", status: "passed", attempts: 0, output: "verde" }]);
  assert.equal(f.slots.inFlight.has("s1:tests"), false);

  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "s2", "s3"]);
  assert.deepEqual(f.estado("s3"), { attempts: 0, status: "pending", running: true, queued: false });
});

test("concurrencia: una sesión ya en vuelo no se lanza dos veces", async () => {
  const f = flota({ sesiones: ["s1"] });
  await f.tick();
  const antes = f.escrituras.length;
  await f.tick();
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.equal(f.escrituras.length, antes); // en vuelo: ni se relanza ni se reescribe
  assert.deepEqual(f.estado("s1"), { attempts: 0, status: "pending", running: true, queued: false });
});

test("concurrencia: el desenlace se calcula contra el estado del lanzamiento, no contra uno más nuevo", async () => {
  const f = flota({ sesiones: ["s1"] });
  await f.tick();
  // Algo reescribe el estado a media corrida: el desenlace no lo vuelve a leer ni cuenta doble.
  f.estados.set("s1:tests", { attempts: 5, status: "pending", running: true });
  await f.terminar("s1", false);
  assert.deepEqual(f.estado("s1"), { attempts: 1, status: "pending" });
  assert.deepEqual(f.informes.map((i) => [i.status, i.attempts]), [["pending", 1]]);
});

test("concurrencia: sesión que desaparece del inventario sale de la cola sin consumir cupo", async () => {
  const f = flota({ sesiones: ["s1", "s2", "s3"] });
  await f.tick();
  assert.equal(f.estado("s3")?.queued, true);

  f.setSesiones(["s1", "s2"]);
  await f.tick();
  assert.notEqual(f.estado("s3")?.queued, true); // ya no está en la cola
  assert.equal(f.estado("s3")?.running, undefined);

  // Con un cupo libre no se lanza a la desaparecida.
  await f.terminar("s1");
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "s2"]);
  assert.equal(f.slots.inFlight.size, 1);
});

test("concurrencia: una sesión que deja de ser de workflow también sale de la cola", async () => {
  let terminal = false;
  const f = flota({
    sesiones: ["s1", "s2"],
    launchOf: (s) => (s === "s2" && terminal ? { mode: "terminal", repo: "api" } : { mode: "workflow", repo: "api", worktree: `/wt/${s}` }),
  });
  f.slots.max = 1;
  await f.tick();
  assert.equal(f.estado("s2")?.queued, true);
  terminal = true;
  await f.tick();
  assert.notEqual(f.estado("s2")?.queued, true);
});

test("concurrencia: una corrida huérfana (running sin proceso) se vuelve a encolar sin gastar intento", async () => {
  // Ronin se reinició a media corrida: en disco quedó `running: true` y nadie la tiene en vuelo.
  // Aunque sea un reintento (attempts 1) no espera al armado: la corrida ya estaba autorizada.
  const f = flota({ sesiones: ["s1", "s2"] });
  f.estados.set("s1:tests", { attempts: 1, status: "pending", running: true, queued: false });
  f.estados.set("s2:tests", { attempts: 1, status: "pending", running: true, queued: false });
  f.slots.max = 1;
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.deepEqual(f.estado("s1"), { attempts: 1, status: "pending", running: true, queued: false });
  // Sin cupo, la otra huérfana queda en la cola (no "corriendo" sin proceso).
  assert.deepEqual(f.estado("s2"), { attempts: 1, status: "pending", queued: true });

  await f.terminar("s1", false);
  assert.deepEqual(f.estado("s1"), { attempts: 2, status: "failed" }); // un solo intento gastado
});

test("concurrencia: una huérfana que ya no puede correr (worker ocupado) pierde la marca running", async () => {
  const f = flota({ sesiones: ["s1"], listSessions: async () => [{ name: "s1", busy: true }] });
  f.estados.set("s1:tests", { attempts: 0, status: "pending", running: true });
  await f.tick();
  assert.deepEqual(f.lanzadas, []);
  assert.deepEqual(f.estado("s1"), { attempts: 0, status: "pending" });
});

test("concurrencia: caché y árbol sucio del gate de merge no esperan cupo", async () => {
  // Decidir no gasta cupo: sólo una corrida real lo hace.
  const f = flota({
    sesiones: ["s1", "s2", "m-cache", "m-sucio"],
    flowFor: (s) => (s.startsWith("m-") ? MERGE : STAGES),
    detect: (c) => (c.startsWith("m-") ? "pre-merge" : "tests"),
    heads: async (wt) => (wt.endsWith("sucio") ? [{ repo: "api", sha: SHA_A, dirty: true }] : limpio(SHA_A)),
    cacheHit: async () => true,
  });
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "s2"]);
  assert.equal(f.estado("m-cache", "pre-merge")?.status, "passed");
  assert.equal(f.estado("m-cache", "pre-merge")?.queued, undefined);
  assert.equal(f.estado("m-sucio", "pre-merge")?.status, "failed");
  assert.equal(f.estado("m-sucio", "pre-merge")?.queued, undefined);
  assert.deepEqual(f.informes.map((i) => i.session).sort(), ["m-cache", "m-sucio"]);
});

test("concurrencia: gate de merge y gate normal comparten el mismo cupo; el merge re-valida HEADs al terminar", async () => {
  let commiteado = false;
  const f = flota({
    sesiones: ["s1", "m1"],
    flowFor: (s) => (s.startsWith("m") ? MERGE : STAGES),
    detect: (c) => (c.startsWith("m") ? "pre-merge" : "tests"),
    heads: async () => (commiteado ? limpio(SHA_B) : limpio(SHA_A)),
  });
  f.slots.max = 1;
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.equal(f.estado("m1", "pre-merge")?.queued, true);

  await f.terminar("s1");
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "m1"]);
  commiteado = true; // un commit a media corrida
  await f.terminar("m1", true, "pre-merge");
  assert.deepEqual(sinAt(f.estado("m1", "pre-merge")), { status: "failed", reason: "el árbol cambió durante la corrida", attempts: 0 });
});

test("concurrencia: un run que lanza no tumba el driver, se registra y libera el cupo", async () => {
  const errores: unknown[] = [];
  const f = flota({ sesiones: ["s1"], run: async () => { throw new Error("spawn falló"); }, logError: (e) => void errores.push(e) });
  await f.tick();
  await Promise.all([...f.slots.inFlight.values()]);
  assert.equal(f.slots.inFlight.size, 0);
  assert.equal(errores.length, 1);
  assert.equal(f.estado("s1")?.running, undefined);
  assert.deepEqual(f.informes, []);
});

test("startVerifyDriver: el cupo se lee en cada tick (maxConcurrent sin reiniciar)", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let max = 1;
    const f = flota({ sesiones: ["s1", "s2", "s3"], maxConcurrent: () => max });
    const handle = startVerifyDriver(f.d, 1000);
    // Drena hasta que el tick termine (las tres sesiones decididas), con tope: no depende de
    // cuántos `await` tenga el tick.
    const hasta = async (listo: () => boolean) => {
      for (let i = 0; i < 1000 && !listo(); i++) await new Promise((r) => setImmediate(r));
      assert.ok(listo(), "el tick no terminó");
    };
    mock.timers.tick(1000);
    await hasta(() => f.estado("s3")?.queued === true);
    assert.deepEqual(f.lanzadas, ["s1"]);
    max = 3;
    mock.timers.tick(1000);
    await hasta(() => f.lanzadas.length === 3);
    assert.deepEqual(f.lanzadas, ["s1", "s2", "s3"]);
    handle.stop();
  } finally {
    mock.timers.reset();
  }
});

test("concurrencia: un gate de merge passed que sale de la cola sin correr queda como estaba", async () => {
  let ocupado = false;
  const f = flota({
    sesiones: ["s1", "m1"],
    listSessions: async () => [{ name: "s1", busy: false }, { name: "m1", busy: ocupado }],
    flowFor: (s) => (s.startsWith("m") ? MERGE : STAGES),
    detect: (c) => (c.startsWith("m") ? "pre-merge" : "tests"),
    heads: async () => limpio(SHA_B),
  });
  const passedA: VerifyState = { attempts: 0, status: "passed", shas: { api: SHA_A }, durationMs: 5, at: 1 };
  f.estados.set("m1:pre-merge", passedA);
  f.slots.max = 1;
  await f.tick();
  assert.deepEqual(f.estado("m1", "pre-merge"), { ...passedA, queued: true });
  ocupado = true;
  await f.tick();
  assert.deepEqual(f.estado("m1", "pre-merge"), passedA);
});

test("concurrencia: una huérfana encolada conserva su autorización y corre en cuanto hay cupo", async () => {
  const f = flota({ sesiones: ["s1", "s2"] });
  f.estados.set("s1:tests", { attempts: 1, status: "pending", running: true });
  f.estados.set("s2:tests", { attempts: 1, status: "pending", running: true });
  f.slots.max = 1;
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.equal(f.estado("s2")?.queued, true);
  await f.terminar("s1");
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "s2"]);
});

test("concurrencia: un reintento armado que espera en la cola corre en cuanto hay cupo, también tras un reinicio", async () => {
  const f = flota({ sesiones: ["s1", "s2"] });
  f.estados.set("s2:tests", { attempts: 1, status: "pending" });
  f.slots.max = 1;
  await f.tick(new Map([["s2:tests", true]]));
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.equal(f.estado("s2")?.queued, true);
  await f.terminar("s1");
  // Armado en memoria vacío (como tras un reinicio): `queued` en disco basta.
  await f.tick(new Map());
  assert.deepEqual(f.lanzadas, ["s1", "s2"]);
});

test("concurrencia: dos gates de la misma sesión nunca corren a la vez en el mismo worktree", async () => {
  // B (normal) corre; mientras, el gate de merge A, más temprano en el flujo, se re-arma por un
  // commit nuevo. A no se lanza hasta que B termine.
  const FLUJO: GateStage[] = [
    { key: "pre-merge", label: "Gate", verifyCmd: "unit-gate", mergeGate: true },
    { key: "tests", label: "Pruebas", verifyCmd: "correr-pruebas" },
  ];
  let heads = limpio(SHA_A);
  const f = flota({ sesiones: ["s1"], flowFor: () => FLUJO, detect: () => "tests", heads: async () => heads });
  f.estados.set("s1:pre-merge", { attempts: 0, status: "passed", shas: { api: SHA_A } });
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.ok(f.slots.inFlight.has("s1:tests"));

  heads = limpio(SHA_B);
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1"]);
  assert.equal(f.estado("s1", "pre-merge")?.running, undefined);

  await f.terminar("s1");
  await f.tick();
  assert.deepEqual(f.lanzadas, ["s1", "s1"]);
  assert.ok(f.slots.inFlight.has("s1:pre-merge"));
});

test("concurrencia: un logError que lanza en el rechazo de una corrida no deja una promesa rechazada", async () => {
  const f = flota({ sesiones: ["s1"], run: async () => { throw new Error("spawn falló"); }, logError: () => { throw new Error("log roto"); } });
  await f.tick();
  const enVuelo = [...f.slots.inFlight.values()];
  assert.equal(enVuelo.length, 1);
  await enVuelo[0]; // rechazaría si el error del log se escapara
  assert.equal(f.slots.inFlight.size, 0);
});

// ---- Task 7: Ronin le entrega al worker el veredicto del gate de merge ----

test("verdictMessage PASS: sha corto del primer sub-repo, minutos y la etapa siguiente", () => {
  const state: VerifyState = { attempts: 0, status: "passed", shas: { api: SHA_A, web: SHA_B }, durationMs: 4 * 60_000 + 10_000, at: 1 };
  assert.equal(verdictMessage("pre-merge", state, "/ciclo", "pr"), "UNIT-GATE: PASS (aaaaaaa, 4 min) — continúa con pr");
});

test("verdictMessage PASS por caché: dice (caché) en lugar de la duración", () => {
  const state: VerifyState = { attempts: 0, status: "passed", shas: { api: SHA_B }, durationMs: 0, at: 1, reason: "caché" };
  assert.equal(verdictMessage("pre-merge", state, "/ciclo", "pr"), "UNIT-GATE: PASS (bbbbbbb, caché) — continúa con pr");
});

test("verdictMessage PASS sin etapa siguiente: continúa con la siguiente etapa", () => {
  const state: VerifyState = { attempts: 0, status: "passed", shas: { api: SHA_A }, durationMs: 20_000, at: 1 };
  assert.equal(verdictMessage("pre-merge", state, "/ciclo", null), "UNIT-GATE: PASS (aaaaaaa, 1 min) — continúa con la siguiente etapa");
});

test("verdictMessage FAIL con reason: apunta al verify json del ciclo y al log del gate", () => {
  const state: VerifyState = { attempts: 0, status: "failed", reason: "hay cambios sin commitear" };
  assert.equal(
    verdictMessage("pre-merge", state, "/ciclo", "pr", "/wt"),
    "UNIT-GATE: FAIL — hay cambios sin commitear — lee /ciclo/verify-pre-merge.json y unit-gate.log en /wt/<sub-repo>/reports/ronin-gate/; arregla con tests dirigidos, commitea y vuelve a tocar el sentinela",
  );
});

test("verdictMessage FAIL sin reason: sin el tramo de la razón", () => {
  const state: VerifyState = { attempts: 1, status: "failed", shas: { api: SHA_A } };
  assert.equal(
    verdictMessage("pre-merge", state, "/ciclo", "pr", "/wt"),
    "UNIT-GATE: FAIL — lee /ciclo/verify-pre-merge.json y unit-gate.log en /wt/<sub-repo>/reports/ronin-gate/; arregla con tests dirigidos, commitea y vuelve a tocar el sentinela",
  );
});

/**
 * Una sesión con gate de merge y estado en memoria. `notify` responde con lo que diga `entrega`
 * (true, false o lanzar). `tick` espera corridas Y entregas: así las pruebas no duermen.
 */
function avisos(over: Partial<DriverDeps> & { entrega?: () => Promise<boolean>; cycle?: string } = {}) {
  let estado: VerifyState | null = null;
  const escritos: VerifyState[] = [];
  const mensajes: Array<[string, string]> = [];
  const { entrega = async () => true, ...resto } = over;
  const { d, corridas } = mergeDeps({
    cycle: "/ciclo",
    readState: () => estado,
    writeState: (_c, _k, state) => { estado = state; escritos.push(state); },
    notify: (session, text) => { mensajes.push([session, text]); return entrega(); },
    ...resto,
  });
  const slots: GateSlots = { max: 99, inFlight: new Map() };
  return {
    d,
    slots,
    escritos,
    mensajes,
    corridas,
    estado: () => estado,
    setEstado: (s: VerifyState | null) => { estado = s; },
    tick: async () => {
      await tickOnce(d, new Map(), slots);
      await Promise.all([...slots.inFlight.values()]);
      await Promise.all([...(slots.entregas ?? [])]);
    },
  };
}

test("notify: mergeGate passed → notify se llama una vez y el estado queda notify:\"sent\"", async () => {
  const a = avisos();
  await a.tick();
  assert.equal(a.mensajes.length, 1);
  assert.equal(a.mensajes[0][0], "cowork-x");
  assert.match(a.mensajes[0][1], /^UNIT-GATE: PASS \(aaaaaaa, \d+ min\) — continúa con pr$/);
  assert.equal(a.estado()?.status, "passed");
  assert.equal(a.estado()?.notify, "sent");
});

test("notify: un segundo tick no vuelve a notificar", async () => {
  const a = avisos();
  await a.tick();
  await a.tick();
  await a.tick();
  assert.equal(a.corridas.length, 1);
  assert.equal(a.mensajes.length, 1);
});

test("notify: entrega fallida → notify:\"failed\" y no se reintenta en el siguiente tick", async () => {
  const a = avisos({ entrega: async () => false });
  await a.tick();
  assert.equal(a.estado()?.notify, "failed");
  await a.tick();
  assert.equal(a.mensajes.length, 1);
  assert.equal(a.estado()?.notify, "failed");
});

test("notify: una entrega que lanza cuenta como fallida y nunca sale del tick", async () => {
  const a = avisos({ entrega: async () => { throw new Error("tmux murió"); }, logError: () => {} });
  await a.tick();
  assert.equal(a.estado()?.notify, "failed");
});

test("notify: un notify que lanza de forma síncrona también cuenta como fallido", async () => {
  const a = avisos({ entrega: () => { throw new Error("síncrono"); }, logError: () => {} });
  await a.tick();
  assert.equal(a.estado()?.notify, "failed");
});

test("notify: la entrega no bloquea el tick (el desenlace queda escrito antes de que se entregue)", async () => {
  const x = diferido<boolean>();
  const a = avisos({ entrega: () => x.promise, cacheHit: async () => true });
  await tickOnce(a.d, new Map(), a.slots); // si esperara la entrega, esto no volvería nunca
  assert.equal(a.estado()?.status, "passed");
  assert.equal(a.estado()?.notify, undefined);
  x.resolve(true);
  await Promise.all([...(a.slots.entregas ?? [])]);
  assert.equal(a.estado()?.notify, "sent");
});

test("notify: PASS por caché, árbol sucio y FAIL de corrida notifican con su texto", async () => {
  const cache = avisos({ cacheHit: async () => true });
  await cache.tick();
  assert.deepEqual(cache.mensajes.map(([, t]) => t), ["UNIT-GATE: PASS (aaaaaaa, caché) — continúa con pr"]);

  const sucio = avisos({ heads: async () => [{ repo: "api", sha: SHA_A, dirty: true }] });
  await sucio.tick();
  await sucio.tick();
  assert.equal(sucio.mensajes.length, 1);
  assert.match(sucio.mensajes[0][1], /^UNIT-GATE: FAIL — hay cambios sin commitear — lee \/ciclo\/verify-pre-merge\.json/);
  assert.equal(sucio.estado()?.notify, "sent");

  const rojo = avisos({ run: async () => ({ ok: false, code: 1, output: "rojo" }) });
  await rojo.tick();
  await rojo.tick();
  assert.equal(rojo.mensajes.length, 1);
  assert.match(rojo.mensajes[0][1], /^UNIT-GATE: FAIL — lee \/ciclo\/verify-pre-merge\.json y unit-gate\.log en \/wt\//);
});

test("notify: HEADs ilegibles avisan una sola vez aunque pasen varios ticks", async () => {
  const a = avisos({ heads: async () => null, logError: () => {} });
  await a.tick();
  await a.tick();
  await a.tick();
  assert.equal(a.mensajes.length, 1);
  assert.match(a.mensajes[0][1], /^UNIT-GATE: FAIL — no se pudieron leer los HEADs del worktree — /);
});

test("notify: el árbol cambió durante la corrida → se avisa el FAIL", async () => {
  let n = 0;
  const a = avisos({ heads: async () => (n++ === 0 ? limpio(SHA_A) : limpio(SHA_B)) });
  await a.tick();
  assert.equal(a.mensajes.length, 1);
  assert.match(a.mensajes[0][1], /^UNIT-GATE: FAIL — el árbol cambió durante la corrida — /);
});

test("notify: un desenlace nuevo tras re-armar (SHA nuevo) vuelve a notificar", async () => {
  let heads = limpio(SHA_A);
  let corridas = 0;
  const a = avisos({ heads: async () => heads, run: async () => { corridas++; return { ok: false, code: 1, output: "rojo" }; } });
  await a.tick();
  heads = limpio(SHA_B);
  await a.tick();
  assert.equal(corridas, 2);
  assert.equal(a.mensajes.length, 2);
  assert.deepEqual(a.estado()?.shas, { api: SHA_B });
  assert.equal(a.estado()?.notify, "sent");
});

test("notify: una entrega que llega tarde no marca un desenlace más nuevo", async () => {
  const x = diferido<boolean>();
  const a = avisos({ entrega: () => x.promise, cacheHit: async () => true });
  await tickOnce(a.d, new Map(), a.slots);
  // Mientras la entrega espera, el gate se re-arma y escribe otro desenlace.
  a.setEstado({ attempts: 1, status: "failed", shas: { api: SHA_B }, at: 99 });
  x.resolve(true);
  await Promise.all([...(a.slots.entregas ?? [])]);
  assert.equal(a.estado()?.notify, undefined);
});

test("notify: gate sin mergeGate no notifica", async () => {
  const mensajes: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const d = deps({ cycle: dir, notify: async (_s, t) => { mensajes.push(t); return true; } });
    const slots: GateSlots = { max: 99, inFlight: new Map() };
    await tickOnce(d, new Map(), slots);
    await Promise.all([...slots.inFlight.values()]);
    await Promise.all([...(slots.entregas ?? [])]);
    assert.deepEqual(mensajes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notify: con el estado real en disco (otro orden de claves al releer) también queda marcado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-notify-"));
  try {
    const a = avisos({
      cycle: dir,
      readState: readVerifyState,
      writeState: writeVerifyState,
      heads: async () => [{ repo: "api", sha: SHA_A, dirty: true }],
    });
    await a.tick();
    assert.equal(a.mensajes.length, 1);
    assert.equal(readVerifyState(dir, "pre-merge")?.notify, "sent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Task 7, ronda 1: entregas perdidas por reinicio ----

test("notify: un desenlace viejo sin notify (entrega perdida en un reinicio) queda notify:\"failed\" sin reenviar", async () => {
  const a = avisos({ now: () => 10 * 60_000 + 1_000 });
  a.setEstado({ attempts: 0, status: "passed", shas: { api: SHA_A }, durationMs: 5, at: 1_000 });
  await a.tick();
  assert.equal(a.mensajes.length, 0);
  assert.equal(a.estado()?.notify, "failed");
  assert.equal(a.estado()?.status, "passed");
  await a.tick();
  assert.equal(a.escritos.length, 1); // se marca una sola vez
});

test("notify: un desenlace reciente sin notify no se marca (su entrega puede seguir en curso en otro proceso)", async () => {
  const a = avisos({ now: () => 30_000 });
  a.setEstado({ attempts: 0, status: "passed", shas: { api: SHA_A }, durationMs: 5, at: 1_000 });
  await a.tick();
  assert.equal(a.estado()?.notify, undefined);
  assert.equal(a.escritos.length, 0);
});

test("notify: una entrega en curso en este proceso no se da por perdida aunque pase el plazo", async () => {
  const x = diferido<boolean>();
  let ahora = Date.now();
  const a = avisos({ entrega: () => x.promise, cacheHit: async () => true, now: () => ahora });
  await tickOnce(a.d, new Map(), a.slots);
  ahora += 60 * 60_000;
  await tickOnce(a.d, new Map(), a.slots);
  assert.equal(a.estado()?.notify, undefined);
  x.resolve(true);
  await Promise.all([...(a.slots.entregas ?? [])]);
  assert.equal(a.estado()?.notify, "sent");
});

test("notify: los desenlaces sin corrida (sucio, HEADs ilegibles, árbol cambiado) también llevan `at`", async () => {
  const sucio = avisos({ heads: async () => [{ repo: "api", sha: SHA_A, dirty: true }] });
  await sucio.tick();
  assert.equal(typeof sucio.estado()?.at, "number");
  const ilegible = avisos({ heads: async () => null, logError: () => {} });
  await ilegible.tick();
  assert.equal(typeof ilegible.estado()?.at, "number");
  let n = 0;
  const cambiado = avisos({ heads: async () => (n++ === 0 ? limpio(SHA_A) : limpio(SHA_B)) });
  await cambiado.tick();
  assert.equal(cambiado.estado()?.reason, "el árbol cambió durante la corrida");
  assert.equal(typeof cambiado.estado()?.at, "number");
});

test("notify: un gate normal viejo sin notify no se marca (sólo el de merge avisa)", async () => {
  const escritos: VerifyState[] = [];
  const d = deps({
    cycle: "/c",
    detect: () => "curl",
    now: () => 10 ** 9,
    readState: () => ({ attempts: 0, status: "passed", at: 1 }),
    writeState: (_c, _k, s) => void escritos.push(s),
  });
  await tickOnce(d, new Map(), { max: 99, inFlight: new Map() });
  assert.deepEqual(escritos, []);
});
