import { spawn } from "node:child_process";

export interface ClaudePOptions { timeoutMs?: number; maxBytes?: number; command?: string; args?: string[] }

/** `claude -p` con el prompt por STDIN (evita E2BIG). timeout + cota de salida. */
export function runClaudeP(input: string, opts: ClaudePOptions = {}): Promise<string> {
  const { timeoutMs = 120_000, maxBytes = 4 << 20, command = "claude", args = ["-p"] } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => done(() => { child.kill("SIGTERM"); reject(new Error("claude -p excedió el tiempo límite")); }), timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > maxBytes) done(() => { child.kill("SIGTERM"); reject(new Error("claude -p excedió el límite de salida")); }); });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => done(() => reject(e)));
    child.on("close", (code) => done(() => code !== 0 ? reject(new Error(`claude -p salió con código ${code}: ${stderr.trim().slice(0, 200)}`)) : resolve(stdout)));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
