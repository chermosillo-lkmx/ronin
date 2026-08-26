import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

// D6 (major, hallado en review): el guard de stopLive para workers adoptados (engine.ts,
// "F2: 'stop' sobre un adoptado SUELTA, nunca mata") sólo se ejercitaba en engine.test.ts con
// activeMode==="simulated" (MODE se lee de COWORK_MODE al CARGAR config.ts — congelado, no
// reconfigurable después). Este archivo separado fija `COWORK_MODE=live` ANTES de cargar
// engine.js, así que `activeMode` arranca en "live" de verdad — permitiendo probar el DISPATCH
// real de stopWorker (`if (activeMode === "live") return stopLive(...)`), no sólo la rama
// simulada. Vive en su propio archivo porque cada test FILE corre en su propio proceso
// (node --test), así que esto nunca contamina el resto de la suite (simulada por defecto).
//
// TRAMPA REAL (encontrada en vivo escribiendo este mismo test): un `import ... from "./tmux.js"`
// ESTÁTICO en la parte de arriba del archivo se evalúa ANTES que cualquier código de este
// módulo — incluida la línea `process.env.COWORK_MODE = "live"` de abajo — porque los imports
// estáticos de ES modules siempre resuelven antes que el cuerpo del módulo que los declara.
// `tmux.ts` importa `CLAUDE_CMD` de `config.js`, así que ese import estático evaluaba `MODE`
// como "simulated" (el valor por defecto) MUCHO antes de que esta línea corriera, dejando
// `activeMode` congelado en "simulated" sin que ningún error lo delatara — el test pasaba
// igual, pero probando la rama SIMULADA, no la real (exactamente el gap que D6 señala). La
// única forma de fijar el env var a tiempo es que TODO lo que transitivamente importe
// config.ts llegue por un `await import(...)` DINÁMICO, después de fijar la variable.
process.env.COWORK_MODE = "live";

const { createSession } = await import("./tmux.js");
const { adoptSession, releaseAdoption, stopWorker } = await import("./engine.js");
const { snapshot } = await import("./state.js");

const pexec = promisify(execFile);

function envWithoutTmux(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

test("D6: stopWorker en modo LIVE real, sobre un worker adoptado, SUELTA (no mata) la sesión — ejercita el dispatch real, no el simulado", async () => {
  const socket = `ronin-test-d6-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const previousSocket = process.env.COWORK_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.COWORK_TMUX_SOCKET = socket;
  delete process.env.TMUX;
  try {
    await createSession("foreign-e2e-d6-stop", "/tmp");
    const { stdout } = await pexec(
      "tmux",
      ["-L", socket, "list-sessions", "-F", "#{session_name} #{session_created}"],
      { env: envWithoutTmux() }
    );
    const line = stdout.trim().split("\n").find((l) => l.startsWith("foreign-e2e-d6-stop "))!;
    const expectedSessionCreatedAt = Number(line.split(" ")[1]) * 1000;

    const outcome = await adoptSession({
      session: "foreign-e2e-d6-stop",
      confirm: true,
      repo: "monorepo",
      expectedSessionCreatedAt,
    });
    assert.equal(outcome.status, "created");
    const worker = snapshot().workers.find((w) => w.session === "foreign-e2e-d6-stop");
    assert.ok(worker, "el worker adoptado debe existir en el snapshot");
    assert.equal(worker!.origin, "adopted");

    // El DISPATCH real: activeMode==="live" aquí (COWORK_MODE se fijó antes de cargar el módulo).
    const stopped = await stopWorker(worker!.id);
    assert.equal(stopped, true);
    assert.equal(
      snapshot().workers.some((w) => w.session === "foreign-e2e-d6-stop"),
      false,
      "stopWorker debe quitar el worker del tablero"
    );

    // La sesión SIGUE VIVA — stop sobre un adoptado SUELTA, nunca mata (a diferencia de un
    // worker normal, donde stopLive sí haría killSession).
    await assert.doesNotReject(() =>
      pexec("tmux", ["-L", socket, "has-session", "-t", "foreign-e2e-d6-stop"], { env: envWithoutTmux() })
    );
  } finally {
    await releaseAdoption("foreign-e2e-d6-stop").catch(() => {});
    process.env.COWORK_TMUX_SOCKET = previousSocket;
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    await pexec("tmux", ["-L", socket, "kill-server"], { env: envWithoutTmux() }).catch(() => {});
  }
});
