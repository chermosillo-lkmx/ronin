#!/usr/bin/env bash
# tmux-worker-loop relay — v1.
# Deliver a message into a role's pane, reliably, and log it to the cycle transcript.
#
# WHY THIS EXISTS: hand-rolling `load-buffer; paste-buffer; send-keys Enter` at every
# handoff fails in ways that are silent — a missing `-p` mangles multi-line prompts,
# an Enter sent too soon submits half a message, and a stale pane index pastes into a
# dead shell while the driver waits forever for a sentinel that will never come.
# Every inter-pane message goes through here so those failures become loud.
#
# Usage:
#   relay.sh <role> -f <file>          # send file contents
#   relay.sh <role> -m "message"       # send inline message
#   relay.sh <role> --raw-key <key>    # send a bare key (Escape, C-c) — no paste, no Enter
#
# Reads role->pane mapping from $CYCLE_DIR/panes.env (written at layout time).
# Env: CYCLE_DIR (required)
set -u

DIR="${CYCLE_DIR:-}"
[ -n "$DIR" ] || { echo "relay: CYCLE_DIR unset" >&2; exit 2; }
PANES="$DIR/panes.env"
[ -f "$PANES" ] || { echo "relay: missing $PANES — layout not recorded" >&2; exit 2; }
# shellcheck disable=SC1090
. "$PANES"

TRANSCRIPT="$DIR/relay.log"

role="${1:-}"; shift 2>/dev/null || true
[ -n "$role" ] || { echo "usage: relay.sh <role> -f <file> | -m <msg> | --raw-key <key>" >&2; exit 2; }

case "$role" in
  brain)    pane="${brain:-}" ;;
  reviewer) pane="${reviewer:-}" ;;
  impl|implementer) pane="${impl:-}" ;;
  main)     pane="${main:-}" ;;
  *) echo "relay: unknown role '$role' (want brain|reviewer|impl|main)" >&2; exit 2 ;;
esac
[ -n "$pane" ] || { echo "relay: no pane id for role '$role' in $PANES" >&2; exit 2; }

# The pane must still exist. A closed pane is the #1 cause of a stalled cycle:
# without this check the paste goes nowhere and the driver blocks on a sentinel forever.
tmux list-panes -a -F '#{pane_id}' | grep -qx "$pane" \
  || { echo "relay: pane $pane ($role) is GONE — rebuild the layout, do not re-derive by index" >&2; exit 3; }

mode="${1:-}"; shift 2>/dev/null || true

case "$mode" in
  --raw-key)
    key="${1:-}"; [ -n "$key" ] || { echo "relay: --raw-key needs a key" >&2; exit 2; }
    tmux send-keys -t "$pane" "$key"
    printf '%s [%s -> %s] RAW-KEY %s\n' "$(date +%H:%M:%S)" "main" "$role" "$key" >> "$TRANSCRIPT"
    exit 0
    ;;
  -f)
    src="${1:-}"
    [ -f "$src" ] || { echo "relay: no such file '$src'" >&2; exit 2; }
    ;;
  -m)
    msg="${1:-}"
    [ -n "$msg" ] || { echo "relay: -m needs a message" >&2; exit 2; }
    src="$DIR/.relay-inline.$$"
    printf '%s\n' "$msg" > "$src"
    ;;
  *) echo "usage: relay.sh <role> -f <file> | -m <msg> | --raw-key <key>" >&2; exit 2 ;;
esac

# Refuse to paste into a pane that is mid-turn: Claude Code will interleave the paste
# with its own output and the message arrives corrupted or is swallowed entirely.
tries=0
while [ $tries -lt 120 ]; do
  tmux capture-pane -t "$pane" -p -S -25 | grep -qE 'esc to|\([0-9]+s ·' || break
  tries=$((tries+1)); sleep 2
done
if [ $tries -ge 120 ]; then
  echo "relay: $role ($pane) still busy after 240s — NOT pasting (would corrupt). Check the pane." >&2
  [ "$mode" = "-m" ] && rm -f "$src"
  exit 4
fi

tmux load-buffer "$src"
tmux paste-buffer -p -d -t "$pane"   # -p = bracketed paste: multi-line survives the input field
sleep 2
tmux send-keys -t "$pane" Enter

{
  printf '%s [main -> %s] (%s bytes)\n' "$(date +%H:%M:%S)" "$role" "$(wc -c < "$src" | tr -d ' ')"
  sed 's/^/    | /' "$src"
} >> "$TRANSCRIPT"

[ "$mode" = "-m" ] && rm -f "$src"
echo "relay: delivered to $role ($pane)"
