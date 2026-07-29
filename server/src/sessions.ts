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

/** `#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}` */
export function parseSessionList(stdout: string): Omit<TmuxSessionInfo, "kind" | "panes">[] {
  const out: Omit<TmuxSessionInfo, "kind" | "panes">[] = [];
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [name, windows, created, attached] = line.split("\t");
    // `name` puede ser "0": tmux nombra así las sesiones sin nombre y en esta máquina hay 12
    // con nombre entero. Comparar contra undefined/"" explícitamente, nunca con falsy.
    if (name === undefined || name === "") continue;
    out.push({
      name,
      windows: Number(windows) || 0,
      createdAt: (Number(created) || 0) * 1000, // tmux da segundos
      attached: attached === "1",
    });
  }
  return out;
}

/** `#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_title}\t#{@cowork-role}\t#{pane_active}` */
export function parsePaneList(stdout: string): Map<string, TmuxPaneInfo[]> {
  const m = new Map<string, TmuxPaneInfo[]>();
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [session, win, id, command, title, role, active] = line.split("\t");
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
 * Un nombre de sesión sólo se convierte en ruta si es inofensivo. `cycleDirForSession`
 * (stages.ts:15) es concatenación cruda y lo comparten `ensureCycleDir` y `removeCycleDir`
 * (que hace `rmSync -rf`). tmux hoy no deja meter `.` ni `:` en un nombre, así que esto es
 * defensa en profundidad — pero F1 es la primera vez que un nombre AJENO llega a ese helper, y
 * F2 (adopción) lo va a llevar a un camino de escritura. Un nombre raro se trata como ajeno,
 * que es el resultado seguro.
 */
export function isSafeSessionName(name: string): boolean {
  return /^[A-Za-z0-9._@-]+$/.test(name) && !name.includes("..");
}

/**
 * Gestionada = prefijo `cowork-` **y** cycle dir existente. Las dos condiciones, porque el
 * prefijo es sólo una convención de nombre que el operador puede reproducir a mano: sin
 * sentinels no hay etapas que mostrar.
 *
 * DIVERGENCIA CONSCIENTE con el engine: `engine.ts:1553` y `:1667` adoptan como worker CUALQUIER
 * sesión `cowork-*`, sin mirar el cycle dir. Hoy, en esta máquina, eso son 4 sesiones
 * (`cowork-adhoc-mrp6oimn`, `cowork-adhoc-mrpcc2xq`, `cowork-custom-mrjzj2dw`,
 * `cowork-pr-mrp7qrws`) que el tablero muestra como workers y esta pantalla lista como ajenas.
 * Se elige el criterio estricto porque aquí "gestionada" es lo que habilitará acciones de
 * escritura en F2, y un cycle dir ausente significa que no hay nada que dirigir. Unificar los
 * dos criterios es trabajo de F2, no de F1.
 */
export function classifySession(name: string, hasCycleDir: boolean): "managed" | "foreign" {
  return name.startsWith("cowork-") && hasCycleDir ? "managed" : "foreign";
}
