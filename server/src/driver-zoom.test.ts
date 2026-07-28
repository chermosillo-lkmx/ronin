import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseZoomState, serializePerSession, zoomOutcome, zoomPlan, type ZoomOutcome } from "./tmux.js";
import { attachWorker, focusPane, type FocusDeps } from "./engine.js";
import { workers } from "./state.js";
import type { Worker } from "./types.js";

// Todo lo de este archivo se verificó EN VIVO contra tmux 3.6a antes de escribirse: las tres
// regresiones de zoomPlan son comportamientos reales de tmux, no suposiciones sobre el manual.

const DRIVER = "%1";
const WORKER = "%2";

// ---- parseZoomState: salida de `display-message -p '#{window_zoomed_flag} #{pane_id}'` ----

test("parseZoomState: parsea el flag y el pane activo", () => {
  assert.deepEqual(parseZoomState("1 %12\n"), { zoomed: true, active: "%12" });
  assert.deepEqual(parseZoomState("0 %3"), { zoomed: false, active: "%3" });
});

test("parseZoomState: tolera espacios múltiples y saltos alrededor", () => {
  assert.deepEqual(parseZoomState("  1   %130  \n"), { zoomed: true, active: "%130" });
});

// Mismo criterio que parsePaneId: preferimos no concluir nada a inventar un target al que después
// le mandaríamos comandos de layout.
test("parseZoomState: null cuando la salida no es reconocible (nunca inventa un %N)", () => {
  for (const bad of ["", "   ", "1", "%3", "1 12", "1 %", "x %3", "2 %1", "-1 %1", "1 %1 extra"]) {
    assert.equal(parseZoomState(bad), null, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});

// ---- zoomPlan: la máquina de estados del zoom ----

// REGRESIÓN VERIFICADA EN VIVO: `select-pane -t %N -Z` NO crea el zoom — sólo lo CONSERVA si ya
// existía ("-Z keeps the window zoomed if it was zoomed"). Con sólo ese comando, pedir foco sobre
// una ventana sin zoom no hacía absolutamente nada visible.
test("zoomPlan: sin zoom previo → select-pane -Z Y ADEMÁS resize-pane -Z", () => {
  const plan = zoomPlan({ zoomed: false, active: DRIVER }, WORKER, DRIVER);
  assert.deepEqual(plan, [
    ["select-pane", "-t", WORKER, "-Z"],
    ["resize-pane", "-Z", "-t", WORKER],
  ]);
});

// REGRESIÓN VERIFICADA EN VIVO: `-Z` es un TOGGLE, no un "zoomea esto". Con la ventana ya zoomeada,
// añadir `resize-pane -Z` DES-zoomearía justo cuando el usuario pidió mover el foco a otro pane.
test("zoomPlan: con zoom activo en otro pane → SÓLO select-pane -Z (el zoom sigue al activo)", () => {
  const plan = zoomPlan({ zoomed: true, active: DRIVER }, WORKER, DRIVER);
  assert.deepEqual(plan, [["select-pane", "-t", WORKER, "-Z"]]);
});

test("zoomPlan: con zoom → volver a los 4 panes des-zoomea y restaura el driver como activo", () => {
  // `select-pane` SIN -Z sobre una ventana zoomeada hace las dos cosas de un golpe (verificado).
  // Restaurar el driver importa: si el activo quedara en el pane zoomeado, todo `-t <session>` del
  // server escribiría en el pane equivocado (el motivo de paneTargetFor).
  const plan = zoomPlan({ zoomed: true, active: WORKER }, null, DRIVER);
  assert.deepEqual(plan, [["select-pane", "-t", DRIVER]]);
});

// El botón "↩ ver los 4 panes" se pulsa también cuando nadie zoomeó nada. Emitir un select-pane
// ahí movería el pane activo COMPARTIDO de todos los clientes attachados y le robaría el foco al
// operador que hubiera clickeado otro pane con el mouse — lo contrario de "sin efectos".
test("zoomPlan: sin zoom + volver a los 4 panes → CERO comandos (no hay nada que deshacer)", () => {
  assert.deepEqual(zoomPlan({ zoomed: false, active: WORKER }, null, DRIVER), []);
  assert.deepEqual(zoomPlan({ zoomed: false, active: DRIVER }, null, DRIVER), []);
});

// La UI pollea cada 1.5s; sin idempotencia re-aplicaría comandos de layout indefinidamente.
test("zoomPlan: el pane pedido ya está zoomeado y activo → CERO comandos (idempotente)", () => {
  assert.deepEqual(zoomPlan({ zoomed: true, active: WORKER }, WORKER, DRIVER), []);
});

// La regla explícita del repo (README "los targets son pane ids %N, no índices"): tmux renumera
// los índices al morir un pane y acabaríamos aplicando layout al pane equivocado sin error visible.
test("zoomPlan: TODOS los targets emitidos son pane ids %N, nunca índices ni nombres de sesión", () => {
  const states = [
    { zoomed: false, active: DRIVER },
    { zoomed: true, active: DRIVER },
    { zoomed: true, active: WORKER },
  ];
  for (const state of states) {
    for (const target of [WORKER, "%9", null]) {
      for (const args of zoomPlan(state, target, DRIVER)) {
        const at = args.indexOf("-t");
        assert.notEqual(at, -1, `sin -t: ${args.join(" ")}`);
        assert.match(args[at + 1], /^%\d+$/, `target no es %N: ${args.join(" ")}`);
      }
    }
  }
});

// ---- zoomOutcome: "mandé los comandos" NO es "el zoom quedó donde dije" ----

const PLAN = [["select-pane", "-t", WORKER, "-Z"]];

test("zoomOutcome: plan vacío → noop", () => {
  assert.equal(zoomOutcome([], { zoomed: false, active: DRIVER }, null), "noop");
});

test("zoomOutcome: ok cuando el estado releído coincide con lo pedido", () => {
  assert.equal(zoomOutcome(PLAN, { zoomed: true, active: WORKER }, WORKER), "ok");
  assert.equal(zoomOutcome(PLAN, { zoomed: false, active: DRIVER }, null), "ok");
});

// El caso que motiva la verificación: `select-pane -Z` sale bien y `resize-pane -Z` falla. Sin
// releer el estado, el server reportaría éxito con la ventana a medio aplicar.
test("zoomOutcome: mismatch si quedó sin zoom cuando se pidió zoom (plan aplicado a medias)", () => {
  assert.equal(zoomOutcome(PLAN, { zoomed: false, active: WORKER }, WORKER), "mismatch");
});

test("zoomOutcome: mismatch si el zoom quedó en OTRO pane que el pedido", () => {
  assert.equal(zoomOutcome(PLAN, { zoomed: true, active: DRIVER }, WORKER), "mismatch");
});

test("zoomOutcome: mismatch si quedó zoom cuando se pidió volver a los 4 panes", () => {
  assert.equal(zoomOutcome(PLAN, { zoomed: true, active: WORKER }, null), "mismatch");
});

// No poder confirmar NO es confirmar: una relectura fallida nunca debe reportarse como éxito.
test("zoomOutcome: mismatch si no se pudo releer el estado (null)", () => {
  assert.equal(zoomOutcome(PLAN, null, WORKER), "mismatch");
});

// ---- serializePerSession: exclusión mutua del read-modify-write del zoom ----

/** Op instrumentada: registra cuándo entra y cuándo sale para detectar intercalados. */
function op(log: string[], name: string, ms: number): () => Promise<string> {
  return async () => {
    log.push(`${name}-in`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name}-out`);
    return name;
  };
}

// El bug que previene: dos POST /focus concurrentes leen ambos zoomed:false y ambos emiten
// resize-pane -Z → el segundo DES-zoomea lo que el primero acababa de zoomear.
test("serializePerSession: dos ops sobre la misma sesión NO se intercalan", async () => {
  const log: string[] = [];
  await Promise.all([
    serializePerSession("s", op(log, "a", 25)),
    serializePerSession("s", op(log, "b", 1)),
  ]);
  assert.deepEqual(log, ["a-in", "a-out", "b-in", "b-out"]);
});

test("serializePerSession: sesiones distintas SÍ corren en paralelo (no es un lock global)", async () => {
  const log: string[] = [];
  await Promise.all([
    serializePerSession("s1", op(log, "a", 25)),
    serializePerSession("s2", op(log, "b", 1)),
  ]);
  assert.deepEqual(log, ["a-in", "b-in", "b-out", "a-out"]);
});

test("serializePerSession: devuelve el valor de cada op", async () => {
  assert.equal(await serializePerSession("s", async () => 42), 42);
});

// Sin el .catch() interno, una op que lanza dejaría la cadena rechazada y TODA operación futura
// sobre esa sesión fallaría — el zoom quedaría muerto hasta reiniciar el server.
test("serializePerSession: una op que lanza no envenena la cola de esa sesión", async () => {
  await assert.rejects(
    serializePerSession("s", async () => {
      throw new Error("boom");
    })
  );
  assert.equal(await serializePerSession("s", async () => "sigue viva"), "sigue viva");
});

// ---- focusPane / attachWorker: la garantía de "no abras nada si el zoom no se confirmó" ----
// Sin mocking framework: FocusDeps es una costura con default, igual que el `now` de memoTTL.

const PANES = { driver: "%1", worker: "%2", review: "%3", verify: "%4" };

/** Registra qué se llamó, para poder afirmar sobre lo que NO se llamó. */
function spyDeps(outcome: ZoomOutcome): FocusDeps & { zoomed: unknown[][]; opened: string[] } {
  const zoomed: unknown[][] = [];
  const opened: string[] = [];
  return {
    zoomed,
    opened,
    zoom: async (session, target, driverPane) => {
      zoomed.push([session, target, driverPane]);
      return outcome;
    },
    terminal: async (session) => {
      opened.push(session);
    },
  };
}

/** Inyecta un worker driver en el store vivo y lo saca al terminar (no hay API de test). */
function withWorker(w: Partial<Worker>, fn: (id: string) => Promise<void>): Promise<void> {
  const id = `w-zoom-${Math.random().toString(36).slice(2)}`;
  workers.push({
    id,
    label: "worker #1",
    repo: "r",
    taskId: "t",
    state: "idle",
    stage: "…",
    startedAt: Date.now(),
    session: "cowork-x-driver",
    mode: "driver",
    panes: PANES,
    ...w,
  } as Worker);
  return fn(id).finally(() => {
    const i = workers.findIndex((x) => x.id === id);
    if (i >= 0) workers.splice(i, 1);
  });
}

test("focusPane: resuelve el rol a su %N y devuelve el outcome de tmux", async () => {
  await withWorker({}, async (id) => {
    const deps = spyDeps("ok");
    assert.equal(await focusPane(id, "worker", deps), "ok");
    assert.deepEqual(deps.zoomed, [["cowork-x-driver", "%2", "%1"]]);
  });
});

test("focusPane: role null → target null (volver a los 4 panes), con el driver como referencia", async () => {
  await withWorker({}, async (id) => {
    const deps = spyDeps("noop");
    assert.equal(await focusPane(id, null, deps), "noop");
    assert.deepEqual(deps.zoomed, [["cowork-x-driver", null, "%1"]]);
  });
});

test("focusPane: un outcome fallido de tmux se colapsa a tmux-failed (no a un éxito)", async () => {
  for (const bad of ["unreadable", "failed", "mismatch"] as const) {
    await withWorker({}, async (id) => {
      assert.equal(await focusPane(id, "worker", spyDeps(bad)), "tmux-failed");
    });
  }
});

// Degradado ≠ "no hay sesión": la sesión existe, lo que falta son los roles. Colapsarlos mandaría
// al operador a buscar el problema donde no está (por eso el 409 y no el 404).
test("focusPane: layout degradado → 'degraded' y NI SE LLAMA a tmux", async () => {
  await withWorker({ panes: undefined }, async (id) => {
    const deps = spyDeps("ok");
    assert.equal(await focusPane(id, "worker", deps), "degraded");
    assert.deepEqual(deps.zoomed, [], "no debe tocar tmux con un layout que no se pudo resolver");
  });
});

test("focusPane: worker sin sesión → no-session", async () => {
  await withWorker({ session: undefined }, async (id) => {
    assert.equal(await focusPane(id, "worker", spyDeps("ok")), "no-session");
  });
});

// LA garantía de la feature: una Terminal.app que abre mostrando los 4 panes comprimidos cuando
// pediste "abrir el pane worker" es peor que un error, porque parece que funcionó.
test("attachWorker: si el zoom NO se confirmó, NO abre Terminal.app", async () => {
  for (const bad of ["unreadable", "failed", "mismatch"] as const) {
    await withWorker({}, async (id) => {
      const deps = spyDeps(bad);
      assert.equal(await attachWorker(id, "worker", deps), "tmux-failed");
      assert.deepEqual(deps.opened, [], `no debe abrir Terminal con outcome ${bad}`);
    });
  }
});

test("attachWorker: con el zoom confirmado (ok/noop) SÍ abre Terminal.app", async () => {
  for (const good of ["ok", "noop"] as const) {
    await withWorker({}, async (id) => {
      const deps = spyDeps(good);
      assert.equal(await attachWorker(id, "worker", deps), "ok");
      assert.deepEqual(deps.opened, ["cowork-x-driver"]);
    });
  }
});

test("attachWorker: layout degradado → degraded y no abre nada", async () => {
  await withWorker({ panes: undefined }, async (id) => {
    const deps = spyDeps("ok");
    assert.equal(await attachWorker(id, "worker", deps), "degraded");
    assert.deepEqual(deps.opened, []);
  });
});

// El botón "🖥 abrir Terminal" de siempre no debe cambiar de comportamiento: sin rol no se toca el
// zoom (que es estado COMPARTIDO), sólo se abre la terminal.
test("attachWorker: SIN rol no toca el zoom en absoluto (comportamiento previo intacto)", async () => {
  await withWorker({}, async (id) => {
    const deps = spyDeps("ok");
    assert.equal(await attachWorker(id, undefined, deps), "ok");
    assert.deepEqual(deps.zoomed, [], "sin rol no debe zoomear nada");
    assert.deepEqual(deps.opened, ["cowork-x-driver"]);
  });
});

test("attachWorker: sin rol y sin sesión → no-session, sin abrir nada", async () => {
  await withWorker({ session: undefined }, async (id) => {
    const deps = spyDeps("ok");
    assert.equal(await attachWorker(id, undefined, deps), "no-session");
    assert.deepEqual(deps.opened, []);
  });
});

// Un worker scripted no tiene panes por rol: pedir uno debe degradar, no caer al nombre de sesión.
test("attachWorker: worker scripted con rol → degraded (nunca cae a -t <session>)", async () => {
  await withWorker({ mode: undefined }, async (id) => {
    const deps = spyDeps("ok");
    assert.equal(await attachWorker(id, "worker", deps), "degraded");
    assert.deepEqual(deps.opened, []);
  });
});
