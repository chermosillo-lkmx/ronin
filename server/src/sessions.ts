import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeSessionName } from "./session-name.js";
import { cycleDirForSession } from "./stages.js";
import {
  listPanesRawResult,
  listSessionsRawResult,
  type TmuxDiagnostic,
  type TmuxRawResult,
} from "./tmux.js";
import type { TmuxPaneInfo, TmuxSessionInfo } from "./types.js";

/**
 * Inventario tmux completo: gestionadas por Ronin + ajenas al operador.
 *
 * Este módulo NO ejecuta nada. El `execFile("tmux", …)` vive en tmux.ts, que es el dueño de esa
 * herramienta en el repo (igual que worktree.ts lo es de git). Aquí sólo se parsea y se compone,
 * para poder probarlo con capturas reales sin arrancar un servidor tmux — el mismo reparto que
 * `readPaneRoles` (exec) / `parsePaneRoles` (puro).
 *
 * Los campos se piden separados por TAB: un `pane_title` casi siempre lleva espacios y un
 * `session_name` puede llevarlos. Se comprobó que tmux filtra un TAB inyectado en cualquiera de
 * los dos, así que el delimitador no se puede romper desde fuera.
 */

/**
 * `#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}`
 *
 * A diferencia de `parsePaneList` (que DESCARTA una línea sin `%N` en vez de inventar un
 * target), una línea de sesión sin TABs suficientes se conserva como entrada degradada
 * (`windows: 0, createdAt: 0, attached: false`) en vez de descartarse. No es inconsistencia: acá
 * `name` es el único campo que siempre puede rescatarse solo (es lo primero antes del primer
 * TAB), así que degradar preserva "una sesión existe con este nombre" incluso si el resto de
 * campos se perdió — mientras que en panes, sin `%N` no hay identidad estable que rescatar.
 */
export function parseSessionList(stdout: string): Omit<TmuxSessionInfo, "kind" | "panes">[] {
  const out: Omit<TmuxSessionInfo, "kind" | "panes">[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [name, windows, created, attached, adopted] = splitInventoryFields(line);
    // `name` puede ser "0": tmux nombra así las sesiones sin nombre y en esta máquina hay 12
    // con nombre entero. `name` es siempre un string, así que `if (!name)` sería equivalente
    // aquí — la comparación explícita es para que una simplificación futura a `!Number(name)` o
    // `!+name` (que sí convertiría "0" en 0 y tiraría la sesión) se vea como el error que es.
    if (name === undefined || name === "") continue;
    out.push({
      name,
      windows: Number(windows) || 0,
      createdAt: (Number(created) || 0) * 1000, // tmux da segundos
      attached: attached === "1",
      // 5º campo (T3): #{@cowork-adopted}. Ausente (línea vieja, sin la columna) o vacío
      // (opción no seteada) son el mismo "no adoptada" — viaja GRATIS en el list-sessions
      // que ya se ejecuta (coste tmux cero).
      adopted: Boolean(adopted),
    });
  }
  return out;
}

/** `#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}\t#{@cowork-role}\t#{pane_active}` */
export function parsePaneList(stdout: string): Map<string, TmuxPaneInfo[]> {
  const m = new Map<string, TmuxPaneInfo[]>();
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const fields = splitInventoryFields(line);
    const colonFormat = !line.includes("\t") && !line.includes("\\t") && line.includes(":");
    const [session, win, id, command, title, role, active] = colonFormat
      ? [fields[0], fields[1], fields[2], fields[5], fields.slice(6).join(":"), fields[4], fields[3]]
      : fields;
    // Se exige que el id empiece por `%`: es la identidad estable del pane. Si la línea no la
    // trae, algo se desalineó, y materializarla daría un target inválido que alguien acabaría
    // usando como `-t`.
    if (session === undefined || !id?.startsWith("%")) continue;
    const pane: TmuxPaneInfo = {
      id,
      windowIndex: Number(win) || 0,
      command: command ?? "",
      title: title ?? "",
      role: role ? role : null, // "" (opción no seteada) → null, no cadena vacía
      active: active === "1",
    };
    const list = m.get(session);
    if (list) list.push(pane);
    else m.set(session, [pane]);
  }
  return m;
}

/**
 * New inventory commands use `:`. Existing captured fixtures and older servers may still have
 * a real tab or printable `\\t`, so both remain readable during the transition.
 */
function splitInventoryFields(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  if (line.includes("\\t")) return line.split("\\t");
  return line.split(":");
}

// Movido a session-name.ts (T0.3, cierra P5): sin dependencias, para que stages.ts pueda
// importarlo sin crear un ciclo con sessions.ts (que ya importa cycleDirForSession de stages.ts).
// Se re-exporta para no romper a quien lo importaba de aquí.
export { isSafeSessionName };

/**
 * Gestionada = (prefijo `cowork-` **o** marca de adopción `@cowork-adopted`) **y** cycle dir
 * existente. Las dos condiciones de nombre son alternativas (T3: una sesión adoptada nunca
 * tuvo el prefijo), pero el cycle dir sigue siendo OBLIGATORIO en los dos casos: una adopción
 * sin cycle dir es media adopción y debe leerse como ajena, que es el resultado seguro — igual
 * que una sesión `cowork-*` sin sentinels no puede anunciarse como gestionada.
 *
 * DIVERGENCIA CONSCIENTE con el engine, que se CIERRA sin unificar los criterios (T3):
 * `engine.ts:1557` (`cowork-*` suelto) responde "¿es de Ronin para re-adjuntarla?" — endurecerlo
 * dejaría huérfanos workers vivos, y `reconcileLeakedWorktrees` (`engine.ts:1671`) usa el MISMO
 * filtro para decidir qué worktrees están muertos, así que estrecharlo borraría worktrees de
 * workers vivos. `classifySession` (aquí) responde "¿puede la UI escribir aquí?" — el criterio
 * del KB (`nocturne:100-101`). Son preguntas distintas; no hace falta que compartan regla.
 */
export function classifySession(name: string, hasCycleDir: boolean, isAdopted: boolean): "managed" | "foreign" {
  return (name.startsWith("cowork-") || isAdopted) && hasCycleDir ? "managed" : "foreign";
}

/**
 * Compone el inventario. `list-sessions` es la autoridad sobre qué sesiones existen: un pane
 * cuya sesión no aparezca ahí se descarta en vez de materializar una sesión fantasma (las dos
 * llamadas a tmux no son atómicas y una sesión puede morir entre ambas).
 *
 * `hasCycleDir` se inyecta para poder probar la composición sin tocar el disco.
 */
export function buildInventory(
  sessionsOut: string,
  panesOut: string,
  hasCycleDir: (name: string) => boolean
): TmuxSessionInfo[] {
  const panes = parsePaneList(panesOut);
  return parseSessionList(sessionsOut).map((s) => ({
    ...s,
    // Un nombre inseguro ni siquiera se convierte en ruta: se clasifica como ajena, que es el
    // resultado seguro. Ver isSafeSessionName.
    kind: classifySession(s.name, isSafeSessionName(s.name) && hasCycleDir(s.name), s.adopted),
    panes: panes.get(s.name) ?? [],
  }));
}

/** Añade metadata de lanzamiento sin dar acceso a `launch.json` a sesiones ajenas. */
export function withLaunchRequests(sessions: TmuxSessionInfo[], readRequest: (name: string) => string | undefined): TmuxSessionInfo[] {
  return sessions.map((session) => session.kind === "managed"
    ? { ...session, request: readRequest(session.name) }
    : session);
}

function requestFromLaunch(name: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(cycleDirForSession(name), "launch.json"), "utf8"));
    return typeof raw?.request === "string" && raw.request.trim() ? raw.request : undefined;
  } catch {
    return undefined;
  }
}

/** Result returned by the tmux inventory endpoint.
 *
 * An empty `sessions` array with a null diagnostic is the one and only representation of a
 * healthy tmux server with no sessions.  Keeping the diagnostic alongside the useful partial
 * inventory prevents the desktop from quietly turning a socket/PATH failure into that state.
 */
export interface TmuxInventoryResult {
  sessions: TmuxSessionInfo[];
  diagnostic: TmuxDiagnostic | null;
}

/** Pure boundary between the tmux commands and the API contract; convenient for fixtures. */
export function inventoryFromRaw(
  sessionsResult: TmuxRawResult,
  panesResult: TmuxRawResult,
  hasCycleDir: (name: string) => boolean,
): TmuxInventoryResult {
  if (sessionsResult.diagnostic) return { sessions: [], diagnostic: sessionsResult.diagnostic };
  if (!sessionsResult.output.trim()) return { sessions: [], diagnostic: panesResult.diagnostic };
  return {
    sessions: buildInventory(sessionsResult.output, panesResult.output, hasCycleDir),
    diagnostic: panesResult.diagnostic,
  };
}

/**
 * Inventario vivo. Todo lo que ejecuta es `list-sessions` y `list-panes -a`, ambos de sólo
 * lectura sobre el servidor tmux entero: es lo que permite listar las sesiones ajenas del
 * operador sin ningún riesgo. F1 lee sesiones ajenas; no les escribe.
 *
 * Si `list-panes` falla se devuelve el inventario sin panes en vez de nada: nombres, ventanas y
 * `kind` siguen siendo útiles.
 *
 * OJO con los cycle dirs rancios: `removeCycleDir` sólo corre en un stop limpio (engine.ts:1395),
 * así que un crash deja el dir atrás. Si un nombre de sesión se reutilizara, el dir muerto
 * promovería una sesión a "gestionada". Los sufijos `Date.now().toString(36)` lo hacen
 * improbable; no se limpia aquí porque borrar dirs de otro es exactamente lo que no toca hacer.
 */
export async function listAllSessions(): Promise<TmuxSessionInfo[]> {
  return (await readTmuxInventory()).sessions;
}

/** Read the live inventory without erasing a tmux access failure. */
export async function readTmuxInventory(): Promise<TmuxInventoryResult> {
  const [sessionsResult, panesResult] = await Promise.all([listSessionsRawResult(), listPanesRawResult()]);
  const inventory = inventoryFromRaw(sessionsResult, panesResult, (name) => existsSync(cycleDirForSession(name)));
  return { ...inventory, sessions: withLaunchRequests(inventory.sessions, requestFromLaunch) };
}
