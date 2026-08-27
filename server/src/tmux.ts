import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_CMD } from "./config.js";

const exec = promisify(execFile);

function pexec(command: string, args: string[]) {
  return exec(command === "tmux" ? tmuxCommand() : command, args);
}

export type TmuxDiagnosticCode = "TMUX_NOT_FOUND" | "TMUX_SERVER_UNREACHABLE" | "TMUX_INVENTORY_FAILED";

export interface TmuxDiagnostic {
  code: TmuxDiagnosticCode;
  detail: string;
}

export interface TmuxRawResult {
  output: string;
  diagnostic: TmuxDiagnostic | null;
}

/** The desktop main process resolves Homebrew tmux before launching this backend. */
export function tmuxCommand(): string {
  return process.env.COWORK_TMUX_BIN?.trim() || "tmux";
}

/**
 * `tmux list-sessions` with no server is the normal empty-inventory case. Everything else is
 * kept typed so an Electron app never renders an inaccessible tmux socket as "0 sesiones".
 */
export function classifyTmuxInventoryError(error: unknown): TmuxDiagnostic | null {
  const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown } | undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const stderr = typeof candidate?.stderr === "string" ? candidate.stderr : "";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  const detail = (stderr || message || "tmux no respondió").trim();
  if (/no server running/i.test(detail)) return null;
  if (code === "ENOENT") return { code: "TMUX_NOT_FOUND", detail };
  if (code === "EACCES" || code === "EPERM" || /error connecting/i.test(detail)) {
    return { code: "TMUX_SERVER_UNREACHABLE", detail };
  }
  return { code: "TMUX_INVENTORY_FAILED", detail };
}

/**
 * P15 (verificado): las 20+ llamadas de este archivo van a `pexec("tmux", …)` sin `-L`, así
 * que todas caen en el socket POR DEFECTO — el mismo que usa el operador. Un E2E "en socket
 * propio" sería invisible para el servidor salvo por este override, y con él "los tests no
 * tocan el tmux del operador" deja de ser una convención que alguien puede olvidar y pasa a
 * ser estructural: TODA llamada de este módulo pasa por aquí.
 */
export function tmuxArgs(...args: string[]): string[] {
  const socket = process.env.COWORK_TMUX_SOCKET;
  // `-L` names a socket below tmux's temp directory. An absolute path must instead use `-S`:
  // Finder's `open` does not reliably inherit TMUX_TMPDIR, while an explicit path is portable.
  return socket ? [socket.startsWith("/") ? "-S" : "-L", socket, ...args] : args;
}

export async function tmuxAvailable(): Promise<boolean> {
  try {
    await pexec("tmux", tmuxArgs("-V"));
    return true;
  } catch {
    return false;
  }
}

/** List existing tmux session names (empty if no server / none). */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs("list-sessions", "-F", "#{session_name}"));
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Formatos del inventario completo (F1, T3). Se parsean en sessions.ts; aquí sólo se ejecutan,
 * porque este módulo es el dueño de `tmux` en el repo. `#{@cowork-adopted}` viaja GRATIS en el
 * `list-sessions` que ya se ejecuta (coste tmux cero) — así el server sabe qué sesiones tienen
 * la marca de adopción (F2) sin una llamada aparte por sesión.
 */
// tmux 3.6 sanitizes literal control tabs in format output to `_`, so a tab delimiter makes
// every complete row look like one session name. `:` is a printable delimiter that tmux itself
// disallows in session names. Pane title is deliberately last: it may itself contain colons.
const INVENTORY_SESSION_FMT =
  "#{session_name}:#{session_windows}:#{session_created}:#{session_attached}:#{@cowork-adopted}";
const INVENTORY_PANE_FMT =
  "#{session_name}:#{window_index}:#{pane_id}:#{pane_active}:#{@cowork-role}:#{pane_current_command}:#{pane_title}";

/**
 * stdout crudo de `list-sessions` con los 4 campos del inventario. "" si no hay servidor tmux:
 * "no hay sesiones" es la respuesta correcta, no un error que la UI tenga que distinguir.
 * SÓLO LECTURA — `list-sessions` contra un servidor muerto sale con código 1 sin arrancar uno.
 */
export async function listSessionsRaw(): Promise<string> {
  return (await listSessionsRawResult()).output;
}

/** stdout crudo de `list-panes -a` con los 7 campos del inventario. "" si falla. SÓLO LECTURA. */
export async function listPanesRaw(): Promise<string> {
  return (await listPanesRawResult()).output;
}

export async function listSessionsRawResult(): Promise<TmuxRawResult> {
  try {
    return { output: (await pexec("tmux", tmuxArgs("list-sessions", "-F", INVENTORY_SESSION_FMT))).stdout, diagnostic: null };
  } catch (error) {
    return { output: "", diagnostic: classifyTmuxInventoryError(error) };
  }
}

export async function listPanesRawResult(): Promise<TmuxRawResult> {
  try {
    return { output: (await pexec("tmux", tmuxArgs("list-panes", "-a", "-F", INVENTORY_PANE_FMT))).stdout, diagnostic: null };
  } catch (error) {
    return { output: "", diagnostic: classifyTmuxInventoryError(error) };
  }
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await pexec("tmux", tmuxArgs("has-session", "-t", name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a detached tmux session that runs claude in `cwd`, keeping the pane
 * alive with a login shell afterward so the terminal doesn't vanish on exit.
 */
export async function createSession(name: string, cwd: string, startCmd: string = CLAUDE_CMD): Promise<void> {
  const command = `${startCmd}; exec $SHELL -l`;
  await pexec("tmux", tmuxArgs("new-session", "-d", "-s", name, "-c", cwd, command));
}

/** Type literal text into the pane; optionally submit with Enter. */
export async function sendText(name: string, text: string, submit: boolean): Promise<void> {
  await pexec("tmux", tmuxArgs("send-keys", "-t", name, "-l", text));
  if (submit) await pexec("tmux", tmuxArgs("send-keys", "-t", name, "Enter"));
}

// Un prompt largo entra a la caja de input de Claude Code en varios trozos ("[Pasted text #1]…").
// Con `send-keys -l` seguido de Enter SIN pausa, el Enter llega mientras la caja todavía está
// componiendo y se lo TRAGA: el prompt queda escrito pero sin enviar, indefinidamente. Verificado
// en vivo 2/2 con el prompt del driver (~7KB). El mecanismo de abajo es el que documenta el propio
// SKILL.md (`load-buffer` + `paste-buffer -p` + sleep + Enter) — bracketed paste entrega el texto
// de una pieza y la pausa deja que la caja termine de renderizar antes del Enter.
const PASTE_BUFFER = "cowork-prompt";
const PASTE_SETTLE_MS = 1200;

/** Entrega un prompt largo por buffer + bracketed paste. Para textos cortos basta sendText. */
export async function pastePrompt(target: string, text: string, submit: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cowork-paste-"));
  const file = join(dir, "prompt.txt");
  try {
    writeFileSync(file, text);
    // Por archivo y no por argv: el prompt puede pasar de los límites de tamaño de argumentos.
    await pexec("tmux", tmuxArgs("load-buffer", "-b", PASTE_BUFFER, file));
    // -p = bracketed paste (preserva el multilínea); -d = borra el buffer tras pegar.
    await pexec("tmux", tmuxArgs("paste-buffer", "-b", PASTE_BUFFER, "-p", "-d", "-t", target));
    if (submit) {
      await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
      await pexec("tmux", tmuxArgs("send-keys", "-t", target, "Enter"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Cuántas líneas del final se miran para decidir si hay texto compuesto sin enviar: el marcador
// del paste vive en la caja de input (abajo), no en el transcript de más arriba.
const PENDING_RECENT_LINES = 10;
const PASTED_MARKER = /\[pasted text/i;

/**
 * ¿Hay un prompt COMPUESTO en la caja de input pero sin enviar? Se usa para reintentar el Enter
 * de forma acotada tras un paste largo, en vez de asumir que salió. PURA (testeable).
 */
export function promptPending(pane: string): boolean {
  const text = pane ?? "";
  if (!text.trim()) return false;
  if (isBusy(text)) return false; // ya está trabajando ⇒ el prompt sí entró
  return text
    .split("\n")
    .slice(-PENDING_RECENT_LINES)
    .some((l) => PASTED_MARKER.test(l));
}

/** Send named keys (interpreted by tmux, e.g. "Escape", "Down", "Enter") — not literal text. */
export async function sendKeys(name: string, ...keys: string[]): Promise<void> {
  await pexec("tmux", tmuxArgs("send-keys", "-t", name, ...keys));
}

export async function capturePane(name: string): Promise<string> {
  const { stdout } = await pexec("tmux", tmuxArgs("capture-pane", "-t", name, "-p"));
  return stdout;
}

/**
 * Captura tolerante: null cuando el pane ya no existe. `capture-pane -t %N` sale con código 1 y
 * "can't find pane: %N" en cuanto el pane muere (verificado en vivo), y el `%N` no se reutiliza
 * mientras viva el servidor tmux. Sin esto, el throw de capturePane deja al cliente mostrando el
 * último texto bueno para siempre — un pane muerto se ve idéntico a uno que dejó de escribir.
 */
export async function capturePaneSafe(target: string): Promise<string | null> {
  try {
    return await capturePane(target);
  } catch {
    return null;
  }
}

/**
 * Captura la cola de todos los panes en UNA invocación a tmux. El inventario se refresca cada
 * cinco segundos: hacer un proceso por pane convertiría una señal visual barata en coste lineal.
 * Una falla global no se traduce en `gone`; deja el mapa vacío para que sessions.ts omita atención
 * en vez de anunciarar panes muertos sin haberlos observado.
 */
export async function capturePanesTail(paneIds: string[], lines: number = 25): Promise<Map<string, string | null>> {
  if (!paneIds.length) return new Map();
  const markers = paneIds.map((paneId, index) => `__COWORK_CAPTURE_${index}_${paneId}__`);
  const args: string[] = [];
  for (let index = 0; index < paneIds.length; index++) {
    args.push("capture-pane", "-p", "-S", `-${lines}`, "-t", paneIds[index]!, ";", "display-message", "-p", markers[index]!);
  }
  try {
    const { stdout } = await pexec("tmux", tmuxArgs(...args));
    const captures = new Map<string, string | null>();
    let start = 0;
    for (let index = 0; index < paneIds.length; index++) {
      const end = stdout.indexOf(markers[index]!, start);
      if (end < 0) return new Map(); // formato incompleto: no inferir cuáles panes siguen vivos
      captures.set(paneIds[index]!, stdout.slice(start, end).replace(/\n$/, ""));
      start = end + markers[index]!.length;
    }
    return captures;
  } catch {
    return new Map();
  }
}

/**
 * T5: captura CON SGR (colores/estilo) para el visor por pane — `capture-pane -p` a secas
 * pierde el color. `target` puede ser un `%N` global (tmux lo resuelve sin importar la
 * sesión), lo que es justo lo que necesita `paneMembership` (index.ts) para distinguir "vive
 * en otra sesión" de "ya no existe en ningún lado". Tolerante: null si el pane no existe.
 */
export async function capturePaneAnsi(target: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs("capture-pane", "-p", "-e", "-t", target));
    return stdout;
  } catch {
    return null;
  }
}

export interface PaneGeometry {
  cursor: { x: number; y: number };
  size: { cols: number; rows: number };
  dead: boolean;
}

/**
 * T5: cursor + geometría + vivo/muerto en UNA llamada — para posicionar el cursor de verdad
 * en el visor por pane y hacer letterbox en vez de deformar. null si el target no existe.
 */
export async function readPaneGeometry(target: string): Promise<PaneGeometry | null> {
  try {
    const { stdout } = await pexec(
      "tmux",
      tmuxArgs("display-message", "-p", "-t", target, "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{pane_dead}")
    );
    const m = stdout.trim().match(/^(\d+) (\d+) (\d+) (\d+) ([01])$/);
    if (!m) return null;
    return {
      cursor: { x: Number(m[1]), y: Number(m[2]) },
      size: { cols: Number(m[3]), rows: Number(m[4]) },
      dead: m[5] === "1",
    };
  } catch {
    return null;
  }
}

/**
 * T5: los `%N` ACTUALES de una sesión (no `-a`, sólo esa sesión) — la autoridad para decidir
 * pertenencia "en el momento del uso" y no contra un inventario cacheado. null si la sesión en
 * sí no existe (distinto de "sesión viva, sin panes", que tmux no permite de todos modos).
 */
export async function listSessionPaneIds(session: string): Promise<string[] | null> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs("list-panes", "-s", "-t", session, "-F", "#{pane_id}"));
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export type PaneMembership = "in-session" | "elsewhere" | "session-not-found" | "gone";

/**
 * T5/D2: ¿el `%N` pedido pertenece HOY a `session`? Un `%N` se resuelve globalmente en tmux
 * (`capturePaneAnsi` arriba lo explica) — `join-pane`/`move-pane` puede reasignar un pane
 * adoptado a OTRA sesión sin que deje de existir, así que "existe" no basta para decidir si
 * es seguro leer/escribir: hace falta distinguir "sigue en la sesión esperada" de "vive en OTRA"
 * (nunca tocar) de "ya no existe en ningún lado". Compartida por las rutas HTTP de pane
 * (index.ts) y por la I/O de workers adoptados/driver (engine.ts) — una sola implementación.
 */
/**
 * Activa la ventana y el pane indicados en su sesión. Es estado de la VENTANA tmux, compartido:
 * lo ven todos los clientes adjuntos (ttyd, Terminal.app). `select-window` acepta un pane como
 * target y resuelve su ventana; después `select-pane` lo activa dentro de ella.
 */
export async function focusSessionPane(paneId: string): Promise<void> {
  await pexec("tmux", tmuxArgs("select-window", "-t", paneId));
  await pexec("tmux", tmuxArgs("select-pane", "-t", paneId));
}

export async function paneMembership(session: string, paneId: string): Promise<PaneMembership> {
  const paneIds = await listSessionPaneIds(session);
  if (paneIds === null) return "session-not-found";
  if (paneIds.includes(paneId)) return "in-session";
  const stillExists = (await capturePaneAnsi(paneId)) !== null;
  return stillExists ? "elsewhere" : "gone";
}

export async function killSession(name: string): Promise<void> {
  try {
    await pexec("tmux", tmuxArgs("kill-session", "-t", name));
  } catch {
    /* already gone */
  }
}

// ---- Modo Driver: provisión de la ventana de 4 panes ----

// Geometría explícita: una sesión detached nace 80×24, que partida 2×2 da panes de ~40×11
// donde el footer de claude se trunca y su TUI se mis-renderiza — el mismo modo de falla que
// obligó al skill a dejar de raspar el pane. El fallback del propio skill usa -x 220 -y 50.
const DRIVER_COLS = "220";
const DRIVER_ROWS = "55";

/** Opciones cosméticas/UX: nunca deben tumbar un lanzamiento en un tmux viejo. */
async function tmuxOptional(args: string[]): Promise<void> {
  try {
    await pexec("tmux", tmuxArgs(...args));
  } catch {
    /* opcional */
  }
}

/**
 * Crea la sesión driver: UNA ventana con 4 panes en 2×2 (driver|worker / review|verify),
 * mouse on, y cada pane etiquetado con su rol. Devuelve los pane_id (%N) por rol.
 *
 * Se usa `new-session` (no `new-window` sobre una sesión existente) a propósito: una ventana
 * extra dejaría viva la ventana 0 huérfana, la barra de estado dejaría al usuario cambiarse de
 * ventana dentro del iframe, y `kill-window` dejaría la sesión viva — con lo que `hasSession`
 * reportaría el worker como vivo para siempre y la detección de muerte dejaría de funcionar.
 * Así, `killSession`/`hasSession`/`stopTtyd` siguen sirviendo sin cambios.
 *
 * Sólo el pane driver arranca claude; los otros 3 quedan en shell y los arranca el propio
 * driver (mismo patrón que el skill ya usa para el worker).
 */
export async function createDriverWindow(
  session: string,
  cwd: string,
  startCmd: string = CLAUDE_CMD
): Promise<Record<PaneRole, string>> {
  const command = `${startCmd}; exec $SHELL -l`;
  await pexec("tmux", tmuxArgs(
    "new-session", "-d", "-s", session, "-n", "driver",
    "-c", cwd, "-x", DRIVER_COLS, "-y", DRIVER_ROWS, command,
  ));

  // El pane inicial de una sesión recién creada es determinístico; se lee su %N para no
  // depender nunca de índices (que tmux renumera al morir un pane).
  const { stdout: first } = await pexec("tmux", tmuxArgs("list-panes", "-s", "-t", session, "-F", "#{pane_id}"));
  const driver = parsePaneId(first.split("\n")[0] ?? "");
  if (!driver) throw new Error("no se pudo resolver el pane driver");

  const split = async (target: string, dir: "-h" | "-v"): Promise<string> => {
    const { stdout } = await pexec("tmux", tmuxArgs(
      "split-window", dir, "-t", target, "-c", cwd, "-P", "-F", "#{pane_id}",
    ));
    const id = parsePaneId(stdout);
    if (!id) throw new Error(`split-window no devolvió un pane_id (${stdout.trim()})`);
    return id;
  };

  const worker = await split(driver, "-h"); // arriba-derecha
  const review = await split(driver, "-v"); // abajo-izquierda
  const verify = await split(worker, "-v"); // abajo-derecha
  const panes: Record<PaneRole, string> = { driver, worker, review, verify };

  // El rol queda guardado EN tmux: así una rediscovery tras reiniciar el server los recupera
  // de la fuente de verdad en vez de confiar en un archivo que puede quedar rancio.
  for (const role of PANE_ROLES) {
    await tmuxOptional(["set-option", "-p", "-t", panes[role], "@cowork-role", role]);
    await tmuxOptional(["select-pane", "-t", panes[role], "-T", role]);
  }

  // `mouse` es opción de SESIÓN (no de ventana): con -w se fijaría en la tabla equivocada.
  await tmuxOptional(["set-option", "-t", session, "mouse", "on"]);
  await tmuxOptional(["set-option", "-t", session, "pane-border-status", "top"]);
  // Dos clientes ttyd (Board + Sessions) harían que tmux dimensione al MÁS CHICO, recreando
  // el problema de panes angostos; "latest" hace que mande el cliente más reciente.
  await tmuxOptional(["set-option", "-t", session, "window-size", "latest"]);

  // Tras los splits el pane ACTIVO es el último partido (verify). Sin esto, cualquier `-t
  // <session>` — incluido el fallback de sendWhenReady — escribiría en el pane equivocado.
  await tmuxOptional(["select-pane", "-t", driver]);

  const { stdout: all } = await pexec("tmux", tmuxArgs("list-panes", "-s", "-t", session, "-F", "#{pane_id}"));
  const count = all.split("\n").filter((l) => l.trim()).length;
  if (count !== PANE_ROLES.length) throw new Error(`la ventana driver quedó con ${count} pane(s), no 4`);

  return panes;
}

/** Re-consulta a tmux los panes por rol (rediscovery). null si el layout ya no tiene los 4. */
export async function readPaneRoles(session: string): Promise<Record<PaneRole, string> | null> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs(
      "list-panes", "-t", session, "-F", "#{pane_id} #{@cowork-role}",
    ));
    return parsePaneRoles(stdout);
  } catch {
    return null;
  }
}

/**
 * Marca de adopción (F2/T2/T4): AUTORIDAD de qué sesión está adoptada, persistida EN tmux (no
 * en un archivo bajo `data/`) — muere con la sesión, así que un registro rancio es
 * estructuralmente imposible (mismo patrón que `@cowork-role`, arriba). A diferencia de
 * `setSessionReviewTool` (cosmético, `tmuxOptional`), `setAdoptedMark` LANZA: el commit de la
 * adopción (adopt.ts) necesita saber si falló para decidir el rollback.
 */
export async function setAdoptedMark(session: string, payload: string): Promise<void> {
  await pexec("tmux", tmuxArgs("set-option", "-t", session, "@cowork-adopted", payload));
}

/** Relee la marca tal cual tmux la guardó (verbatim, sin validar). null = sin marca / ilegible. */
export async function readAdoptedMark(session: string): Promise<string | null> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs("display-message", "-p", "-t", session, "#{@cowork-adopted}"));
    const value = stdout.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/** `-u` desasigna la opción (vs. dejarla en ""). Idempotente: repetirla sobre una sesión ya
 * sin marca no es un error — el rollback de adopt.ts la llama sin comprobar el estado previo. */
export async function clearAdoptedMark(session: string): Promise<void> {
  await tmuxOptional(["set-option", "-u", "-t", session, "@cowork-adopted"]);
}

/** Guarda la herramienta de review en la sesión (fuente de verdad viva para rediscovery). */
export async function setSessionReviewTool(session: string, tool: string): Promise<void> {
  await tmuxOptional(["set-option", "-t", session, "@cowork-review-tool", tool]);
}

/**
 * Lee `@cowork-review-tool` de la sesión, "" si no existe. Se usa `display-message` y NO
 * `show-options -v`: éste sale con error cuando la opción no está definida, que es el caso
 * normal de toda sesión scripted. OJO: tmux guarda el valor VERBATIM, sin validar — el
 * llamador DEBE pasarlo por sanitizeReviewTool.
 */
export async function readSessionReviewTool(session: string): Promise<string> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs(
      "display-message", "-p", "-t", session, "#{@cowork-review-tool}",
    ));
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Open a visible macOS Terminal window attached to the session. */
export async function openTerminal(name: string): Promise<void> {
  const script = [
    'tell application "Terminal"',
    `  do script "tmux attach -t ${name}"`,
    "  activate",
    "end tell",
  ].join("\n");
  await pexec("osascript", ["-e", script]);
}

// ---- Modo Driver: parsers puros de la salida de tmux (testeables sin tmux) ----

/** Roles de la ventana driver, en el orden en que se crean los panes. */
export const PANE_ROLES = ["driver", "worker", "review", "verify"] as const;
export type PaneRole = (typeof PANE_ROLES)[number];

/**
 * Extrae el pane id de la salida de `split-window -P -F '#{pane_id}'` → "%12".
 * null si no hay un %N reconocible: preferimos fallar el lanzamiento a inventar un
 * target al que luego el driver le mandaría teclas.
 */
export function parsePaneId(stdout: string): string | null {
  const m = (stdout ?? "").trim().match(/^%\d+$/);
  return m ? m[0] : null;
}

/**
 * Parsea `list-panes -t <s> -F '#{pane_id} #{@cowork-role}'` → los 4 panes por rol.
 * Devuelve null si falta un rol o si alguno está duplicado (layout incompleto o ambiguo):
 * el llamador degrada visiblemente en vez de adivinar.
 */
export function parsePaneRoles(stdout: string): Record<PaneRole, string> | null {
  const found = new Map<string, string>();
  for (const line of (stdout ?? "").split("\n")) {
    const m = line.trim().match(/^(%\d+)\s+(\S+)$/);
    if (!m) continue;
    const [, id, role] = m;
    if (!(PANE_ROLES as readonly string[]).includes(role)) continue;
    if (found.has(role)) return null; // duplicado → ambiguo
    found.set(role, id);
  }
  if (found.size !== PANE_ROLES.length) return null;
  return Object.fromEntries(PANE_ROLES.map((r) => [r, found.get(r)!])) as Record<PaneRole, string>;
}

/**
 * Valida el `role` que llega del cliente (query o body). Se rechaza SIN normalizar (nada de trim
 * ni toLowerCase): un input dudoso convertido en válido es exactamente lo que no queremos en la
 * frontera con tmux, donde el rol acaba resolviéndose a un `%N` que va como `-t`.
 *
 * Distingue tres casos a propósito: ausente (= "los 4 panes", legítimo) NO es lo mismo que
 * presente-pero-inválido (400). Colapsarlos hacía que `?role=Worker` con typo se tragara en
 * silencio y devolviera el pane driver, mientras el mismo input por POST daba error.
 *
 * Nota histórica: esta función vivía en `tmux.ts` y no en `index.ts` porque, en ese entonces,
 * `index.ts` hacía `app.listen` al importarse — importarlo en un test arrancaba un servidor real.
 * ESO YA NO ES CIERTO: `index.ts` exporta `createApp()`/`startServer()` como funciones separadas
 * y no escucha nada por el sólo hecho de importarse (`server-entry.ts` es quien llama a
 * `startServer()` explícitamente). La función se queda en `tmux.ts` de todos modos porque valida
 * un concepto de tmux (`PANE_ROLES`) que `index.ts` ya importa de aquí para sus rutas — no por la
 * razón original.
 */
export type RoleParam = { ok: true; role: PaneRole | null } | { ok: false };

export function parsePaneRoleParam(raw: unknown): RoleParam {
  if (raw === undefined || raw === null) return { ok: true, role: null };
  // `includes` sobre el array (no un lookup en objeto): "__proto__" y compañía no son roles.
  // Express entrega `?role=a&role=b` como array, de ahí el chequeo explícito de tipo.
  if (typeof raw !== "string") return { ok: false };
  if (!(PANE_ROLES as readonly string[]).includes(raw)) return { ok: false };
  return { ok: true, role: raw as PaneRole };
}

// ---- Modo Driver: zoom de un pane (Feature "attach a una terminal específica") ----

/** Estado de zoom de la VENTANA (no del cliente: tmux no tiene zoom por cliente). */
export interface ZoomState {
  zoomed: boolean;
  active: string; // pane_id activo (%N)
}

export type ZoomOutcome = "ok" | "noop" | "unreadable" | "failed" | "mismatch";

/**
 * Parsea `display-message -p -t <s> '#{window_zoomed_flag} #{pane_id}'` → { zoomed, active }.
 * null si la salida no es exactamente eso: mismo criterio que parsePaneId — preferimos no concluir
 * nada a inventar un target al que después le mandaríamos comandos de layout.
 */
export function parseZoomState(stdout: string): ZoomState | null {
  const m = (stdout ?? "").trim().match(/^([01])\s+(%\d+)$/);
  return m ? { zoomed: m[1] === "1", active: m[2] } : null;
}

/**
 * Comandos de tmux para dejar el zoom donde se pide. `target = null` → volver al 2×2.
 *
 * Esta función existe porque `-Z` es un TOGGLE, no un "zoomea esto", y porque `select-pane -Z`
 * NO crea el zoom (sólo lo conserva). Ambas cosas verificadas en vivo contra tmux 3.6a; una
 * implementación que ignore cualquiera de las dos des-zoomea justo cuando el usuario pide foco.
 *
 * Devuelve [] cuando no hay nada que hacer. Eso importa: el zoom y el pane activo son estado
 * COMPARTIDO por todos los clientes attachados, así que emitir un comando de más le mueve la
 * pantalla (o le roba el foco) a quien esté mirando la misma sesión.
 */
export function zoomPlan(state: ZoomState, target: string | null, driverPane: string): string[][] {
  if (target === null) {
    // Sin zoom no hay nada que deshacer: volver a "los 4 panes" es una operación local del
    // navegador, no debe tocar la sesión de nadie.
    if (!state.zoomed) return [];
    // `select-pane` SIN -Z des-zoomea Y activa el pane de un golpe (verificado). Restaurar el
    // driver como activo mantiene la invariante de createDriverWindow.
    return [["select-pane", "-t", driverPane]];
  }
  if (state.zoomed) {
    // Ya está donde se pide: idempotente (la UI pollea, no debe re-aplicar layout cada 1.5s).
    if (state.active === target) return [];
    // El zoom SIGUE al pane activo. Añadir resize-pane -Z aquí des-zoomearía (toggle).
    return [["select-pane", "-t", target, "-Z"]];
  }
  return [
    ["select-pane", "-t", target, "-Z"],
    ["resize-pane", "-Z", "-t", target],
  ];
}

/**
 * ¿El zoom quedó realmente donde se pidió? Se compara el estado RELEÍDO con lo solicitado, porque
 * "mandé los comandos" no es "el layout está como dije": si `select-pane -Z` sale bien y
 * `resize-pane -Z` falla, la ventana queda a medio aplicar y el server reportaría éxito.
 * Una relectura fallida (null) tampoco es éxito: no poder confirmar no es confirmar.
 */
export function zoomOutcome(
  plan: string[][],
  after: ZoomState | null,
  target: string | null
): "ok" | "noop" | "mismatch" {
  if (plan.length === 0) return "noop";
  if (!after) return "mismatch";
  if (after.zoomed !== (target !== null)) return "mismatch";
  if (target !== null && after.active !== target) return "mismatch";
  return "ok";
}

// Cola serie por sesión. El zoom es un read-modify-write sobre estado compartido: dos /focus
// concurrentes pueden leer ambos `zoomed:false` y emitir ambos `resize-pane -Z`, con lo que el
// segundo des-zoomea lo que el primero acababa de zoomear. Node es monohilo, pero cada `await`
// cede el control, así que el intercalado es real. Se encola en vez de reintentar: con reintentos
// dos clientes pueden pelearse indefinidamente, y la operación dura milisegundos.
const zoomQueue = new Map<string, Promise<unknown>>();

export function serializePerSession<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const prev = zoomQueue.get(session) ?? Promise.resolve();
  const result = prev.then(fn);
  // `settled` nunca rechaza: es lo que evita que una op fallida envenene la cadena y deje esa
  // sesión sin zoom hasta reiniciar el server.
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  zoomQueue.set(session, settled);
  void settled.then(() => {
    // Sólo se borra si nadie encoló después; si no, se filtraría una entrada por sesión muerta.
    if (zoomQueue.get(session) === settled) zoomQueue.delete(session);
  });
  return result;
}

/** Lee el estado de zoom de la ventana. null si no se pudo (sesión/pane muerto). */
export async function readZoomState(target: string): Promise<ZoomState | null> {
  try {
    const { stdout } = await pexec("tmux", tmuxArgs(
      "display-message", "-p", "-t", target, "#{window_zoomed_flag} #{pane_id}",
    ));
    return parseZoomState(stdout);
  } catch {
    return null;
  }
}

/**
 * Aplica el zoom y VERIFICA que quedó aplicado. A diferencia de las opciones cosméticas del
 * arranque, aquí NO se usa `tmuxOptional`: ese helper traga errores en silencio, y aquí el comando
 * ES la feature. Serializado por sesión (§ zoomQueue) y verificado por relectura — la cola sólo
 * excluye a este server, no al operador tecleando `C-b z` dentro del iframe.
 */
export async function applyZoom(
  session: string,
  target: string | null,
  driverPane: string
): Promise<ZoomOutcome> {
  return serializePerSession(session, async () => {
    // Sin el estado previo no se puede decidir si `-Z` zoomea o des-zoomea: no se ejecuta nada.
    const before = await readZoomState(session);
    if (!before) return "unreadable";
    const plan = zoomPlan(before, target, driverPane);
    if (plan.length === 0) return "noop";
    try {
      for (const args of plan) await pexec("tmux", tmuxArgs(...args));
    } catch (e) {
      console.warn(`[claude-cowork] zoom falló (${session}): ${(e as Error).message}`);
      return "failed";
    }
    return zoomOutcome(plan, await readZoomState(session), target);
  });
}

// Chrome que SÓLO existe mientras claude está pintando su TUI. Fragmentos cortos a propósito:
// en el layout 2×2 los panes son angostos y el footer se trunca ("esc to…"), que es el mismo
// modo de falla que obligó al skill a dejar de raspar el pane (SKILL.md v6→v7).
const CLAUDE_CHROME = /esc to|for shortcuts|bypass permissi|auto mode on|accept edits on|plan mode on/i;
// Banner de modelo — el criterio que el propio skill usa para saber si claude ya arrancó.
const CLAUDE_MODEL = /\b(opus|sonnet|haiku|claude max)\b/i;
// Marco de la caja de input de la TUI (un shell no dibuja cajas).
const BOX_LINE = /^[╭╮╰╯│─┌┐└┘├┤]{8,}$/;

// Cuántas líneas del final se consideran "la pantalla actual". Mismo motivo que
// PRESSURE_RECENT_LINES: el scrollback viejo no debe producir falsos positivos.
const CLAUDE_RECENT_LINES = 40;

const isChrome = (l: string): boolean => CLAUDE_CHROME.test(l) || BOX_LINE.test(l) || CLAUDE_MODEL.test(l);

/**
 * ¿El pane sigue corriendo claude, o cayó a un shell desnudo (el driver murió)?
 *
 * Se detecta en POSITIVO (hay chrome de claude), no por ausencia: reconocer "esto es un shell"
 * por la forma del prompt es frágil porque PS1 es arbitrario (starship, git-prompt, emojis).
 *
 * PERO no basta con que el chrome APAREZCA en la captura: cuando el proceso claude muere sin
 * limpiar la pantalla (el patrón de crash más común — casi ningún CLI hace clear al salir), su
 * último frame se queda visible y el shell escribe su prompt DEBAJO. Verificado en vivo: un
 * `kill -9` al claude del pane dejaba `claudeAlive` en true indefinidamente, y sólo pasaba a
 * false al correr `clear` — es decir, la caída no se detectaba nunca en el caso real.
 *
 * El discriminador correcto es POSICIONAL: la TUI de claude mantiene su caja de input clavada
 * como lo ÚLTIMO de la pantalla. Si hay contenido DESPUÉS del último chrome (un prompt de
 * shell, la salida de un comando), entonces claude ya no maneja el pane, por muy visible que
 * siga su frame anterior. Acotar a las últimas líneas no alcanzaría: el chrome rancio queda
 * inmediatamente encima del prompt nuevo, dentro de cualquier ventana razonable.
 */
export function claudeAlive(pane: string): boolean {
  const lines = (pane ?? "").split("\n").slice(-CLAUDE_RECENT_LINES).map((l) => l.trim());
  let lastContent = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]) {
      lastContent = i;
      break;
    }
  }
  if (lastContent < 0) return false;      // pane vacío
  if (!isChrome(lines[lastContent])) return false; // algo más escribió lo último → claude no manda
  return true;
}

// ---- pane interpretation (same heuristic as the tmux-worker-loop skill) ----

/**
 * The worker is busy while claude shows its "esc to interrupt" footer.
 *
 * Se acepta TAMBIÉN la forma truncada `(8s · esc to…`: en el layout 2×2 los panes son angostos y el
 * footer se corta — el mismo modo de falla que obligó a claudeAlive a matchear fragmentos. Con sólo
 * la cadena completa, un pane que trabaja se leía como idle, y eso no es cosmético: `sendWhenReady`
 * y el relay del engine usan isBusy justamente para NO escribir a mitad de turno.
 *
 * El timer entre paréntesis es lo que desambigua (el footer idle no lo tiene), así que no basta con
 * buscar "esc to" suelto: es chrome válido de claude en reposo ("esc to clear", menús) y contarlo
 * como ocupado congelaría el reloj de atasco de un pane parado de verdad.
 *
 * El formato observado del timer es `(Ns ·` — es el que usa el propio watcher del skill
 * (`skills/tmux-worker-loop/watch.sh:71`, documentado en SKILL.md:176), derivado de uso real. Se
 * acepta ADEMÁS un segundo grupo (`(1m 12s ·`) por si el timer pasa a minutos: no cuesta nada y
 * cierra el hueco antes de que aparezca.
 *
 * LÍMITES CONOCIDOS (deliberados, no descuidos):
 *  - Si el pane es tan angosto que corta ANTES del "esc to", no queda señal y se lee idle.
 *  - Un timer con un formato distinto a `(<n><unidad>[ <n><unidad>] ·` tampoco matchearía.
 * En ambos casos el fallo es hacia "idle", que es el lado seguro para claudeAlive pero NO para
 * sendWhenReady: por eso el envío verifica después, en vez de confiar sólo en esto.
 */
// Claude Code actual reemplazó "esc to interrupt" por un spinner con verbo y elipsis. Se exige
// timer dentro del paréntesis para no tratar una línea de conversación con `…` como actividad.
const BUSY_FOOTER = /esc to interrupt|\(\d+[a-z]*(?:\s+\d+[a-z]*)?\s*·\s*esc to|[·✻✢⏺*]\s+[^\n(]+…\s*\(\d+[a-z]*(?:\s+\d+[a-z]*)?\s*·/i;

export function isBusy(pane: string): boolean {
  return BUSY_FOOTER.test(pane);
}

/**
 * Estado de UN pane hermano de la ventana driver, para la lista por pane de la vista ⌘ Sessions.
 * PURA (testeable sin tmux), como el resto de heurísticas de este archivo.
 *
 * NO se reusa `driverHealth` por pane, y la diferencia es de fondo: aquél modela "el driver que ya
 * arrancó se murió" (con latch de arranque e histéresis por worker). Aquí un pane SIN claude es lo
 * NORMAL — review y verify nacen como shells desnudos y el driver los arranca sólo cuando los
 * necesita (provisioned-panes.md §2'). Llamarlos "caídos" sería un falso positivo durante casi todo
 * el ciclo, y sugeriría la acción contraria a la correcta (esperar).
 *
 * `null` = no hubo observación (la captura falló ⇒ el pane ya no existe). Mismo criterio que
 * applyDriverHealth: "no pude leer" nunca se convierte en una conclusión sobre el contenido, y por
 * eso un pane vacío ("") es un shell leído correctamente, no un pane muerto.
 */
export type PaneStatus = "working" | "idle" | "shell" | "gone";

export function paneStatus(pane: string | null): PaneStatus {
  if (pane === null) return "gone";
  if (isBusy(pane)) return "working";
  if (claudeAlive(pane)) return "idle";
  return "shell";
}

// Lines that are claude's own UI chrome, not useful as a status hint.
const CHROME = /shift\+tab|to cycle|esc to interrupt|for shortcuts|bypass permissions|^[│╭╮╰╯─▐▝▘▛▜▙▟ ]+$/i;

/** Last meaningful (non-chrome) line, trimmed and truncated — a live status hint. */
export function lastMeaningfulLine(pane: string): string {
  const lines = pane
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !CHROME.test(l));
  const last = lines[lines.length - 1] ?? "";
  return last.replace(/\s+/g, " ").slice(0, 56);
}

// P4: how many recent lines to scan for context-pressure signals. Small, like lastMeaningfulLine,
// so a stale `/clear` banner from earlier scrollback never triggers a false positive.
const PRESSURE_RECENT_LINES = 15;
// The context-left footer ("Context left until auto-compact: N%") is ALWAYS present, so only a LOW
// percentage counts as pressure — a bare "context left" match must never fire on its own (P4a).
const CONTEXT_LEFT_THRESHOLD = 20;

/**
 * P4: detect that the worker's pane is under context pressure (auto-compact imminent / suggested
 * `/clear`). Robust to pane-width truncation (matches fragments, not one exact string) and scans
 * only the recent lines. Deliberately ignores the ever-present low-signal footer at a high
 * percentage and the `/clear` slash-menu item (both would be false positives). Returns the token
 * count when parseable, else just a note; null when there's no signal.
 */
export function parseContextPressure(pane: string): { tokens?: number; note: string } | null {
  const recent = (pane ?? "")
    .split("\n")
    .slice(-PRESSURE_RECENT_LINES)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const l of recent) {
    if (/clear conversation/i.test(l)) continue; // the /clear slash-menu item, not a warning (P4a)
    // "…/clear to save 45k tokens" — the "/clear to" prefix may be truncated off, so key on
    // "save Nk" within a context-related line. Tokens best-effort (may be cut by width).
    const m = l.match(/save (\d+) ?k\b/i);
    if (m && /clear|token|context|compact/i.test(l)) {
      return { tokens: Number(m[1]), note: `/clear para ahorrar ${m[1]}k tokens` };
    }
    if (/clear to sav/i.test(l)) return { note: "aviso de /clear (contexto alto)" }; // truncated, no number
  }

  if (recent.some((l) => /compacting conversation/i.test(l))) return { note: "compactando conversación" };

  for (const l of recent) {
    if (l.startsWith("/")) continue; // slash-menu line
    const m = l.match(/context left[^0-9]*(\d{1,3}) ?%/i) ?? l.match(/(\d{1,3}) ?% context left/i);
    if (m) {
      const pct = Number(m[1]);
      if (pct < CONTEXT_LEFT_THRESHOLD) return { note: `${pct}% de contexto restante` };
    }
  }
  return null;
}
