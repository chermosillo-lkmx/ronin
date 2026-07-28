#!/usr/bin/env bash
# tmux-worker-loop watcher — v8 (multi-pane, role-aware).
# bash 3.2 compatible (macOS ships 3.2 — NO associative arrays, NO GNU-only flags).
#
# WHY v8: the 4-pane topology (Main/Brain/Reviewer/Implementer) means three panes
# can emit sentinels and go idle independently. Running one v7 watcher per pane
# triple-emits every sentinel, because v7 tails the SHARED sentinels.log.
#
# v8 design:
#   1. ONE watcher process for the whole cycle. Sentinels are read from the shared
#      file exactly once (single tail cursor), so no duplicate events.
#   2. Busy/idle is tracked PER PANE, emitted as "IDLE <role>" so the driver knows
#      which agent went quiet.
#   3. ALERT detection (usage/rate limits, tracebacks) runs per pane on every poll,
#      ungated by busy/idle — a limit warning must never be swallowed.
#   4. Sentinels are expected to carry a ROLE PREFIX (===BRAIN:...===,
#      ===REVIEW:...===, ===IMPL:...===) so the driver can route without guessing.
#
# SETUP: tmux set-option -t <session> history-limit 50000
# Usage: watch-multi.sh <role>=<target> [<role>=<target> ...]
#   e.g. watch-multi.sh brain=150:0.2 reviewer=150:0.1 impl=150:0.3
# Env:   CYCLE_DIR (default /tmp/tmux-worker-cycle-default)
set -u

DIR="${CYCLE_DIR:-/tmp/tmux-worker-cycle-default}"
SENTINEL_FILE="$DIR/sentinels.log"
PLAN="$DIR/plan.md"
mkdir -p "$DIR"
touch "$SENTINEL_FILE"

[ "$#" -ge 1 ] || { echo "usage: watch-multi.sh <role>=<target> [...]" >&2; exit 2; }

ROLES=""
TARGETS=""
for pair in "$@"; do
  r="${pair%%=*}"; t="${pair#*=}"
  [ -n "$r" ] && [ -n "$t" ] && [ "$r" != "$pair" ] || {
    echo "bad arg '$pair' (want role=target)" >&2; exit 2; }
  ROLES="$ROLES $r"; TARGETS="$TARGETS $t"
done

# Parallel arrays indexed by position (bash 3.2: no assoc arrays).
set -- $ROLES
NROLE=$#
role_at() { i=$1; set -- $ROLES; eval echo "\${$i}"; }
target_at() { i=$1; set -- $TARGETS; eval echo "\${$i}"; }

# Per-pane previous busy state, as a space-separated list of 0/1.
prev_busy=""
i=1
while [ "$i" -le "$NROLE" ]; do prev_busy="$prev_busy 0"; i=$((i+1)); done

busy_at() { i=$1; set -- $prev_busy; eval echo "\${$i}"; }
set_busy() {
  i=$1; v=$2; out=""; n=1
  for old in $prev_busy; do
    if [ "$n" -eq "$i" ]; then out="$out $v"; else out="$out $old"; fi
    n=$((n+1))
  done
  prev_busy="$out"
}

# Alert de-dup: remember the last alert emitted per role so an unchanged banner
# sitting in the scrollback does not re-fire every poll.
alert_seen_dir="$DIR/.alert-seen"
mkdir -p "$alert_seen_dir"

# A pane echoes the role prompt, which CONTAINS the strings "usage limit" and
# "approaching limit" in its self-throttle section. Those echoes are markdown:
# they carry backticks, ** bold, ===SENTINEL=== syntax, or list bullets. Real
# Claude Code limit banners are plain prose. Drop anything that looks authored.
is_prompt_echo() {
  echo "$1" | grep -qE '[`*]|===|^[[:space:]]*[-#>|]|\{|\}'
}

# Sentinel cursor: number of lines already emitted.
sent_lines=$(wc -l < "$SENTINEL_FILE" 2>/dev/null | tr -d ' ')
[ -n "$sent_lines" ] || sent_lines=0

last_plan_mtime=""
[ -f "$PLAN" ] && last_plan_mtime=$(stat -f %m "$PLAN" 2>/dev/null || stat -c %Y "$PLAN" 2>/dev/null)

ts() { date +%H:%M:%S; }

while :; do
  # ---- 1. Sentinels: single shared cursor, emitted once, role prefix intact.
  cur_lines=$(wc -l < "$SENTINEL_FILE" 2>/dev/null | tr -d ' ')
  [ -n "$cur_lines" ] || cur_lines=0
  if [ "$cur_lines" -gt "$sent_lines" ]; then
    tail -n +$((sent_lines + 1)) "$SENTINEL_FILE" 2>/dev/null | while IFS= read -r line; do
      [ -n "$line" ] && echo "$(ts) SENTINEL $line"
    done
    sent_lines=$cur_lines
  fi

  # ---- 2. Per-pane busy/idle + alerts.
  i=1
  while [ "$i" -le "$NROLE" ]; do
    role=$(role_at "$i"); target=$(target_at "$i")
    snap=$(tmux capture-pane -t "$target" -p -S -25 2>/dev/null)

    if [ -n "$snap" ]; then
      # Width-robust busy check: truncated footer "esc to…" + elapsed spinner "(Ns ·".
      if echo "$snap" | grep -qE 'esc to|\([0-9]+s ·'; then
        cur=1
      else
        cur=0
      fi
      if [ "$(busy_at "$i")" = "1" ] && [ "$cur" = "0" ]; then
        echo "$(ts) IDLE $role"
      fi
      set_busy "$i" "$cur"

      # Alerts run every poll, ungated by busy/idle — but filtered and de-duped.
      alert=$(echo "$snap" \
        | grep -iE "you've hit your (usage )?limit|usage limit will reset|5-hour limit reached|approaching your (usage )?limit|Extra usage is required" \
        | tail -1)
      if [ -n "$alert" ] && ! is_prompt_echo "$alert"; then
        seen_file="$alert_seen_dir/$role"
        prev_alert=""
        [ -f "$seen_file" ] && prev_alert=$(cat "$seen_file")
        if [ "$alert" != "$prev_alert" ]; then
          echo "$(ts) ALERT [$role] $alert"
          printf '%s' "$alert" > "$seen_file"
        fi
      fi

      tb=$(echo "$snap" | grep -E 'Traceback \(most recent call last\)' | tail -1)
      if [ -n "$tb" ]; then
        tb_file="$alert_seen_dir/$role.tb"
        if [ ! -f "$tb_file" ]; then
          echo "$(ts) ALERT [$role] traceback in pane"
          : > "$tb_file"
        fi
      else
        rm -f "$alert_seen_dir/$role.tb"
      fi
    fi
    i=$((i+1))
  done

  # ---- 3. plan.md mtime (ungated; the Brain's main artifact).
  if [ -f "$PLAN" ]; then
    m=$(stat -f %m "$PLAN" 2>/dev/null || stat -c %Y "$PLAN" 2>/dev/null)
    if [ -n "$m" ] && [ "$m" != "$last_plan_mtime" ]; then
      n=$(wc -l < "$PLAN" | tr -d ' ')
      echo "$(ts) plan.md updated (lines=$n)"
      last_plan_mtime=$m
    fi
  fi

  sleep 5
done
