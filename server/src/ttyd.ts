import { execFile, spawn, type ChildProcess } from "node:child_process";
import { connect, createServer } from "node:net";
import { promisify } from "node:util";
import { tmuxArgs, tmuxCommand } from "./tmux.js";

/**
 * One ttyd process per tmux session, serving a writable web terminal bound to
 * localhost (IPv4). The dashboard embeds it (iframe) for full interactivity.
 */
const pexecFile = promisify(execFile);

/** The desktop main process resolves Homebrew ttyd before launching this backend. */
export function ttydCommand(): string {
  return process.env.COWORK_TTYD_BIN?.trim() || "ttyd";
}

export function createTtydAvailability(run = pexecFile): () => Promise<boolean> {
  let ttydAvailable: Promise<boolean> | undefined;
  return async () => {
    ttydAvailable ??= run(ttydCommand(), ["--version"]).then(() => true, () => false);
    return ttydAvailable;
  };
}

const hasTtyd = createTtydAvailability();

/**
 * ttyd tarda unos ms entre `spawn` y `listen`. Si devolvemos el puerto antes, el iframe carga
 * contra un puerto cerrado y se queda en blanco hasta que el usuario lo fuerza a recargar.
 * Se sondea el puerto hasta que acepte una conexión (o se agote el plazo).
 */
export function waitForPort(port: number, timeoutMs = 5_000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

/** Comprueba que este proceso puede reservar el puerto antes de entregárselo a ttyd. */
export function reservePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => resolve(!error));
    });
  });
}

const TTYD_PORT_CANDIDATES = 10;

export function createTtydManager(deps: {
  hasTtyd?: () => Promise<boolean>;
  spawn?: typeof spawn;
  waitReady?: (port: number) => Promise<boolean>;
  reservePort?: (port: number) => Promise<boolean>;
} = {}) {
  const procs = new Map<string, { proc: ChildProcess; port: number }>();
  const starts = new Map<string, Promise<number | null>>();
  let nextPort = 7781;
  const available = deps.hasTtyd ?? hasTtyd;
  const launch = deps.spawn ?? spawn;
  const waitReady = deps.waitReady ?? waitForPort;
  const canReservePort = deps.reservePort ?? reservePort;

  async function start(session: string): Promise<number | null> {
    const existing = procs.get(session);
    if (existing) return existing.port;
    const pending = starts.get(session);
    if (pending) return pending;
    const started = (async () => {
      if (!(await available())) {
        console.warn("[claude-cowork] ttyd no está instalado. Instálalo con: brew install ttyd");
        return null;
      }
      // Cinturón y tirantes: `tmux -u` no arregla los programas dentro del pane, por eso también
      // pasamos locale; a su vez `-u` cubre clientes tmux antiguos que no detectan UTF-8 por locale.
      const env = {
        ...process.env,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "en_US.UTF-8",
      };
      for (let attempt = 0; attempt < TTYD_PORT_CANDIDATES; attempt++) {
        const port = nextPort++;
        if (!(await canReservePort(port))) continue;

        const proc = launch(
          ttydCommand(),
          ["-p", String(port), "-i", "127.0.0.1", "-W", "-t", "fontSize=13", tmuxCommand(), "-u", ...tmuxArgs("attach", "-t", session)],
          { stdio: "ignore", env }
        );
        let exited = proc.exitCode !== null && proc.exitCode !== undefined;
        proc.once("exit", () => { exited = true; });
        const spawned = await new Promise<boolean>((resolve) => {
          proc.once("spawn", () => resolve(true));
          proc.once("error", (e) => {
            console.warn(`[claude-cowork] ttyd no arrancó (${e.message}). ¿Instalado? brew install ttyd`);
            resolve(false);
          });
        });
        if (!spawned) continue;

        // waitForPort sólo confirma que *algo* escucha. Si nuestro hijo murió mientras el puerto
        // responde, ese listener es ajeno y devolverlo cruzaría terminales entre sesiones.
        const ready = await waitReady(port);
        const childExited = exited || (proc.exitCode !== null && proc.exitCode !== undefined);
        if (!ready || childExited) {
          if (!childExited) proc.kill();
          console.warn(`[claude-cowork] ttyd no quedó escuchando para ${session} en ${port}; se prueba otro puerto`);
          continue;
        }
        proc.on("exit", () => procs.delete(session));
        procs.set(session, { proc, port });
        return port;
      }
      console.warn(`[claude-cowork] ttyd no pudo reservar un puerto propio para ${session} tras ${TTYD_PORT_CANDIDATES} intentos`);
      return null;
    })();
    starts.set(session, started);
    try { return await started; } finally { starts.delete(session); }
  }

  function stop(session: string): void {
    const e = procs.get(session);
    if (e) { e.proc.kill(); procs.delete(session); }
  }

  function stopAll(): void {
    for (const { proc } of procs.values()) proc.kill();
    procs.clear();
  }

  return { start, stop, stopAll };
}

const ttyd = createTtydManager();
export const startTtyd = ttyd.start;
export const stopTtyd = ttyd.stop;
export const stopAllTtyd = ttyd.stopAll;

for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(sig, stopAllTtyd);
}
