import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_GATE_RETRIES, selectGate, tickOnce, type DriverDeps, type GateStage } from "./verify-driver.js";
import type { VerifyState } from "./stages.js";

const STAGES: GateStage[] = [
  { key: "planning", label: "Plan" },
  { key: "implementing", label: "Impl" },
  { key: "tests", label: "Pruebas", verifyCmd: "correr-pruebas", maxRetries: 2 },
  { key: "curl", label: "Curl" },
  { key: "done", label: "Evidencia" },
];

const sinEstado = () => null;

test("selectGate: sin etapa alcanzada no hay nada que ejecutar", () => {
  assert.equal(selectGate(STAGES, null, sinEstado), null);
});

test("selectGate: una etapa anterior al gate no lo dispara", () => {
  assert.equal(selectGate(STAGES, "implementing", sinEstado), null);
});

test("selectGate: al alcanzar la etapa con verifyCmd, ése es el gate", () => {
  const gate = selectGate(STAGES, "tests", sinEstado);
  assert.deepEqual(gate, { key: "tests", cmd: "correr-pruebas", maxRetries: 2, attempts: 0 });
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
    ...over,
  };
}

test("tickOnce: corre el gate en el WORKTREE de la sesión, no en la raíz del repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    const vistos: { cmd: string; cwd: string }[] = [];
    const d = deps({ cycle: dir, run: async (cmd, cwd) => { vistos.push({ cmd, cwd }); return { ok: true, code: 0, output: "" }; } });
    const informes = await tickOnce(d, new Map());

    assert.deepEqual(vistos, [{ cmd: "correr-pruebas", cwd: "/wt" }]);
    assert.deepEqual(informes.map((i) => [i.session, i.stageKey, i.status]), [["cowork-x", "tests", "passed"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tickOnce: nunca corre mientras el worker está ocupado", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-gate-"));
  try {
    let corridas = 0;
    const d = deps({ cycle: dir, listSessions: async () => [{ name: "cowork-x", busy: true }], run: async () => { corridas++; return { ok: true, code: 0, output: "" }; } });
    assert.deepEqual(await tickOnce(d, new Map()), []);
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
    const [informe] = await tickOnce(d, new Map());

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
    const [informe] = await tickOnce(d, armado);

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
    assert.deepEqual(await tickOnce(d, new Map()), []); // ocioso, con intentos, sin armar → se salta
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
    await tickOnce(d, armado);
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
    assert.deepEqual(await tickOnce(terminal, new Map()), []);

    const ajena = deps({ cycle: dir, launchOf: () => null, run: async () => { corridas++; return { ok: true, code: 0, output: "" }; } });
    assert.deepEqual(await tickOnce(ajena, new Map()), []);
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
    assert.deepEqual(await tickOnce(d, new Map()), []);
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
    const informes = await tickOnce(d, new Map());
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
    assert.deepEqual(await tickOnce(d, new Map()), []);
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
    assert.deepEqual(await tickOnce(d, new Map()), []);
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
    const informes = await tickOnce(d, new Map());
    assert.deepEqual(informes.map((i) => i.status), ["passed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
