import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLAUDE_CMD } from "./config.js";

const pexec = promisify(execFile);

export async function tmuxAvailable(): Promise<boolean> {
  try {
    await pexec("tmux", ["-V"]);
    return true;
  } catch {
    return false;
  }
}

/** List existing tmux session names (empty if no server / none). */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await pexec("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function hasSession(name: string): Promise<boolean> {
  try {
    await pexec("tmux", ["has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a detached tmux session that runs claude in `cwd`, keeping the pane
 * alive with a login shell afterward so the terminal doesn't vanish on exit.
 */
export async function createSession(name: string, cwd: string, startCmd: string = CLAUDE_CMD): Promise<void> {
  const command = `${startCmd}; exec $SHELL -l`;
  await pexec("tmux", ["new-session", "-d", "-s", name, "-c", cwd, command]);
}

/** Type literal text into the pane; optionally submit with Enter. */
export async function sendText(name: string, text: string, submit: boolean): Promise<void> {
  await pexec("tmux", ["send-keys", "-t", name, "-l", text]);
  if (submit) await pexec("tmux", ["send-keys", "-t", name, "Enter"]);
}

export async function capturePane(name: string): Promise<string> {
  const { stdout } = await pexec("tmux", ["capture-pane", "-t", name, "-p"]);
  return stdout;
}

export async function killSession(name: string): Promise<void> {
  try {
    await pexec("tmux", ["kill-session", "-t", name]);
  } catch {
    /* already gone */
  }
}

/** Open a visible macOS Terminal window attached to the session. */
export async function openTerminal(name: string): Promise<void> {
  const script = [
    'tell application "Terminal"',
    `  do script "tmux attach -t ${name}"`,
    "  activate",
    "end tell",
  ].join("\n");
  await pexec("osascript", ["-e", script]);
}

// ---- pane interpretation (same heuristic as the tmux-worker-loop skill) ----

/** The worker is busy while claude shows its "esc to interrupt" footer. */
export function isBusy(pane: string): boolean {
  return /esc to interrupt/i.test(pane);
}

// Lines that are claude's own UI chrome, not useful as a status hint.
const CHROME = /shift\+tab|to cycle|esc to interrupt|for shortcuts|bypass permissions|^[│╭╮╰╯─▐▝▘▛▜▙▟ ]+$/i;

/** Last meaningful (non-chrome) line, trimmed and truncated — a live status hint. */
export function lastMeaningfulLine(pane: string): string {
  const lines = pane
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !CHROME.test(l));
  const last = lines[lines.length - 1] ?? "";
  return last.replace(/\s+/g, " ").slice(0, 56);
}
