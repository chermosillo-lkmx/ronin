import { execFile } from "node:child_process";
import { homedir } from "node:os";

const PATH_START = "__COWORK_LOGIN_PATH_START__";
const PATH_END = "__COWORK_LOGIN_PATH_END__";
const DEFAULT_TIMEOUT_MS = 2_000;

export interface MergeLoginPathInput {
  discoveredPath?: string;
  currentPath?: string;
  home: string;
}

export interface ResolveLoginPathDependencies {
  env: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
  run?: (shell: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }) => Promise<string>;
}

function pathEntries(path: string | undefined): string[] {
  return path === undefined ? [] : path.split(":");
}

/** Pure ordered union: login-shell discoveries win without discarding the Finder environment. */
export function mergeLoginPath({ discoveredPath, currentPath, home }: MergeLoginPathInput): string {
  const entries = [
    ...pathEntries(discoveredPath),
    ...pathEntries(currentPath),
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  return [...new Set(entries)].join(":");
}

function runLoginShell(shell: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(shell, args, { env: options.env, timeout: options.timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function extractPath(output: string): string | undefined {
  const start = output.lastIndexOf(PATH_START);
  if (start < 0) return undefined;
  const valueStart = start + PATH_START.length;
  const end = output.indexOf(PATH_END, valueStart);
  return end < 0 ? undefined : output.slice(valueStart, end).trim();
}

function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("COWORK_LOGIN_PATH_TIMEOUT")), timeoutMs);
    void operation.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Resolve once at startup; profile failures are intentionally non-fatal. */
export async function resolveLoginPath(deps: ResolveLoginPathDependencies): Promise<string> {
  if (deps.env.COWORK_PATH !== undefined) return deps.env.COWORK_PATH;

  const home = deps.home ?? deps.env.HOME ?? homedir();
  const fallback = mergeLoginPath({ currentPath: deps.env.PATH, home });
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shell = deps.env.SHELL || "/bin/zsh";
  const run = deps.run ?? runLoginShell;
  try {
    const output = await bounded(run(shell, ["-ilc", `printf '\\n${PATH_START}%s${PATH_END}\\n' "$PATH"`], { env: deps.env, timeout }), timeout);
    return mergeLoginPath({ discoveredPath: extractPath(output), currentPath: deps.env.PATH, home });
  } catch {
    return fallback;
  }
}
