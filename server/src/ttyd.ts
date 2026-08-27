import { execFile, spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

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

export function createTtydManager(deps: { hasTtyd?: () => Promise<boolean>; spawn?: typeof spawn; waitReady?: (port: number) => Promise<boolean> } = {}) {
  const procs = new Map<string, { proc: ChildProcess; port: number }>();
  const starts = new Map<string, Promise<number | null>>();
  let nextPort = 7781;
  const available = deps.hasTtyd ?? hasTtyd;
  const launch = deps.spawn ?? spawn;
  const waitReady = deps.waitReady ?? waitForPort;

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
      const port = nextPort++;
      const proc = launch(
        ttydCommand(),
        ["-p", String(port), "-i", "127.0.0.1", "-W", "-t", "fontSize=13", "tmux", "attach", "-t", session],
        { stdio: "ignore" }
      );
      const spawned = await new Promise<boolean>((resolve) => {
        proc.once("spawn", () => resolve(true));
        proc.once("error", (e) => {
          console.warn(`[claude-cowork] ttyd no arrancó (${e.message}). ¿Instalado? brew install ttyd`);
          resolve(false);
        });
      });
      if (!spawned) return null;
      proc.on("exit", () => procs.delete(session));
      if (!(await waitReady(port))) {
        console.warn(`[claude-cowork] ttyd no abrió el puerto ${port} para ${session}; se descarta el proceso`);
        proc.kill();
        return null;
      }
      procs.set(session, { proc, port });
      return port;
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
