#!/usr/bin/env bash
# gate-layout.sh v1
#
# WHY THIS EXISTS
# The layout check used to print LAYOUT FAIL and continue, allowing prompts to
# reach the wrong panes. This gate turns the measured topology into an exit code.
#
# Usage: gate-layout.sh <window> <main> <brain> <reviewer> <implementer>
# Env: tmux must address the supplied window and pane ids.

set -u

if [ "$#" -ne 5 ]; then
  echo "gate-layout: usage: gate-layout.sh <window> <main> <brain> <reviewer> <implementer>" >&2
  exit 1
fi

window=$1
main=$2
brain=$3
reviewer=$4
implementer=$5

printf 'main=%s brain=%s reviewer=%s impl=%s\n' "$main" "$brain" "$reviewer" "$implementer"

pane_output=$(tmux list-panes -t "$window" -F '#{pane_id}' 2>&1)
tmux_status=$?
if [ "$tmux_status" -ne 0 ]; then
  echo "gate-layout: cannot inspect window '$window': $pane_output" >&2
  exit 1
fi

panes=$(printf '%s\n' "$pane_output" | grep -c '^%')
ids=$(printf '%s\n' "$main" "$brain" "$reviewer" "$implementer" | grep -c '^%')
unique=$(printf '%s\n' "$main" "$brain" "$reviewer" "$implementer" | sort -u | wc -l | tr -d ' ')

if [ "$panes" != 4 ] || [ "$ids" != 4 ] || [ "$unique" != 4 ]; then
  echo "gate-layout: LAYOUT FAIL: panes=$panes ids=$ids uniq=$unique; rebuild the four-pane layout" >&2
  exit 1
fi

echo "gate-layout: LAYOUT OK: panes=$panes ids=$ids uniq=$unique"
