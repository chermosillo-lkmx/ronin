import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface BinaryPathDependencies {
  binary: string;
  environmentVariable: string;
  env: NodeJS.ProcessEnv;
  exists?(path: string): boolean;
}

/**
 * Resolve a binary without relying on the login-shell PATH that Finder and `open` omit on macOS.
 * The caller passes the chosen path to the backend; `undefined` deliberately means that the
 * backend should try its normal command and report its own diagnostic if it is unavailable.
 */
export function resolveBinary({ binary, environmentVariable, env, exists = existsSync }: BinaryPathDependencies): string | undefined {
  const configured = env[environmentVariable]?.trim();
  if (configured) return configured;

  for (const candidate of [`/opt/homebrew/bin/${binary}`, `/usr/local/bin/${binary}`]) {
    if (exists(candidate)) return candidate;
  }

  for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(entry, binary);
    if (exists(candidate)) return candidate;
  }

  return undefined;
}

export interface TmuxPathDependencies extends Omit<BinaryPathDependencies, "binary" | "environmentVariable"> {}

/** Resolve tmux while preserving the established public wrapper and behavior. */
export function resolveTmuxBinary(deps: TmuxPathDependencies): string | undefined {
  return resolveBinary({ ...deps, binary: "tmux", environmentVariable: "COWORK_TMUX_BIN" });
}
