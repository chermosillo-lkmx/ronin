import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  claudeAlive,
  isBusy,
  lastMeaningfulLine,
  paneStatus,
  parsePaneId,
  parsePaneRoleParam,
  parsePaneRoles,
  promptPending,
} from "./tmux.js";
import { paneAttention } from "./attention.js";
import { TALL_CLAUDE_PANE } from "./claude-pane.fixture.js";

// ---- parsePaneId: salida de `tmux split-window -P -F '#{pane_id}'` ----

test("parsePaneId: extrae el %N de la salida de split-window", () => {
  assert.equal(parsePaneId("%12\n"), "%12");
  assert.equal(parsePaneId("%7"), "%7");
  assert.equal(parsePaneId("  %130  \n"), "%130");
});

test("parsePaneId: null cuando no hay un %N reconocible (nunca inventa un target)", () => {
  for (const bad of ["", "   ", "12\n", "garbage", "no such session", "%\n", "%abc"]) {
    assert.equal(parsePaneId(bad), null, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});

// ---- parsePaneRoles: salida de `list-panes -F '#{pane_id} #{@cowork-role}'` ----

const ROLES = ["%1 driver", "%2 worker", "%3 review", "%4 verify"].join("\n");

test("parsePaneRoles: mapea los 4 roles a sus pane ids", () => {
  assert.deepEqual(parsePaneRoles(ROLES + "\n"), {
    driver: "%1",
    worker: "%2",
    review: "%3",
    verify: "%4",
  });
});

test("parsePaneRoles: tolera espacios múltiples y orden arbitrario", () => {
  const shuffled = ["%9   verify", "%3 driver", "%8  review", "%5 worker"].join("\n");
  assert.deepEqual(parsePaneRoles(shuffled), {
    driver: "%3",
    worker: "%5",
    review: "%8",
    verify: "%9",
  });
});

test("parsePaneRoles: ignora panes sin rol (@cowork-role vacío) sin romperse", () => {
  const withExtra = [ROLES, "%5 ", "%6"].join("\n");
  assert.deepEqual(parsePaneRoles(withExtra), {
    driver: "%1",
    worker: "%2",
    review: "%3",
    verify: "%4",
  });
});

test("parsePaneRoles: null si falta algún rol (layout incompleto → degradar visible)", () => {
  const missing = ["%1 driver", "%2 worker", "%3 review"].join("\n");
  assert.equal(parsePaneRoles(missing), null);
  assert.equal(parsePaneRoles(""), null);
});

test("parsePaneRoles: null si un rol está duplicado (layout ambiguo, no adivinar)", () => {
  const dup = ["%1 driver", "%2 worker", "%3 worker", "%4 verify"].join("\n");
  assert.equal(parsePaneRoles(dup), null);
});

test("parsePaneRoles: ignora roles desconocidos", () => {
  const noisy = [ROLES, "%9 otracosa"].join("\n");
  assert.deepEqual(parsePaneRoles(noisy)?.driver, "%1");
});

// ---- claudeAlive: ¿el pane sigue corriendo claude o cayó a un shell desnudo? ----

const CLAUDE_PANE = [
  "╭──────────────────────────────────────────╮",
  "│ > implementa el plan                     │",
  "╰──────────────────────────────────────────╯",
  "  ⏵⏵ bypass permissions on · ? for shortcuts",
].join("\n");

// Captura literal del pane %130: al estrecharse, el selector `/rc` se envuelve bajo el footer.
const BYPASS_FOOTER_WITH_WRAPPED_RC = [
  "──────────────────────────────────────────────────",
  "  cowork-86e2wyj1h-…  ⎇ ronin/cowork-86e2wyj1h-…  ▓░░░░ 20%",
  "  ⏵⏵ bypass permissions on · 1 monitor · ← 2 agents",
  "                                                  /rc",
].join("\n");

// Captura literal del pane %136: Claude puede apilar decoraciones propias bajo su footer.
const BYPASS_FOOTER_WITH_UPDATE_AND_RC = [
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
  "                                                 ✔ Update installed · Restart to update",
  "                                                                                    /rc",
].join("\n");

test("claudeAlive: true para un pane con la TUI de claude", () => {
  assert.equal(claudeAlive(CLAUDE_PANE), true);
});

test("claudeAlive: true cuando /rc se envuelve bajo el footer de bypass", () => {
  assert.equal(claudeAlive(BYPASS_FOOTER_WITH_WRAPPED_RC), true);
});

test("paneAttention: el footer de bypass con /rc envuelto está idle, no shell", () => {
  assert.equal(paneAttention(BYPASS_FOOTER_WITH_WRAPPED_RC).level, "idle");
});

test("claudeAlive: true con aviso de actualización y /rc bajo el footer", () => {
  assert.equal(claudeAlive(BYPASS_FOOTER_WITH_UPDATE_AND_RC), true);
});

test("paneAttention: el footer con aviso de actualización y /rc está idle, no shell", () => {
  assert.equal(paneAttention(BYPASS_FOOTER_WITH_UPDATE_AND_RC).level, "idle");
});

test("claudeAlive: conserva el chrome de Claude arriba de 68 filas vacías de un pane alto", () => {
  assert.equal(claudeAlive(TALL_CLAUDE_PANE), true);
});

test("lastMeaningfulLine: conserva el último contenido arriba de 68 filas vacías", () => {
  assert.equal(lastMeaningfulLine(TALL_CLAUDE_PANE), "Context low · Run /clear to save 45k tokens");
});

test("claudeAlive: true mientras claude trabaja (footer de interrupción)", () => {
  assert.equal(claudeAlive("* Pensando… (12s · esc to interrupt)"), true);
});

// REGRESIÓN CLAVE: en el layout 2×2 los panes son angostos y el footer se trunca. Si esto
// diera false, el driver se reportaría como caído en CADA poll de un ciclo perfectamente sano.
test("claudeAlive: true aunque el footer esté truncado por un pane angosto (esc to…)", () => {
  assert.equal(claudeAlive("* Working… (8s · esc to…"), true);
  assert.equal(claudeAlive("  ⏵⏵ bypass permissi…"), true);
});

test("claudeAlive: true por el banner de modelo (criterio del propio skill)", () => {
  assert.equal(claudeAlive("  Opus 4.8 · claude-opus-4-8"), true);
  assert.equal(claudeAlive("Sonnet 5"), true);
});

test("claudeAlive: false para un shell desnudo (el driver murió)", () => {
  for (const shell of [
    "sh-3.2$ ",
    "cesar@Cesars-MacBook-Pro claude-cowork % ",
    "$ ",
    "➜  claude-cowork git:(main) ✗ ",
    "[cesar@host ~]# ",
  ]) {
    assert.equal(claudeAlive(shell), false, `debería ser shell: ${JSON.stringify(shell)}`);
  }
});

// REGRESIÓN (encontrada en verificación EN VIVO, no por review estático): al hacer `kill -9` al
// proceso claude, el pane cae al `exec $SHELL -l` que lo envuelve PERO el último frame de la TUI
// se queda pintado (casi ningún CLI limpia la pantalla al morir). Con el chequeo anterior —que
// buscaba chrome en cualquier parte de la captura— esto daba "vivo" para siempre y la caída no
// se detectaba nunca. Sólo al correr `clear` empezaba a funcionar.
const STALE_FRAME_THEN_SHELL = [
  "⏺ Voy a revisar el plan del worker y relayear los hallazgos.",
  "",
  "╭──────────────────────────────────────────────────────────╮",
  "│ >                                                        │",
  "╰──────────────────────────────────────────────────────────╯",
  "  ⏵⏵ bypass permissions on · ? for shortcuts",
  "cesar@Cesars-MacBook-Pro cowork-CU-42 % ",
].join("\n");

test("claudeAlive: false cuando claude murió y su frame quedó rancio sobre un prompt de shell", () => {
  assert.equal(claudeAlive(STALE_FRAME_THEN_SHELL), false);
});

test("claudeAlive: true para ese MISMO frame mientras claude sigue vivo (sin prompt debajo)", () => {
  const alive = STALE_FRAME_THEN_SHELL.split("\n").slice(0, -1).join("\n");
  assert.equal(claudeAlive(alive), true);
});

test("claudeAlive: false si el shell ya imprimió salida de comandos bajo el frame rancio", () => {
  const withOutput = [STALE_FRAME_THEN_SHELL, "total 24", "drwxr-xr-x  5 cesar staff 160 Jul 22 10:01 ."].join("\n");
  assert.equal(claudeAlive(withOutput), false);
});

test("claudeAlive: chrome viejo lejos en el scrollback no cuenta como vivo", () => {
  const scrolled = ["  ⏵⏵ bypass permissions on · ? for shortcuts", ...Array(60).fill("output line"), "sh-3.2$ "].join("\n");
  assert.equal(claudeAlive(scrolled), false);
});

test("claudeAlive: tolera líneas en blanco al final del frame vivo", () => {
  assert.equal(claudeAlive(CLAUDE_PANE + "\n\n  \n"), true);
});

test("claudeAlive: false para un pane vacío", () => {
  assert.equal(claudeAlive(""), false);
  assert.equal(claudeAlive("   \n  \n"), false);
});

// ---- promptPending: prompt compuesto en la caja pero SIN enviar ----
// Estado real capturado en vivo con el mecanismo viejo (send-keys + Enter inmediato): el Enter
// llega mientras la caja compone los trozos pegados y se lo traga.

const COMPOSED_NOT_SENT = [
  "╭──────────────────────────────────────────────────────────╮",
  "│ > [Pasted text #1][Pasted text #2]Línea de relleno 119…   │",
  "╰──────────────────────────────────────────────────────────╯",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

test("promptPending: true cuando el prompt quedó compuesto y el pane está idle", () => {
  assert.equal(promptPending(COMPOSED_NOT_SENT), true);
});

test("promptPending: false si el pane ya está trabajando (el prompt sí entró)", () => {
  assert.equal(promptPending(COMPOSED_NOT_SENT + "\n* Analizando… (3s · esc to interrupt)"), false);
});

test("promptPending: false para una caja vacía tras enviar", () => {
  const sent = ["❯ ", "──────────────────────────", "  paste again to expand"].join("\n");
  assert.equal(promptPending(sent), false);
});

test("promptPending: ignora un marcador viejo que quedó arriba en el transcript", () => {
  const old = ["[Pasted text #1] hace rato", ...Array(20).fill("salida"), "❯ "].join("\n");
  assert.equal(promptPending(old), false);
});

test("promptPending: false para un pane vacío", () => {
  assert.equal(promptPending(""), false);
});

// ---- isBusy: footer de trabajo, incluido el truncado por pane angosto ----

test("isBusy: true con el footer completo", () => {
  assert.equal(isBusy("* Pensando… (12s · esc to interrupt)"), true);
});

test("isBusy: true con el spinner actual aunque Claude ya no muestre 'esc to interrupt'", () => {
  // Capturas reales: desde Claude Code actual el footer útil conserva glifo, verbo, elipsis y
  // timer/token; exigir la frase vieja haría parecer idle a un pane que lleva minutos trabajando.
  assert.equal(isBusy("· Schlepping… (16m 55s · ↓ 19.9k tokens)"), true);
  assert.equal(isBusy("✢ Beboppin'… (22s · ↓ 631 tokens · thinking with high effort)"), true);
});

// REGRESIÓN (encontrada al escribir paneStatus): con el footer cortado por un pane angosto del 2×2,
// isBusy daba false y el pane se leía como idle. No es cosmético: sendWhenReady y el relay usan
// isBusy precisamente para NO escribir a mitad de turno, así que un busy mal leído hace que el
// server teclee encima de un claude trabajando.
test("isBusy: true aunque el footer esté truncado, si conserva el timer (8s · esc to…)", () => {
  assert.equal(isBusy("* Working… (8s · esc to…"), true);
  assert.equal(isBusy("✻ Compilando… (125s · esc to i"), true);
});

// El formato observado es `(Ns ·` — el mismo que usa el watcher del propio skill
// (skills/tmux-worker-loop/watch.sh:71). Se cubre además el de minutos por si el timer cambia:
// no cuesta nada y evita reabrir esta misma regresión.
test("isBusy: true con un timer de dos grupos truncado (1m 12s · esc to…)", () => {
  assert.equal(isBusy("* Pensando… (1m 12s · esc to…"), true);
  assert.equal(isBusy("* Pensando… (2h 5m · esc to interrupt)"), true);
});

// El timer entre paréntesis es lo que desambigua: "esc to" suelto es chrome válido de claude en
// reposo, y contarlo como ocupado congelaría el reloj de atasco de un pane parado de verdad.
test("isBusy: false para el chrome de claude en reposo (sin timer)", () => {
  assert.equal(isBusy("  ⏵⏵ bypass permissions on · ? for shortcuts"), false);
  assert.equal(isBusy("presiona esc to salir"), false);
  assert.equal(isBusy(""), false);
});

// ---- paneStatus: estado de UN pane hermano, para la lista de la vista ⌘ Sessions ----

test("paneStatus: working cuando claude está trabajando", () => {
  assert.equal(paneStatus("* Pensando… (12s · esc to interrupt)"), "working");
});

// Mismo modo de falla que ya defiende claudeAlive: en el 2×2 los panes son angostos y el footer se
// corta. Si esto diera "idle", un pane que trabaja se vería parado en cada poll.
test("paneStatus: working aunque el footer venga truncado por un pane angosto", () => {
  assert.equal(paneStatus("* Working… (8s · esc to…"), "working");
});

test("paneStatus: working gana sobre idle (la TUI está Y además trabaja)", () => {
  assert.equal(paneStatus([CLAUDE_PANE, "* Compilando… (3s · esc to interrupt)"].join("\n")), "working");
});

test("paneStatus: idle cuando la TUI de claude está pero no trabaja", () => {
  assert.equal(paneStatus(CLAUDE_PANE), "idle");
});

// EL punto que hace que este estado no sea "caído": review y verify NACEN como shells desnudos y
// el driver los arranca sólo cuando los necesita (provisioned-panes.md §2'). Etiquetarlos de caídos
// sería un falso positivo durante casi todo el ciclo, y la acción que sugeriría es la contraria.
test("paneStatus: shell para un pane sin claude — es 'sin arrancar', NO 'caído'", () => {
  for (const sh of ["sh-3.2$ ", "cesar@Cesars-MacBook-Pro claude-cowork % ", "➜  cowork git:(main) ✗ "]) {
    assert.equal(paneStatus(sh), "shell", `debería ser shell: ${JSON.stringify(sh)}`);
  }
});

test("paneStatus: shell al detectar un frame rancio sobre un único prompt", () => {
  assert.equal(paneStatus(STALE_FRAME_THEN_SHELL), "shell");
});

// "No pude leer" (null) y "leí y estaba vacío") ("") son cosas distintas: el mismo criterio que
// applyDriverHealth, donde una captura fallida nunca se convierte en una conclusión.
test("paneStatus: gone SÓLO para null (captura fallida / pane muerto)", () => {
  assert.equal(paneStatus(null), "gone");
  assert.equal(paneStatus(""), "shell", "un pane vacío se leyó bien: no está muerto");
  assert.equal(paneStatus("   \n  \n"), "shell");
});

// ---- parsePaneRoleParam: la validación del rol que llega del cliente ----
// Crítica: el rol acaba resolviéndose a un `%N` que va como `-t` de tmux. Vive en tmux.ts y no en
// index.ts porque index.ts hace app.listen al importarse — ahí no sería testeable.

test("parsePaneRoleParam: ausente o null → rol null (= 'los 4 panes'), NO un error", () => {
  assert.deepEqual(parsePaneRoleParam(undefined), { ok: true, role: null });
  assert.deepEqual(parsePaneRoleParam(null), { ok: true, role: null });
});

test("parsePaneRoleParam: acepta los 4 roles exactos", () => {
  for (const role of ["driver", "worker", "review", "verify"] as const) {
    assert.deepEqual(parsePaneRoleParam(role), { ok: true, role });
  }
});

// Se rechaza sin normalizar a propósito: un trim()/toLowerCase() convertiría un input dudoso en uno
// válido, y en la frontera con tmux lo correcto es rechazar, no adivinar qué quiso decir.
test("parsePaneRoleParam: rechaza variantes casi-válidas en vez de normalizarlas", () => {
  for (const bad of ["Worker", "WORKER", " worker", "worker ", "", "otro"]) {
    assert.deepEqual(parsePaneRoleParam(bad), { ok: false }, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});

// Un target-spec disfrazado de rol: si se colara, leeríamos/escribiríamos panes de OTRAS sesiones
// del usuario (pexec usa execFile, así que no hay inyección de shell, pero sí de target-spec).
test("parsePaneRoleParam: rechaza pane ids y target-specs de tmux", () => {
  for (const bad of ["%1", "session:0.1", "cowork-x-driver", "driver;kill-session", "-t"]) {
    assert.deepEqual(parsePaneRoleParam(bad), { ok: false }, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});

// El array importa: Express entrega `?role=worker&role=review` como ARRAY, y una validación que
// hiciera String(x) antes de comparar lo volvería aceptable ("worker,review" no, pero un array de
// un solo elemento sí).
test("parsePaneRoleParam: rechaza no-strings, incluido el array de query repetida", () => {
  for (const bad of [123, true, false, {}, [], ["worker"], ["worker", "review"], () => "worker"]) {
    assert.deepEqual(parsePaneRoleParam(bad), { ok: false }, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});

// Nunca deben poder llegar a un acceso por índice sobre worker.panes.
test("parsePaneRoleParam: rechaza claves del prototipo", () => {
  for (const bad of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    assert.deepEqual(parsePaneRoleParam(bad), { ok: false }, `debería rechazar: ${JSON.stringify(bad)}`);
  }
});
