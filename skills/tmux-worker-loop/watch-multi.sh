#!/usr/bin/env bash
# tmux-worker-loop watcher — v9 (multi-pane, role-aware, multi-ENGINE).
#
# WHY v9: the three worker panes no longer all run Claude. The Reviewer runs codex
# (fallback claude) and the Implementer runs agy (fallback claude), which breaks two
# v8 assumptions:
#   1. BUSY DETECTION. v8 grepped the bottom 25 lines for "esc to". claude and agy pin
#      that footer, but codex prints "• Working (1s • esc to interrupt)" INLINE in the
#      transcript, so it scrolls away the instant output streams. Measured over a 16s
#      codex turn: matched on poll 1, then 0 on every later poll while still streaming.
#      v9 adds a change-detector — a pane whose content differs from the previous poll
#      is busy regardless of any footer. Idle panes are byte-stable on all three CLIs.
#   2. LIMIT ALERTS. v8 only knew Claude's banner phrasings. v9 carries codex's and
#      agy's too (see LIMIT_RE), so a rate-limited Reviewer surfaces as an ALERT rather
#      than as a pane that mysteriously stops answering.
#
# v8 (multi-pane, role-aware) notes retained below.
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

# Per-pane snapshot store for the change-detector (see v9 note at the top).
snap_dir="$DIR/.pane-snap"
mkdir -p "$snap_dir"

# Limit banners across all three engines, union'd. Plain-prose only — is_prompt_echo()
# below drops anything that looks like the role prompt quoting these words back at us.
#   claude: "you've hit your limit", "usage limit will reset", "5-hour limit reached",
#           "Extra usage is required"
#   codex : "You've hit your usage limit for …", "rate limit reached", 429 envelopes
#   agy   : quota exhaustion — wording NOT verified (the quota could not be exhausted
#           on purpose), so this is a best-effort net. The authoritative agy check is
#           behavioural: re-run the preflight probe from references/engines.md.
LIMIT_RE="you've hit your (usage )?limit|usage limit will reset|5-hour limit reached|approaching your (usage )?limit|Extra usage is required|rate limit reached|too many requests|\"status\":( )?429|HTTP 429|RESOURCE_EXHAUSTED|quota exceeded|out of quota"

# BLOCKING MENUS — a pane waiting on a human, which v8 could not see at all.
# Verified failure: an agy pane asking "Requesting permission for: … Do you want to
# proceed?" renders "esc to cancel" in its footer, so the busy check calls it BUSY and
# the watcher stays silent while relay.sh politely waits out its 240s timeout. Same for
# both CLIs' first-run trust prompts ("Do you trust the contents of this
# directory?/project?"), where every subsequent paste lands in the menu instead of the
# prompt. All of these are indistinguishable from "still thinking" from the outside,
# which is exactly why they need their own alert.
MENU_RE="Do you trust the contents of|Yes, I trust this folder|Requesting permission for|Do you want to proceed\?"

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
      # Busy check, engine-portable (v9):
      #   (a) width-robust footer match — truncated "esc to…" (claude/agy/codex) plus
      #       the elapsed spinner "(Ns ·" / "(Ns •" (U+00B7 vs U+2022);
      #   (b) content changed since the previous poll — the only signal that survives a
      #       codex pane streaming its answer, because codex's working indicator is a
      #       transcript line and scrolls out of this window.
      # Either one means busy. (b) costs nothing: the watcher already polls on a timer,
      # so it compares against last poll rather than sleeping for a second sample.
      snap_file="$snap_dir/$role"
      prev_snap=""
      [ -f "$snap_file" ] && prev_snap=$(cat "$snap_file")
      printf '%s' "$snap" > "$snap_file"

      if echo "$snap" | grep -qE 'esc to|\([0-9]+s [·•]'; then
        cur=1
      elif [ -n "$prev_snap" ] && [ "$snap" != "$prev_snap" ]; then
        cur=1
      else
        cur=0
      fi
      if [ "$(busy_at "$i")" = "1" ] && [ "$cur" = "0" ]; then
        echo "$(ts) IDLE $role"
      fi
      set_busy "$i" "$cur"

      # Alerts run every poll, ungated by busy/idle — but filtered and de-duped.
      alert=$(echo "$snap" | grep -iE "$LIMIT_RE" | tail -1)
      if [ -n "$alert" ] && ! is_prompt_echo "$alert"; then
        seen_file="$alert_seen_dir/$role"
        prev_alert=""
        [ -f "$seen_file" ] && prev_alert=$(cat "$seen_file")
        if [ "$alert" != "$prev_alert" ]; then
          echo "$(ts) ALERT [$role] $alert"
          printf '%s' "$alert" > "$seen_file"
        fi
      fi

      # Blocking menu: emit once per role while it is up, and clear when it goes away,
      # so a pane that gets unblocked and later blocks again alerts again.
      menu=$(echo "$snap" | grep -E "$MENU_RE" | tail -1)
      menu_file="$alert_seen_dir/$role.menu"
      if [ -n "$menu" ] && ! is_prompt_echo "$menu"; then
        if [ ! -f "$menu_file" ]; then
          echo "$(ts) ALERT [$role] BLOCKED on a permission/trust menu — waiting on a human, NOT working: $menu"
          : > "$menu_file"
        fi
      else
        rm -f "$menu_file"
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
