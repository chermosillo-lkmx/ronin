#!/usr/bin/env bash
# tmux-worker-loop watcher — v7 (file-based sentinels + width-robust state).
# bash 3.2 compatible (macOS ships 3.2 — NO associative arrays, NO GNU-only flags).
#
# WHY v7: v6 scraped sentinels from the pane and gated ALL events behind a
# busy->idle transition detected by grepping "esc to interrupt". In a narrow
# (horizontally-split) pane that footer truncates to "esc to…", so the grep
# never matched, the transition never fired again after the first poll, and
# WORKER-IDLE / SENTINEL / ALERT all went silent. Long sentinels also wrap
# across lines (Claude emits real newlines at the wrap; `capture-pane -J`
# does NOT rejoin them), so the anchored regex could never match them.
#
# v7 fixes:
#   1. SENTINELS come from a FILE the worker appends to ($CYCLE_DIR/sentinels.log).
#      Width-independent, never wraps, never truncates. This is the contract.
#   2. ALERT detection runs on EVERY poll, independent of busy/idle state.
#   3. Busy detection matches the truncated footer ("esc to" prefix) and the
#      elapsed-time spinner "(Ns ·", so it works at any pane width.
#
# SETUP: tmux set-option -t <session> history-limit 50000
# Args:  $1 = tmux target (e.g. %11 or session:win.pane)
# Env:   CYCLE_DIR (default /tmp/tmux-worker-cycle-default)
set -u
TARGET="${1:?usage: watch.sh <tmux-target>}"
DIR="${CYCLE_DIR:-/tmp/tmux-worker-cycle-default}"
PLAN="$DIR/plan.md"
SENTINEL_FILE="$DIR/sentinels.log"
mkdir -p "$DIR"

last_plan_mtime=""
prev_state="busy"
last_alert=""

# Sentinel file: emit only lines appended after we start (dedupe by line count).
# Fresh cycle => file absent => start at 0. Restart mid-cycle => skip existing.
sentinel_seen=0
if [ -f "$SENTINEL_FILE" ]; then
  sentinel_seen=$(wc -l < "$SENTINEL_FILE" 2>/dev/null | tr -d ' ')
fi
sentinel_seen=${sentinel_seen:-0}

while true; do
  snapshot=$(tmux capture-pane -t "$TARGET" -p -J -S -50000 2>/dev/null)

  # --- 1. FILE-BASED SENTINELS (primary, width-independent) ---
  if [ -f "$SENTINEL_FILE" ]; then
    total=$(wc -l < "$SENTINEL_FILE" 2>/dev/null | tr -d ' ')
    total=${total:-0}
    if [ "$total" -gt "$sentinel_seen" ]; then
      tail -n +$((sentinel_seen + 1)) "$SENTINEL_FILE" 2>/dev/null | while IFS= read -r line; do
        [ -n "$line" ] && printf '%s SENTINEL %s\n' "$(date +%H:%M:%S)" "$line"
      done
      sentinel_seen=$total
    fi
  fi

  # --- 2. ALERTS (every poll, ungated) ---
  # Match ONLY real runtime limit/error signatures. Do NOT match loose tokens like
  # "usage limit"/"approaching" — those appear in the worker PROMPT's throttle section
  # and would false-alert every cycle. The worker's own ===WORKER-PARKED-LIMIT=== sentinel
  # (file-based) is the primary self-throttle signal; this is the backup for hard hits.
  err=$(printf '%s' "$snapshot" | tail -120 \
    | grep -E "You've hit your limit|hit your usage limit|5-hour limit|Approaching usage limit|Extra usage is required|· resets|resets at [0-9]|Error code: 429|429 Too Many|rate_limit_error|Traceback \(most recent call last\)" \
    | tail -1)
  if [ -n "$err" ] && [ "$err" != "$last_alert" ]; then
    printf '%s ALERT %s\n' "$(date +%H:%M:%S)" "$err"
    last_alert="$err"
  fi

  # --- 3. BUSY/IDLE (width-robust; informational only — sentinels come from the file) ---
  if printf '%s' "$snapshot" | tail -50 | grep -qE "esc to|\([0-9]+s ·"; then
    state="busy"
  else
    state="idle"
  fi
  if [ "$state" = "idle" ] && [ "$prev_state" = "busy" ]; then
    printf '%s WORKER-IDLE\n' "$(date +%H:%M:%S)"
  fi
  prev_state="$state"

  # --- 4. plan.md progress (informational) ---
  if [ -f "$PLAN" ]; then
    cur_mtime=$(stat -f %m "$PLAN" 2>/dev/null || stat -c %Y "$PLAN" 2>/dev/null)
    if [ -n "$cur_mtime" ] && [ "$cur_mtime" != "$last_plan_mtime" ]; then
      lines=$(wc -l <"$PLAN" 2>/dev/null | tr -d ' ')
      printf '%s plan.md updated (lines=%s)\n' "$(date +%H:%M:%S)" "$lines"
      last_plan_mtime="$cur_mtime"
    fi
  fi

  sleep 7
done
