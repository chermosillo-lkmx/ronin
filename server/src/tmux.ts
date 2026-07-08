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

/** Send named keys (interpreted by tmux, e.g. "Escape", "Down", "Enter") — not literal text. */
export async function sendKeys(name: string, ...keys: string[]): Promise<void> {
  await pexec("tmux", ["send-keys", "-t", name, ...keys]);
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

// P4: how many recent lines to scan for context-pressure signals. Small, like lastMeaningfulLine,
// so a stale `/clear` banner from earlier scrollback never triggers a false positive.
const PRESSURE_RECENT_LINES = 15;
// The context-left footer ("Context left until auto-compact: N%") is ALWAYS present, so only a LOW
// percentage counts as pressure — a bare "context left" match must never fire on its own (P4a).
const CONTEXT_LEFT_THRESHOLD = 20;

/**
 * P4: detect that the worker's pane is under context pressure (auto-compact imminent / suggested
 * `/clear`). Robust to pane-width truncation (matches fragments, not one exact string) and scans
 * only the recent lines. Deliberately ignores the ever-present low-signal footer at a high
 * percentage and the `/clear` slash-menu item (both would be false positives). Returns the token
 * count when parseable, else just a note; null when there's no signal.
 */
export function parseContextPressure(pane: string): { tokens?: number; note: string } | null {
  const recent = (pane ?? "")
    .split("\n")
    .slice(-PRESSURE_RECENT_LINES)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const l of recent) {
    if (/clear conversation/i.test(l)) continue; // the /clear slash-menu item, not a warning (P4a)
    // "…/clear to save 45k tokens" — the "/clear to" prefix may be truncated off, so key on
    // "save Nk" within a context-related line. Tokens best-effort (may be cut by width).
    const m = l.match(/save (\d+) ?k\b/i);
    if (m && /clear|token|context|compact/i.test(l)) {
      return { tokens: Number(m[1]), note: `/clear para ahorrar ${m[1]}k tokens` };
    }
    if (/clear to sav/i.test(l)) return { note: "aviso de /clear (contexto alto)" }; // truncated, no number
  }

  if (recent.some((l) => /compacting conversation/i.test(l))) return { note: "compactando conversación" };

  for (const l of recent) {
    if (l.startsWith("/")) continue; // slash-menu line
    const m = l.match(/context left[^0-9]*(\d{1,3}) ?%/i) ?? l.match(/(\d{1,3}) ?% context left/i);
    if (m) {
      const pct = Number(m[1]);
      if (pct < CONTEXT_LEFT_THRESHOLD) return { note: `${pct}% de contexto restante` };
    }
  }
  return null;
}
