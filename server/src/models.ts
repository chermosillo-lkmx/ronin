/**
 * Per-role model helpers (F0). The Planner model is injected into the pane's
 * launch command via `--model`; the Worker model is later switched in-pane with
 * `/model`. Both values are folded into a shell command (tmux.ts createSession
 * runs `${startCmd}; exec $SHELL -l`) or typed into the pane, so they MUST be
 * sanitized to an inert charset first — a model string is a value, never a flag
 * fragment or shell metacharacter carrier.
 */

/** A model alias/id is `opus`, `sonnet`, `claude-opus-4-8`, etc. Anything else → "". */
export function sanitizeModel(model: string): string {
  const m = (model ?? "").trim();
  return /^[A-Za-z0-9._-]+$/.test(m) ? m : "";
}

/**
 * Return `cmd` with `--model <model>` appended, unless it already carries a
 * `--model`/`--model=` flag (whole-word, quote-aware) — in which case the existing
 * flag wins and `cmd` is returned unchanged. A model that fails sanitization (or is
 * blank) also leaves `cmd` unchanged, so a malicious value can never reach the
 * command string.
 */
export function withModel(cmd: string, model: string): string {
  const safe = sanitizeModel(model);
  if (!safe) return cmd;
  if (hasModelFlag(cmd)) return cmd;
  return `${cmd} --model ${safe}`;
}

/** True if `cmd` already has a `--model` or `--model=…` token (whole word, ignoring quoted segments). */
function hasModelFlag(cmd: string): boolean {
  // Tokenize honoring single/double quotes so a `--model` inside a quoted arg
  // doesn't false-match differently; we only care about bare tokens anyway.
  const tokens = tokenize(cmd);
  return tokens.some((t) => t === "--model" || t.startsWith("--model="));
}

/** Whether a launch of this task source should switch to the Worker model at plan→impl. */
export function launchSwitchEnabled(source: string): boolean {
  return source !== "pr"; // PR review has an impl stage in the default flow but must stay on Planner (B1)
}

/** Family token of a model alias/id: opus | sonnet | haiku | <the value itself>. */
export function modelFamily(model: string): string {
  const m = (model ?? "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return m;
}

/**
 * The model shown in the pane's CURRENT-MODEL status region (Claude Code renders the active
 * model in its footer/banner, e.g. "Opus 4.8 with high effort"). Returns the family token
 * (opus/sonnet/haiku) or null. Deliberately EXCLUDES the input line and the echo of a typed
 * `/model …` command and picker rows — so a switch is only confirmed when the STATUS line
 * shows the target, not merely because the name appears somewhere in the capture (point 1).
 */
export function currentModelFromPane(pane: string): string | null {
  const lines = (pane ?? "").split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 16); i--) {
    const l = lines[i];
    if (!l) continue;
    if (/^[>❯]/.test(l)) continue;        // input prompt / picker cursor line
    if (/\/model\b/i.test(l)) continue;   // echo of the command we typed
    if (/\bswitch\b|\bselect\b/i.test(l)) continue; // picker chrome
    const m = l.match(/\b(opus|sonnet|haiku)\b/i);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * True if the pane shows an interactive model PICKER (a selection cursor/prompt near a model
 * name, or a "Switch model?" confirm) — i.e. `/model <name>` did NOT set the model directly.
 */
export function isModelPickerOpen(pane: string): boolean {
  const p = pane ?? "";
  const cursorNearModel = /[>❯]\s*.*\b(opus|sonnet|haiku)\b/i.test(p);
  const selectPrompt = /(select|choose|switch)\b.{0,24}\bmodel\b/i.test(p);
  const options = (p.match(/\b(opus|sonnet|haiku)\b/gi) ?? []).length;
  return (selectPrompt && options >= 1) || (cursorNearModel && options >= 2);
}

/**
 * True if an open picker OFFERS to switch to the target family — e.g. the "Switch model?" confirm
 * whose pre-selected option is "Yes, switch to Sonnet 5". In that case the correct action is to
 * CONFIRM (Enter), not dismiss (Escape) — Claude Opus 4.8 opens this confirm instead of switching
 * directly, so Escaping it left the worker on the expensive Planner model for the whole impl.
 */
export function pickerOffersModel(pane: string, targetFamily: string): boolean {
  if (!targetFamily) return false;
  const fam = targetFamily.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // target appears next to a "switch to" / "yes" cue → the confirm pre-selects our target
  return new RegExp(`(?:switch(?:ing)? to|yes[,\\s][^\\n]*?)\\b${fam}\\b`, "i").test(pane ?? "");
}

/**
 * True if the pane shows the CONFIRMATION that the model was set to the target. On the current
 * Claude, `/model sonnet` sets directly and prints a transient line — e.g.
 * "⎿ Set model to Sonnet 5 and saved as your default for new sessions" — rather than leaving a
 * persistent model status line. So we verify the switch by this confirmation, not by a banner
 * (which a running pane doesn't have → the old check false-negatived and resent 3×). Tolerant of
 * width-wrap between the cue and the model name.
 */
export function modelSwitchConfirmed(pane: string, targetFamily: string): boolean {
  if (!targetFamily) return false;
  const fam = targetFamily.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:set model to|switch(?:ed|ing)? to|now using|using model)[\\s\\S]{0,40}\\b${fam}\\b`, "i").test(
    pane ?? ""
  );
}

/** Minimal shell-ish tokenizer: splits on whitespace, respecting single/double quotes. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur), (cur = "");
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
