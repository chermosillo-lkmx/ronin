import { spawn } from "node:child_process";

/**
 * P2: run a stage's `verifyCmd` (a pass/fail exit-code check) in the worker's cwd. Default-deny:
 * ANY exception, spawn failure, missing cwd, or timeout resolves to `ok:false` — a verify never
 * produces a false-green. On timeout the whole PROCESS GROUP receives SIGTERM and, after a grace
 * period, SIGKILL if it is still alive, so teardown can run without leaking children. Never throws.
 */
export interface VerifyResult {
  ok: boolean;
  code: number | null;
  output: string;
  /** Se cortó por timeout; `output` termina además en `[timeout]` (fuera del recorte). */
  timedOut?: boolean;
}

/**
 * P2 gate outcome: pass → passed (advancement allowed). Fail with retries left → pending
 * (retry). Fail with none left → failed (held forever — no false-green). Pure/testable.
 */
export function verifyOutcome(
  ok: boolean,
  prevAttempts: number,
  maxRetries: number
): { attempts: number; status: "passed" | "pending" | "failed" } {
  if (ok) return { attempts: prevAttempts, status: "passed" };
  const attempts = prevAttempts + 1;
  return { attempts, status: attempts >= maxRetries ? "failed" : "pending" };
}

/**
 * P2 pacing: whether to run a gate now, paced by the worker's busy/idle cycle.
 * - busy: never run mid-work; ARM a retry if the worker already had an attempt (it's fixing).
 * - idle: run — except a RETRY (attempts>0) waits until armed, so a restart with empty in-memory
 *   arming (attempts:1, armed:false) SKIPS until the worker goes busy again (no double-run / no
 *   burning through maxRetries while idle).
 */
export function verifyRunDecision(busy: boolean, attempts: number, armed: boolean): "run" | "arm" | "skip" {
  if (busy) return attempts > 0 ? "arm" : "skip";
  if (attempts > 0 && !armed) return "skip";
  return "run";
}

const truncateOutput = (s: string): string => (s.length > 8000 ? s.slice(0, 8000) + "\n…(truncado)" : s);
export const DEFAULT_KILL_GRACE_MS = 60_000;

/** `env` se mezcla SOBRE `process.env` (no lo reemplaza): el comando conserva PATH y compañía. */
export function runVerify(
  cmd: string,
  cwd: string,
  timeoutMs = 120000,
  env: Record<string, string> = {},
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  /** Pid del líder del grupo al arrancar y al terminar (para atribuir CPU del gate a su sesión). */
  hooks: { onSpawn?(pid: number): void; onExit?(pid: number): void } = {},
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const finish = (r: VerifyResult) => {
      if (done) return;
      done = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Tras un timeout NO se cancela el SIGKILL: el líder puede salir durante la gracia y dejar
      // nietos del grupo vivos (sin tener los pipes); el temporizador comprueba el grupo y lo remata.
      // La marca de timeout va DESPUÉS del recorte: con salida larga, recortar primero la borraba.
      resolve({ ...r, output: truncateOutput(r.output) + (r.timedOut ? "\n[timeout]" : "") });
    };

    let child;
    try {
      // detached:true → the shell becomes a process-group leader; kill(-pid) reaps its children.
      child = spawn(cmd, { shell: true, cwd, detached: true, env: { ...process.env, ...env } });
    } catch (e) {
      return finish({ ok: false, code: null, output: String(e) });
    }
    const spawnedPid = child.pid;
    if (spawnedPid) {
      try {
        hooks.onSpawn?.(spawnedPid);
      } catch {
        /* medir nunca rompe el gate */
      }
      child.once("close", () => {
        try {
          hooks.onExit?.(spawnedPid);
        } catch {
          /* idem */
        }
      });
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const killTimer = setTimeout(() => {
        try {
          if (child.pid) {
            process.kill(-child.pid, 0);
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          /* el grupo ya terminó durante la gracia */
        }
      }, killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);

    // Cap accumulation (not just the final truncate) so a chatty command before a 120s timeout
    // can't grow `out` unboundedly in memory.
    const append = (d: Buffer) => {
      if (out.length < 16000) out += d.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      finish({ ok: false, code: null, output: out + String(e), ...(timedOut ? { timedOut: true } : {}) }); // e.g. cwd missing / spawn failure
    });
    child.on("close", (code) => {
      finish(timedOut
        ? { ok: false, code, output: out, timedOut: true }
        : { ok: code === 0, code, output: out });
    });
  });
}
