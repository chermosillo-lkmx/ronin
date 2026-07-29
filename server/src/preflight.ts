import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PreflightCheck } from "./types.js";

const pexec = promisify(execFile);

/**
 * Comprobaciones de entorno. Cada check es una entrada del registro (`BINS`), no una rama de un
 * `if` gigante: F6 (Electron) añade `node-pty` y `firma/notarizado` sin tocar la pantalla ni
 * `runPreflight`.
 *
 * La clasificación va aparte de la ejecución para poder probarla sin depender de qué tenga
 * instalado la máquina que corre los tests — el mismo reparto que `parsePaneRoles` en tmux.ts.
 *
 * Este módulo tiene su propio `pexec` y eso NO viola la regla de "un módulo es dueño de una
 * herramienta externa" (la que hace que `list-sessions`/`list-panes` vivan en tmux.ts): preflight
 * no controla ninguna herramienta ni depende de su semántica — sólo le pregunta la versión a un
 * binario cualquiera, y mañana le preguntará a `node-pty` y al notarizador. Es un sondeador
 * genérico, no un cliente de tmux.
 */

/** Clasifica un binario: ausente = fail, presente sin versión = warn, con versión = ok. */
export function binCheck(
  key: string,
  label: string,
  path: string,
  version: string,
  note: string
): PreflightCheck {
  if (!path) return { key, label, level: "fail", detail: "no encontrado", note };
  if (!version) {
    return { key, label, level: "warn", detail: `${path} · versión desconocida`, note };
  }
  return { key, label, level: "ok", detail: `${path} · ${version}` };
}

/** El PATH heredado. Vacío es el modo de fallo clásico de una app lanzada desde Finder. */
export function pathCheck(entries: string[]): PreflightCheck {
  if (entries.length === 0) {
    return {
      key: "path",
      label: "PATH heredado",
      level: "fail",
      detail: "vacío",
      note: "Resolver el env del login shell antes de ejecutar tmux/claude/git.",
    };
  }
  return { key: "path", label: "PATH heredado", level: "ok", detail: `${entries.length} entradas` };
}

/**
 * Ruta absoluta del binario, o "" si no está. Se recorre el PATH a mano en vez de invocar
 * `command -v` con `shell: true`: el nombre acabaría concatenado en una cadena de shell y este
 * módulo lo ejecuta después — el camino que `models.ts` cierra a propósito con `sanitizeModel`.
 * Aquí los nombres son constantes del módulo, pero la forma segura no cuesta más y no invita a
 * que la siguiente fase le pase un nombre de fuera.
 *
 * `isFile()` NO es opcional: `accessSync(X_OK)` sobre un DIRECTORIO significa "atravesable" y
 * pasa. Sin esta comprobación, un `<dir>/tmux` que fuera una carpeta daría `level:"ok"` con la
 * ruta de la carpeta y la versión del tmux de verdad que `execvp` encontraría más adelante en
 * el PATH: un check en verde describiendo dos binarios distintos.
 */
function which(bin: string): string {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const full = join(dir, bin);
    try {
      if (!statSync(full).isFile()) continue;
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // siguiente entrada del PATH
    }
  }
  return "";
}

/**
 * Primera cosa parecida a una versión en la salida de `<path> <flag>`. Recibe la RUTA ABSOLUTA
 * que ya resolvió `which`, nunca el nombre: resolver el PATH dos veces puede acabar consultando
 * un binario distinto del que se reporta en `detail`.
 *
 * `killSignal: SIGKILL` porque el `timeout` de execFile manda SIGTERM y la promesa no se
 * resuelve hasta que los pipes de stdio cierran: un CLI que deje un hijo heredando stdout
 * mantendría colgado el GET más allá de los 5 s. `maxBuffer` acotado por lo mismo — un
 * `--version` charlatán daría ENOBUFS, que aquí degrada limpio a warn.
 */
async function versionOf(path: string, flag: string): Promise<string> {
  if (!path) return "";
  try {
    const { stdout } = await pexec(path, [flag], {
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    });
    return stdout.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "";
  } catch {
    return "";
  }
}

const BINS: { key: string; label: string; bin: string; flag: string; note: string }[] = [
  { key: "tmux", label: "tmux", bin: "tmux", flag: "-V", note: "brew install tmux" },
  { key: "claude", label: "claude CLI", bin: "claude", flag: "--version", note: "Instalar el CLI de Claude Code" },
  { key: "codex", label: "codex CLI", bin: "codex", flag: "--version", note: "brew install codex — la review adversarial lo necesita" },
  { key: "ttyd", label: "ttyd", bin: "ttyd", flag: "--version", note: "brew install ttyd — la terminal embebida y el modo Driver lo necesitan" },
];

/**
 * OJO con una divergencia deliberada: `which` mira SÓLO `process.env.PATH`, mientras que el
 * resto del server (p. ej. `tmuxAvailable`, tmux.ts:10) invoca los binarios por nombre y deja
 * que `execvp` caiga a su `/usr/bin:/bin` por defecto. Con un PATH vacío esto reportará
 * `tmux: fail` mientras el engine sigue corriendo tan campante — y eso es justo lo que se
 * quiere ver: el check existe para señalar un entorno frágil, no para imitarlo.
 */
export async function runPreflight(): Promise<PreflightCheck[]> {
  const bins = await Promise.all(
    BINS.map(async (b) => {
      const path = which(b.bin);
      return binCheck(b.key, b.label, path, await versionOf(path, b.flag), b.note);
    })
  );
  return [...bins, pathCheck((process.env.PATH ?? "").split(":").filter(Boolean))];
}
