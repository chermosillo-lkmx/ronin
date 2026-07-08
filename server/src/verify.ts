import { spawn } from "node:child_process";

/**
 * P2: run a stage's `verifyCmd` (a pass/fail exit-code check) in the worker's cwd. Default-deny:
 * ANY exception, spawn failure, missing cwd, or timeout resolves to `ok:false` — a verify never
 * produces a false-green. On timeout the whole PROCESS GROUP is killed (detached), so a dev
 * server / test runner that forks children doesn't leak. Never throws.
 */
export interface VerifyResult {
  ok: boolean;
  code: number | null;
  output: string;
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

export function runVerify(cmd: string, cwd: string, timeoutMs = 120000): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (r: VerifyResult) => {
      if (done) return;
      done = true;
      resolve({ ...r, output: truncateOutput(r.output) });
    };

    let child;
    try {
      // detached:true → the shell becomes a process-group leader; kill(-pid) reaps its children.
      child = spawn(cmd, { shell: true, cwd, detached: true });
    } catch (e) {
      return finish({ ok: false, code: null, output: String(e) });
    }

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL"); // kill the whole group (D2)
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: null, output: out + "\n[timeout]" });
    }, timeoutMs);

    // Cap accumulation (not just the final truncate) so a chatty command before a 120s timeout
    // can't grow `out` unboundedly in memory.
    const append = (d: Buffer) => {
      if (out.length < 16000) out += d.toString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, code: null, output: out + String(e) }); // e.g. cwd missing / spawn failure
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code, output: out });
    });
  });
}
