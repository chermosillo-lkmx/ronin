import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDriverHealth,
  clearDriverHealth,
  driverHealth,
  memoTTL,
  paneTargetFor,
  resolvePaneTarget,
  stallNote,
} from "./engine.js";
import type { Worker } from "./types.js";

const PANES = { driver: "%1", worker: "%2", review: "%3", verify: "%4" };

// ---- paneTargetFor: TODA la I/O del servidor debe apuntar al pane driver, nunca al activo ----

test("paneTargetFor: modo driver → el pane DRIVER (no el activo, que el mouse puede cambiar)", () => {
  assert.equal(paneTargetFor({ mode: "driver", panes: PANES, session: "cowork-x-driver" }), "%1");
});

test("paneTargetFor: modo driver sin panes (redescubierto degradado) → cae al nombre de sesión", () => {
  assert.equal(paneTargetFor({ mode: "driver", session: "cowork-x-driver" }), "cowork-x-driver");
});

test("paneTargetFor: scripted → el nombre de sesión de siempre (sin cambio de comportamiento)", () => {
  assert.equal(paneTargetFor({ session: "cowork-x" }), "cowork-x");
  assert.equal(paneTargetFor({ mode: "scripted", session: "cowork-x" }), "cowork-x");
});

test("paneTargetFor: sin sesión → undefined", () => {
  assert.equal(paneTargetFor({}), undefined);
});

// ---- resolvePaneTarget: rol pedido por el cliente → el %N de ESE pane ----
// Deliberadamente MÁS estricta que paneTargetFor: aquí el rol viene de fuera, así que no hay
// fallback posible. Todo lo que no se pueda resolver con certeza es null → degradar visible.

test("resolvePaneTarget: cada rol resuelve a su pane id", () => {
  const w = { mode: "driver" as const, panes: PANES };
  assert.equal(resolvePaneTarget(w, "driver"), "%1");
  assert.equal(resolvePaneTarget(w, "worker"), "%2");
  assert.equal(resolvePaneTarget(w, "review"), "%3");
  assert.equal(resolvePaneTarget(w, "verify"), "%4");
});

test("resolvePaneTarget: rol desconocido → null", () => {
  const w = { mode: "driver" as const, panes: PANES };
  for (const bad of ["otro", "", "Driver", "%1", "__proto__", "constructor", "toString"]) {
    assert.equal(resolvePaneTarget(w, bad), null, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});

// LA diferencia con paneTargetFor, que en este mismo caso SÍ cae al nombre de sesión (test de
// arriba). Un `-t <session>` resuelve al pane ACTIVO, que el mouse del operador cambia: pedir el
// pane "worker" y recibir el que estuviera activo es peor que un error, porque no se nota.
test("resolvePaneTarget: layout degradado (panes ausente) → null, NUNCA el nombre de sesión", () => {
  assert.equal(resolvePaneTarget({ mode: "driver", session: "cowork-x-driver" }, "worker"), null);
});

test("resolvePaneTarget: worker scripted → null (no tiene panes por rol)", () => {
  assert.equal(resolvePaneTarget({ session: "cowork-x" }, "worker"), null);
  assert.equal(resolvePaneTarget({ mode: "scripted", panes: PANES }, "worker"), null);
});

test("resolvePaneTarget: un pane id corrupto en el registro → null (no se pasa a tmux)", () => {
  const w = { mode: "driver" as const, panes: { ...PANES, worker: "cowork-x:0.1" } };
  assert.equal(resolvePaneTarget(w, "worker"), null);
});

// ---- memoTTL: la caché de capturas por worker ----
// El TTL se prueba con un reloj inyectado en vez de timers reales: el test no debe dormir 1s.

test("memoTTL: 5 llamadas concurrentes en frío disparan UNA sola vez la función", async () => {
  // El bug que previene (cache stampede): con una caché que guarda sólo el VALOR resuelto, N
  // pestañas que abran la vista a la vez encuentran el hueco vacío y lanzan N×4 capture-pane
  // simultáneos — justo la amplificación que la caché venía a evitar.
  const cache = new Map();
  let calls = 0;
  const slow = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return "v";
  };
  const all = await Promise.all(
    Array.from({ length: 5 }, () => memoTTL(cache, "w1", 1000, slow, () => 0))
  );
  assert.equal(calls, 1, "debe memoizar la promesa EN VUELO, no sólo el valor resuelto");
  assert.deepEqual(all, ["v", "v", "v", "v", "v"]);
});

test("memoTTL: dentro del TTL reusa; pasado el TTL vuelve a llamar", async () => {
  const cache = new Map();
  let calls = 0;
  const fn = async () => ++calls;
  let now = 1000;
  assert.equal(await memoTTL(cache, "w1", 1000, fn, () => now), 1);
  now = 1999;
  assert.equal(await memoTTL(cache, "w1", 1000, fn, () => now), 1, "dentro del TTL");
  now = 2001;
  assert.equal(await memoTTL(cache, "w1", 1000, fn, () => now), 2, "vencido");
});

test("memoTTL: claves distintas no se pisan", async () => {
  const cache = new Map();
  assert.equal(await memoTTL(cache, "w1", 1000, async () => "a", () => 0), "a");
  assert.equal(await memoTTL(cache, "w2", 1000, async () => "b", () => 0), "b");
});

// Cachear un fallo dejaría la vista rota durante todo el TTL por un blip de tmux.
test("memoTTL: un rechazo no queda cacheado", async () => {
  const cache = new Map();
  let calls = 0;
  const flaky = async () => {
    if (++calls === 1) throw new Error("blip");
    return "ok";
  };
  await assert.rejects(memoTTL(cache, "w1", 1000, flaky, () => 0));
  assert.equal(await memoTTL(cache, "w1", 1000, flaky, () => 0), "ok", "el fallo no debe cachearse");
});

// ---- stallNote: señal BLANDA de etapa rancia ----

const MIN = 60_000;

test("stallNote: null antes del umbral de 15 min", () => {
  assert.equal(stallNote(5 * MIN, 4), null);
  assert.equal(stallNote(14 * MIN, 4), null);
});

test("stallNote: {minutes} pasado el umbral con el pane idle", () => {
  assert.deepEqual(stallNote(15 * MIN, 2), { minutes: 15 });
  assert.deepEqual(stallNote(93 * MIN, 9), { minutes: 93 });
});

test("stallNote: null si el pane no lleva suficientes polls idle (está trabajando)", () => {
  // Un driver ocupado resetea el progreso; no queremos marcar atasco a un pane que trabaja.
  assert.equal(stallNote(60 * MIN, 0), null);
  assert.equal(stallNote(60 * MIN, 1), null);
});

// ---- driverHealth: precedencia driverDown > parked > stalled, en un solo lugar testeable ----

const OK = {
  paneHasClaude: true,
  claudeSeen: true,
  downPolls: 0,
  parked: null,
  idlePolls: 0,
  msSinceProgress: 0,
};

test("driverHealth: ciclo sano → sin banderas ni needsInput", () => {
  const h = driverHealth(OK);
  assert.equal(h.driverDown, undefined);
  assert.equal(h.parked, undefined);
  assert.equal(h.stalled, undefined);
  assert.equal(h.needsInput, false);
});

// El latch de arranque: claude tarda segundos en pintar la TUI y sendWhenReady tolera ~17s.
// Sin esto, TODO lanzamiento driver se reportaría como caído durante el arranque.
test("driverHealth: claudeSeen=false NUNCA produce driverDown, por muchos polls que pasen", () => {
  const h = driverHealth({ ...OK, paneHasClaude: false, claudeSeen: false, downPolls: 99 });
  assert.equal(h.driverDown, undefined);
});

test("driverHealth: histéresis — 2 polls sin claude no bastan, 3 sí", () => {
  const two = driverHealth({ ...OK, paneHasClaude: false, downPolls: 2 });
  assert.equal(two.driverDown, undefined);
  const three = driverHealth({ ...OK, paneHasClaude: false, downPolls: 3 });
  assert.equal(three.driverDown, true);
  assert.equal(three.needsInput, true);
  assert.match(three.stage!, /driver caído/i);
});

test("driverHealth: driverDown se limpia solo si vuelve a aparecer claude en el pane", () => {
  const back = driverHealth({ ...OK, paneHasClaude: true, downPolls: 0 });
  assert.equal(back.driverDown, undefined);
});

test("driverHealth: parqueado por cuota → estado propio, con la hora de reset y needsInput", () => {
  const h = driverHealth({ ...OK, parked: { resetAt: "12:30am" } });
  assert.deepEqual(h.parked, { resetAt: "12:30am" });
  assert.equal(h.needsInput, true);
  assert.match(h.stage!, /parqueado/i);
  assert.match(h.stage!, /12:30am/);
});

test("driverHealth: parqueado sin hora de reset conocida sigue siendo parqueado", () => {
  const h = driverHealth({ ...OK, parked: {} });
  assert.deepEqual(h.parked, {});
  assert.match(h.stage!, /parqueado/i);
});

test("driverHealth: atasco → badge, pero SIN needsInput (es una nota, no una petición)", () => {
  const h = driverHealth({ ...OK, idlePolls: 3, msSinceProgress: 20 * MIN });
  assert.deepEqual(h.stalled, { minutes: 20 });
  assert.equal(h.needsInput, false);
  assert.equal(h.driverDown, undefined);
});

// La razón de ser de la precedencia: un driver caído TAMBIÉN se ve atascado y puede tener un
// parqueo viejo en el log. Mostrar las tres sería ruido, y las acciones son opuestas.
test("driverHealth: driverDown gana sobre parked y stalled", () => {
  const h = driverHealth({
    ...OK,
    paneHasClaude: false,
    downPolls: 5,
    parked: { resetAt: "3am" },
    idlePolls: 9,
    msSinceProgress: 60 * MIN,
  });
  assert.equal(h.driverDown, true);
  assert.equal(h.parked, undefined);
  assert.equal(h.stalled, undefined);
});

test("driverHealth: parked gana sobre stalled", () => {
  const h = driverHealth({ ...OK, parked: {}, idlePolls: 9, msSinceProgress: 60 * MIN });
  assert.deepEqual(h.parked, {});
  assert.equal(h.stalled, undefined);
});

// ---- applyDriverHealth: la contabilidad CON ESTADO (Maps + stageChanged) ----
// Aquí vivía el bug del reloj de atasco que se reseteaba en cada reinicio, así que se prueba
// la secuencia de polls, no sólo la función pura. Sin execFile: sólo cycle dir real + panes
// de mentira, igual que stages.test.ts.

const CLAUDE = "  ⏵⏵ bypass permissions on · ? for shortcuts";
const SHELL = "sh-3.2$ ";
const BUSY = "* Trabajando… (4s · esc to interrupt)";

function driverWorker(cycle: string): Worker {
  return {
    id: `w-${Math.random().toString(36).slice(2)}`,
    label: "worker #1",
    repo: "r",
    taskId: "t",
    state: "idle",
    stage: "…",
    startedAt: Date.now(),
    session: "cowork-x-driver",
    cycle,
    mode: "driver",
    panes: PANES,
  };
}

function withCycle(fn: (cycle: string, w: Worker) => void): void {
  const cycle = mkdtempSync(join(tmpdir(), "cowork-health-"));
  const w = driverWorker(cycle);
  try {
    fn(cycle, w);
  } finally {
    clearDriverHealth(w.id);
    rmSync(cycle, { recursive: true, force: true });
  }
}

test("applyDriverHealth: ignora a los workers scripted", () => {
  withCycle((cycle) => {
    const w = { ...driverWorker(cycle), mode: undefined };
    assert.equal(applyDriverHealth(w, SHELL, false), false);
    assert.equal(w.driverDown, undefined);
  });
});

test("applyDriverHealth: shell desde el arranque NO marca caído (nunca se vio claude)", () => {
  withCycle((_c, w) => {
    for (let i = 0; i < 6; i++) applyDriverHealth(w, SHELL, false);
    assert.equal(w.driverDown, undefined, "el latch de arranque debe aguantar");
  });
});

test("applyDriverHealth: tras ver claude, 3 polls en shell marcan caído (2 no)", () => {
  withCycle((_c, w) => {
    applyDriverHealth(w, CLAUDE, false);
    applyDriverHealth(w, SHELL, false);
    applyDriverHealth(w, SHELL, false);
    assert.equal(w.driverDown, undefined, "2 polls no bastan");
    applyDriverHealth(w, SHELL, false);
    assert.equal(w.driverDown, true);
    assert.equal(w.needsInput, true);
    applyDriverHealth(w, CLAUDE, false); // el operador relanzó claude en el pane
    assert.equal(w.driverDown, undefined, "debe limpiarse solo");
  });
});

// Bug real encontrado en review: una captura fallida armaba claudeSeen y reseteaba el contador.
test("applyDriverHealth: una captura fallida (null) no arma el latch ni resetea contadores", () => {
  withCycle((_c, w) => {
    for (let i = 0; i < 6; i++) applyDriverHealth(w, null, false);
    assert.equal(w.driverDown, undefined, "null nunca debe armar claudeSeen");
    // Y con claude ya visto, un blip intercalado no debe reiniciar la cuenta de caídas.
    applyDriverHealth(w, CLAUDE, false);
    applyDriverHealth(w, SHELL, false);
    applyDriverHealth(w, null, false); // blip
    applyDriverHealth(w, SHELL, false);
    applyDriverHealth(w, SHELL, false);
    assert.equal(w.driverDown, true, "el blip no debe extender la detección indefinidamente");
  });
});

test("applyDriverHealth: detecta el parqueo desde sentinels.log y lo limpia con un sentinel posterior", () => {
  withCycle((cycle, w) => {
    applyDriverHealth(w, CLAUDE, false);
    writeFileSync(join(cycle, "sentinels.log"), "===WORKER-PARKED-LIMIT:12:30am===\n");
    applyDriverHealth(w, CLAUDE, false);
    assert.deepEqual(w.parked, { resetAt: "12:30am" });
    assert.match(w.stage, /parqueado/i);
    writeFileSync(join(cycle, "sentinels.log"), "===WORKER-PARKED-LIMIT:12:30am===\n===IMPL-UPDATED===\n");
    applyDriverHealth(w, CLAUDE, false);
    assert.equal(w.parked, undefined);
  });
});

// La regresión de bug #1: en el primer poll tras redescubrir, lastProgressAt debe sembrarse del
// sentinel más reciente (viejo) y NO de "ahora" — si no, cada reinicio borra un atasco real.
test("applyDriverHealth: siembra el reloj de atasco del sentinel viejo, no de ahora", () => {
  withCycle((cycle, w) => {
    const old = Date.now() - 45 * 60_000;
    writeFileSync(join(cycle, "planning"), "");
    utimesSync(join(cycle, "planning"), new Date(old), new Date(old));
    // Primer poll tras un reinicio: idle, sin cambio de etapa (rediscovery ya sembró stageKey).
    applyDriverHealth(w, CLAUDE, false);
    applyDriverHealth(w, CLAUDE, false);
    assert.ok(w.stalled, "debe reportar el atasco heredado, no arrancar el reloj de cero");
    assert.ok(w.stalled!.minutes >= 44, `esperaba ~45m, dio ${w.stalled!.minutes}`);
  });
});

// El escenario EXACTO del bug: un poll de rediscovery que reporta stageChanged=true (porque
// stageKey venía sin sembrar). El primer poll debe ignorar stageChanged — si no, el reinicio
// borra el atasco heredado. Esta es la defensa que no depende de que rediscoverSessions acierte.
test("applyDriverHealth: el PRIMER poll ignora stageChanged (no hay observación previa)", () => {
  withCycle((cycle, w) => {
    const old = Date.now() - 45 * 60_000;
    writeFileSync(join(cycle, "planning"), "");
    utimesSync(join(cycle, "planning"), new Date(old), new Date(old));
    applyDriverHealth(w, CLAUDE, true); // primer poll, stageChanged espurio
    applyDriverHealth(w, CLAUDE, false);
    assert.ok(w.stalled, "un stageChanged espurio en el primer poll no debe borrar el atasco");
    assert.ok(w.stalled!.minutes >= 44, `esperaba ~45m, dio ${w.stalled!.minutes}`);
  });
});

test("applyDriverHealth: un avance real (etapa nueva o pane ocupado) reinicia el reloj", () => {
  withCycle((cycle, w) => {
    const old = Date.now() - 45 * 60_000;
    writeFileSync(join(cycle, "planning"), "");
    utimesSync(join(cycle, "planning"), new Date(old), new Date(old));
    applyDriverHealth(w, CLAUDE, false); // primer poll: siembra
    applyDriverHealth(w, CLAUDE, true);  // avance REAL observado
    applyDriverHealth(w, CLAUDE, false);
    assert.equal(w.stalled, undefined);
    // Y un pane ocupado cuenta como avance aunque no haya sentinel nuevo.
    applyDriverHealth(w, BUSY, false);
    assert.equal(w.stalled, undefined);
  });
});
