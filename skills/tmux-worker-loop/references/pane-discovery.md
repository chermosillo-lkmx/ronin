# Worker pane discovery

**Documented path: driver Claude must already be running inside tmux.** This is the only configuration that gives the user a single window with both Claudes side-by-side. If `$TMUX` is set, split the current window vertically and use the new pane as the worker.

If `$TMUX` is unset (driver launched from a plain shell), prefer telling the user to relaunch in tmux:

```
tmux new -s liebre
claude
```

…then re-issue the requirement. As a fallback only, create a detached session with a single worker pane and auto-open a new Terminal/iTerm window attached to it so the user doesn't have to `tmux attach` manually.

## Bash

```bash
cwd=$(pwd)

if [ -n "$TMUX" ]; then
  # Documented path: split the driver's current window.
  me=$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}')
  sib=$(tmux list-panes -F '#{session_name}:#{window_index}.#{pane_index} #{pane_active}' \
         | awk '$2==0 {print $1; exit}')
  cwd=$(tmux display-message -p '#{pane_current_path}')
  if [ -z "$sib" ]; then
    tmux split-window -h -c "$cwd" -t "$me"
    sib=$(tmux list-panes -F '#{session_name}:#{window_index}.#{pane_index} #{pane_active}' \
           | awk '$2==0 {print $1; exit}')
  fi
else
  # Fallback: driver is in a plain shell.
  cat <<'EOF'
⚠️  Driver Claude is not running inside tmux. For a single-window experience
    (driver + worker side-by-side), exit Claude and run:

        tmux new -s liebre
        claude

    Then re-issue this requirement.

    Falling back: creating a worker session and auto-opening a Terminal window
    attached to it. The driver stays in this terminal; the worker pane is
    visible in the new window.
EOF
  session="liebre-worker-$(date +%s)"
  tmux new-session -d -s "$session" -c "$cwd" -x 220 -y 50
  sib="$session:0.0"
  if command -v osascript >/dev/null 2>&1; then
    if pgrep -x iTerm2 >/dev/null 2>&1 || pgrep -x iTerm >/dev/null 2>&1; then
      osascript <<APPLESCRIPT
tell application "iTerm"
  create window with default profile
  tell current session of current window
    write text "tmux attach -t $session"
  end tell
end tell
APPLESCRIPT
    else
      osascript -e "tell application \"Terminal\" to do script \"tmux attach -t $session\""
    fi
    echo "→ Opened a new terminal window attached to session '$session'."
  else
    echo "→ osascript not available; attach manually: tmux attach -t $session"
  fi
fi
```

- `me` = driver pane (only set on the documented path).
- `sib` = worker pane. Documented path: freshly-split second pane in the driver's window. Fallback: pane 0 of the new detached session.
- The fallback opens a new Terminal/iTerm window automatically so the user never has to type `tmux attach`.
