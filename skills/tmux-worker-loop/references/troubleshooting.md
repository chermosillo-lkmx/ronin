# Troubleshooting & quick reference

## Quick reference

| Need | Command |
|------|---------|
| Capture sibling pane | `tmux capture-pane -t <sib> -p` |
| Capture with scrollback | `tmux capture-pane -t <sib> -p -S -2000` |
| Send literal text | `tmux send-keys -t <sib> -l "text"; tmux send-keys -t <sib> Enter` |
| Paste a multi-line file | `tmux load-buffer <f>; tmux paste-buffer -p -d -t <sib>; tmux send-keys -t <sib> Enter` |
| Detect idle | snapshot does NOT contain `esc to interrupt` |
| Detect Claude running | snapshot matches `Opus\|Sonnet\|Haiku\|Claude Max` |
| Split horizontally | `tmux split-window -h -c "$cwd" -t "$me"` |

## Common mistakes

- **Matching sentinel strings in prompt scrollback.** Always scope detection to the visible pane (no `-S`) AND only react to busy→idle transitions. The protocol prompt itself contains the sentinel literals; if you grep the full scrollback you will fire on the prompt echo.
- **Sending the worker prompt without bracketed paste.** Without `paste-buffer -p`, Claude Code may interpret line breaks as Enter and submit half a prompt.
- **Approving the plan without reading it.** Codex reviews are valuable but you are still the orchestrator — open plan.md yourself and verify it covers every requirement clause before approving.
- **Looping forever on codex pickiness.** Codex will always find *something*. Cap at ~3 review rounds per phase; if still contentious, surface to the user.
- **Forgetting to re-base on requirement.md.** Before each codex dispatch, include the literal REQUIREMENT.md content so codex evaluates against the spec, not against the plan's own internal consistency.
