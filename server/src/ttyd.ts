import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

/**
 * One ttyd process per tmux session, serving a writable web terminal bound to
 * localhost (IPv4). The dashboard embeds it (iframe) for full interactivity.
 */
const pexecFile = promisify(execFile);
let ttydAvailable: Promise<boolean> | undefined;

async function hasTtyd(): Promise<boolean> {
  ttydAvailable ??= pexecFile("ttyd", ["--version"]).then(() => true, () => false);
  return ttydAvailable;
}

export function createTtydManager(deps: { hasTtyd?: () => Promise<boolean>; spawn?: typeof spawn } = {}) {
  const procs = new Map<string, { proc: ChildProcess; port: number }>();
  const starts = new Map<string, Promise<number | null>>();
  let nextPort = 7781;
  const available = deps.hasTtyd ?? hasTtyd;
  const launch = deps.spawn ?? spawn;

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
        "ttyd",
        ["-p", String(port), "-i", "127.0.0.1", "-W", "-t", "fontSize=13", "tmux", "attach", "-t", session],
        { stdio: "ignore" }
      );
      return new Promise<number | null>((resolve) => {
        proc.once("spawn", () => {
          procs.set(session, { proc, port });
          resolve(port);
        });
        proc.once("error", (e) => {
          console.warn(`[claude-cowork] ttyd no arrancó (${e.message}). ¿Instalado? brew install ttyd`);
          procs.delete(session);
          resolve(null);
        });
        proc.on("exit", () => procs.delete(session));
      });
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
