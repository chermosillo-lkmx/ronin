import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface TmuxPathDependencies {
  env: NodeJS.ProcessEnv;
  exists?(path: string): boolean;
}

/**
 * Resolve tmux without relying on the login-shell PATH that Finder and `open` omit on macOS.
 * The caller passes the chosen path to the backend; `undefined` deliberately means that the
 * backend should try its normal command and report TMUX_NOT_FOUND if it really is unavailable.
 */
export function resolveTmuxBinary({ env, exists = existsSync }: TmuxPathDependencies): string | undefined {
  const configured = env.COWORK_TMUX_BIN?.trim();
  if (configured) return configured;

  for (const candidate of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]) {
    if (exists(candidate)) return candidate;
  }

  for (const entry of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(entry, "tmux");
    if (exists(candidate)) return candidate;
  }

  return undefined;
}
