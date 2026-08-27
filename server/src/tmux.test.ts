import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  buildCaptureArgs,
  capturePaneAnsi,
  classifyTmuxInventoryError,
  clearAdoptedMark,
  createSession,
  listSessionPaneIds,
  readAdoptedMark,
  readPaneGeometry,
  parseCaptureBatch,
  sendText,
  setAdoptedMark,
  tmuxCommand,
  tmuxArgs,
} from "./tmux.js";

const pexec = promisify(execFile);

/**
 * Socket propio y desechable (T0.8/M5): esta orquestación vive en la sesión tmux `default`
 * (ventana 178) — nunca se toca. `env -u TMUX` evita que tmux se niegue a anidar en silencio.
 */
function envWithoutTmux(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

async function withIsolatedSocket(fn: (socket: string) => Promise<void>): Promise<void> {
  const socket = `ronin-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const previous = process.env.COWORK_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.COWORK_TMUX_SOCKET = socket;
  delete process.env.TMUX; // pexec("tmux", …) en tmux.ts hereda process.env: sin esto tmux se niega a anidar en silencio
  try {
    await fn(socket);
  } finally {
    process.env.COWORK_TMUX_SOCKET = previous;
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    await pexec("tmux", ["-L", socket, "kill-server"], { env: envWithoutTmux() }).catch(() => {});
  }
}

test("tmuxArgs: con COWORK_TMUX_SOCKET puesto, antepone -L <socket> (aísla los tests del tmux del operador)", () => {
  const previous = process.env.COWORK_TMUX_SOCKET;
  process.env.COWORK_TMUX_SOCKET = "ronin-x";
  try {
    assert.deepEqual(tmuxArgs("list-sessions", "-F", "#{session_name}"), ["-L", "ronin-x", "list-sessions", "-F", "#{session_name}"]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_TMUX_SOCKET;
    else process.env.COWORK_TMUX_SOCKET = previous;
  }
});

test("tmuxArgs: una ruta absoluta usa -S para conservar el socket aunque Electron no herede TMUX_TMPDIR", () => {
  const previous = process.env.COWORK_TMUX_SOCKET;
  process.env.COWORK_TMUX_SOCKET = "/tmp/ronin-smoke/tmux.sock";
  try {
    assert.deepEqual(tmuxArgs("list-sessions"), ["-S", "/tmp/ronin-smoke/tmux.sock", "list-sessions"]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_TMUX_SOCKET;
    else process.env.COWORK_TMUX_SOCKET = previous;
  }
});

test("tmuxArgs: sin la variable, los argumentos son EXACTAMENTE los de hoy (byte a byte)", () => {
  const previous = process.env.COWORK_TMUX_SOCKET;
  delete process.env.COWORK_TMUX_SOCKET;
  try {
    assert.deepEqual(tmuxArgs("list-sessions", "-F", "#{session_name}"), ["list-sessions", "-F", "#{session_name}"]);
    assert.deepEqual(tmuxArgs("has-session", "-t", "cowork-x"), ["has-session", "-t", "cowork-x"]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_TMUX_SOCKET;
    else process.env.COWORK_TMUX_SOCKET = previous;
  }
});

test("el binario tmux respeta COWORK_TMUX_BIN sin alterar el socket", () => {
  const previous = process.env.COWORK_TMUX_BIN;
  process.env.COWORK_TMUX_BIN = "/opt/homebrew/bin/tmux";
  try {
    assert.equal(tmuxCommand(), "/opt/homebrew/bin/tmux");
    assert.deepEqual(tmuxArgs("list-sessions"), ["list-sessions"]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_TMUX_BIN;
    else process.env.COWORK_TMUX_BIN = previous;
  }
});

test("clasifica no server running como inventario vacío, no como socket inaccesible", () => {
  const error = Object.assign(new Error("Command failed"), { stderr: "no server running on /private/tmp/tmux-501/default" });
  assert.equal(classifyTmuxInventoryError(error), null);
});

test("clasifica binario ausente y socket inaccesible", () => {
  const missing = Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
  const inaccessible = Object.assign(new Error("Command failed"), { code: "EPERM", stderr: "error connecting to /private/tmp/tmux-501/default (Operation not permitted)" });
  assert.equal(classifyTmuxInventoryError(missing)?.code, "TMUX_NOT_FOUND");
  assert.equal(classifyTmuxInventoryError(inaccessible)?.code, "TMUX_SERVER_UNREACHABLE");
});

test("buildCaptureArgs: separa cada comando de un batch de capture-pane", () => {
  const args = buildCaptureArgs(["%1", "%2"], 25);

  assert.equal(args.filter((arg) => arg === ";").length, 3);
  assert.equal(args.filter((arg) => arg === "capture-pane").length, 2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "capture-pane") {
      const commandEnd = args.indexOf(";", index);
      assert.ok(args.slice(index, commandEnd).includes("-J"), "cada captura debe unir las filas envueltas por tmux");
    }
  }
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "capture-pane" || args[index] === "display-message") {
      if (index > 0) assert.equal(args[index - 1], ";", `${args[index]} debe empezar tras un separador`);
    }
  }
});

test("parseCaptureBatch: asigna cada captura de stdout a su pane", () => {
  const stdout = "primera captura\n__COWORK_CAPTURE_0__\nsegunda captura\n__COWORK_CAPTURE_1__\n";

  assert.deepEqual(
    parseCaptureBatch(stdout, ["%1", "%2"]),
    new Map([["%1", "primera captura"], ["%2", "segunda captura"]]),
  );
});

test("parseCaptureBatch: un marcador faltante invalida el batch completo", () => {
  const stdout = "primera captura\n__COWORK_CAPTURE_0__\nsegunda captura\n";

  assert.deepEqual(parseCaptureBatch(stdout, ["%1", "%2"]), new Map());
});

test("parseCaptureBatch: no confunde una mención del marcador dentro de una captura", () => {
  const stdout = "texto __COWORK_CAPTURE_0__ mostrado\n__COWORK_CAPTURE_0__\nsegunda captura\n__COWORK_CAPTURE_1__\n";

  assert.deepEqual(
    parseCaptureBatch(stdout, ["%1", "%2"]),
    new Map([["%1", "texto __COWORK_CAPTURE_0__ mostrado"], ["%2", "segunda captura"]]),
  );
});

// ---- @cowork-adopted (T2/T4), contra tmux REAL en un socket propio y desechable ----

test("setAdoptedMark/readAdoptedMark/clearAdoptedMark: escriben, releen y borran la marca en la sesión real", async () => {
  await withIsolatedSocket(async () => {
    await createSession("cowork-mark-test", "/tmp");
    assert.equal(await readAdoptedMark("cowork-mark-test"), null, "sin marca todavía");

    await setAdoptedMark("cowork-mark-test", "v1|monorepo|%0|1700000000");
    assert.equal(await readAdoptedMark("cowork-mark-test"), "v1|monorepo|%0|1700000000");

    await clearAdoptedMark("cowork-mark-test");
    assert.equal(await readAdoptedMark("cowork-mark-test"), null, "clearAdoptedMark debe ser idempotente y dejar null");
  });
});

test("setAdoptedMark: sobre una sesión inexistente LANZA (no traga) — el llamador necesita saberlo para el rollback", async () => {
  await withIsolatedSocket(async () => {
    await assert.rejects(() => setAdoptedMark("no-existe-esta-sesion", "v1|monorepo|%0|1700000000"));
  });
});

// ---- T5: capturePaneAnsi / readPaneGeometry / listSessionPaneIds, contra tmux REAL ----

test("capturePaneAnsi: trae la pantalla (con SGR) de un pane vivo, y null si no existe", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("cowork-capture-test", "/tmp");
    await pexec("tmux", ["-L", socket, "send-keys", "-t", "cowork-capture-test", "-l", "T5_MARKER_OK"], { env: envWithoutTmux() });
    await pexec("tmux", ["-L", socket, "send-keys", "-t", "cowork-capture-test", "Enter"], { env: envWithoutTmux() });

    // Poll en vez de un sleep fijo: bajo carga (toda la suite corriendo) un solo timeout corto
    // es flaky — el shell puede tardar más en ecoar el comando.
    let ansi: string | null = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      ansi = await capturePaneAnsi("cowork-capture-test");
      if (ansi?.includes("T5_MARKER_OK")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ansi?.includes("T5_MARKER_OK"));

    assert.equal(await capturePaneAnsi("%999999"), null);
  });
});

test("readPaneGeometry: cursor/size/dead de un pane vivo, y null si el target no existe", async () => {
  await withIsolatedSocket(async () => {
    await createSession("cowork-geometry-test", "/tmp");
    const geometry = await readPaneGeometry("cowork-geometry-test");
    assert.ok(geometry);
    assert.equal(typeof geometry!.cursor.x, "number");
    assert.equal(typeof geometry!.size.cols, "number");
    assert.equal(geometry!.dead, false);

    assert.equal(await readPaneGeometry("%999999"), null);
  });
});

test("listSessionPaneIds: %N reales de la sesión, null si la sesión no existe", async () => {
  await withIsolatedSocket(async () => {
    await createSession("cowork-panelist-test", "/tmp");
    const ids = await listSessionPaneIds("cowork-panelist-test");
    assert.ok(ids && ids.length === 1 && /^%\d+$/.test(ids[0]!));

    assert.equal(await listSessionPaneIds("no-existe-esta-sesion"), null);
  });
});

// ---- Prueba de mayor valor del ciclo (plan §9): P1/P11 — la superficie pane-scoped (captura +
// input dirigido por %N) NUNCA debe robar el foco activo de tmux. Ambas funciones siempre
// targetean por %N explícito (nunca -a ni el pane "activo" implícito), así que operar sobre un
// pane QUE NO ES el activo no debe moverlo — se fija registrando la identidad activa real de
// tmux (display-message -p) antes y después, contra un socket aislado propio. ----
async function activeIdentity(socket: string): Promise<string> {
  const { stdout } = await pexec(
    "tmux",
    ["-L", socket, "display-message", "-p", "#{session_name}:#{window_index}.#{pane_id}"],
    { env: envWithoutTmux() }
  );
  return stdout.trim();
}

test("P1/P11 (prueba de mayor valor del ciclo): capturePaneAnsi + sendText sobre un pane NO activo no cambian la identidad activa de tmux", async () => {
  await withIsolatedSocket(async (socket) => {
    await createSession("cowork-focus-test", "/tmp");
    // Segunda ventana: tmux la hace activa automáticamente al crearla — deja la ventana 0
    // (con su pane) explícitamente FUERA de foco, sin tocarla más.
    await pexec("tmux", ["-L", socket, "new-window", "-t", "cowork-focus-test", "-c", "/tmp"], { env: envWithoutTmux() });
    const backgroundPane = (
      await pexec("tmux", ["-L", socket, "list-panes", "-t", "cowork-focus-test:0", "-F", "#{pane_id}"], { env: envWithoutTmux() })
    ).stdout.trim();
    assert.match(backgroundPane, /^%\d+$/);

    const before = await activeIdentity(socket);
    assert.match(before, /^cowork-focus-test:1\./, "la ventana 1 (recién creada) debe ser la activa, no la 0");

    await capturePaneAnsi(backgroundPane);
    await sendText(backgroundPane, "echo esto no debe robar el foco", true);

    const after = await activeIdentity(socket);
    assert.equal(after, before, "operar sobre el pane de la ventana 0 (no activa) no debe mover el foco de tmux a la ventana 1");
  });
});
