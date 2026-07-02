import { spawn, type ChildProcess } from "node:child_process";

/**
 * One ttyd process per tmux session, serving a writable web terminal bound to
 * localhost (IPv4). The dashboard embeds it (iframe) for full interactivity.
 */
const procs = new Map<string, { proc: ChildProcess; port: number }>();
let nextPort = 7781;

export function startTtyd(session: string): number {
  const existing = procs.get(session);
  if (existing) return existing.port;
  const port = nextPort++;
  const proc = spawn(
    "ttyd",
    ["-p", String(port), "-i", "127.0.0.1", "-W", "-t", "fontSize=13", "tmux", "attach", "-t", session],
    { stdio: "ignore" }
  );
  proc.on("error", (e) => {
    console.warn(`[claude-cowork] ttyd no arrancó (${e.message}). ¿Instalado? brew install ttyd`);
    procs.delete(session);
  });
  proc.on("exit", () => procs.delete(session));
  procs.set(session, { proc, port });
  return port;
}

export function stopTtyd(session: string): void {
  const e = procs.get(session);
  if (e) {
    e.proc.kill();
    procs.delete(session);
  }
}

export function stopAllTtyd(): void {
  for (const { proc } of procs.values()) proc.kill();
  procs.clear();
}

for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(sig, stopAllTtyd);
}
