import { spawn } from "node:child_process";
import type { CommandSpec } from "./model.js";

/**
 * Ejecución de UN comando declarado: `program + args`, `shell: false`, entorno exactamente el
 * recibido (nunca `process.env` heredado), `detached` para poder matar el grupo entero en
 * timeout/cancelación. stdout/stderr se acumulan acotados (cola) para que un runner ruidoso no
 * llene memoria. No sabe nada de repos, perfiles ni artefactos.
 */

export type RunOutcome = "exited" | "timeout" | "cancelled" | "error";

export interface RunCommandOptions {
  command: CommandSpec;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Bytes crudos máximos retenidos por stream (cola). */
  maxOutputBytes?: number;
  /** Gracia entre SIGTERM y SIGKILL. */
  killGraceMs?: number;
}

export interface RunCommandResult {
  outcome: RunOutcome;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
}

export interface RunCommandHandle {
  done: Promise<RunCommandResult>;
  cancel(): void;
}

const DEFAULT_MAX_OUTPUT = 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 3_000;

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly max: number) {}
  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    if (this.size > this.max) {
      const only = this.chunks[0];
      this.chunks = [only.subarray(only.length - this.max)];
      this.size = this.max;
    }
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // ya murió
    }
  }
}

export function runCommand(options: RunCommandOptions): RunCommandHandle {
  const startedAt = new Date().toISOString();
  const stdout = new TailBuffer(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
  const stderr = new TailBuffer(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
  let outcome: RunOutcome = "exited";
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let child: ReturnType<typeof spawn> | undefined;

  const terminate = (why: "timeout" | "cancelled") => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (outcome === "exited") outcome = why;
    killGroup(child.pid!, "SIGTERM");
    killTimer = setTimeout(() => child && killGroup(child.pid!, "SIGKILL"), options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
  };

  const done = new Promise<RunCommandResult>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ outcome, exitCode, signal, stdout: stdout.toString(), stderr: stderr.toString(), startedAt, finishedAt: new Date().toISOString() });
    };
    try {
      child = spawn(options.command.program, options.command.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      outcome = "error";
      stderr.push(Buffer.from(String((error as Error).message)));
      finish(null, null);
      return;
    }
    child.stdout!.on("data", (c: Buffer) => stdout.push(c));
    child.stderr!.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", (error: NodeJS.ErrnoException) => {
      outcome = "error";
      stderr.push(Buffer.from(`${error.code ?? "ERR"}: ${error.message}\n`));
      // Con ENOENT no llega 'close' fiable en todas las versiones; resolvemos aquí.
      if (error.code === "ENOENT" || error.code === "EACCES") finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    timeoutTimer = setTimeout(() => terminate("timeout"), options.timeoutMs);
  });

  return { done, cancel: () => terminate("cancelled") };
}
