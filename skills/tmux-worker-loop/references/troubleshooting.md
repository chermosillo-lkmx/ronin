# Troubleshooting & quick reference

## Quick reference

| Need | Command |
|------|---------|
| Capture sibling pane | `tmux capture-pane -t <sib> -p` |
| Capture with scrollback | `tmux capture-pane -t <sib> -p -S -2000` |
| Send literal text | `tmux send-keys -t <sib> -l "text"; tmux send-keys -t <sib> Enter` |
| Paste a multi-line file | `tmux load-buffer <f>; tmux paste-buffer -p -d -t <sib>; tmux send-keys -t <sib> Enter` |
| Detect idle | no `esc to …` in the snapshot **and** the snapshot is unchanged across ~1.5s (see below) |
| Detect Claude running | snapshot matches `Opus\|Sonnet\|Haiku\|Claude Max` |
| Detect codex running | snapshot matches `model: *gpt-` or the footer `gpt-… · ~/…` |
| Detect agy running | snapshot matches `Antigravity CLI` |
| Split horizontally | `tmux split-window -h -c "$cwd" -t "$me"` |

## Engine-specific gotchas

Full contract in `engines.md`; these four are the ones that will actually bite.

- **codex looks idle while it is streaming.** Its working indicator (`• Working (1s • esc to
  interrupt)`) is a *transcript line*, not a pinned footer, so it scrolls out of the capture window
  as soon as output starts. Measured over a 16-second turn: the footer grep matched on the first
  poll and returned nothing on every poll after, while text was still streaming. Footer-only busy
  detection is therefore **broken for codex** — `relay.sh` and `watch-multi.sh` both add
  "pane changed since the last sample ⇒ busy". If you hand-roll a check anywhere, add it there too
  or you will paste into a mid-turn pane and corrupt the message.
- **A pane blocked on a menu reads as BUSY, not stuck.** This is the nastiest one. agy renders
  `esc to cancel` in its footer while a *"Requesting permission for: … Do you want to proceed?"*
  menu is up, so the busy predicate says "working". Measured: `relay.sh` waited out its full 240s
  timeout and the old watcher emitted **nothing at all** for the entire hang. `watch-multi.sh` v9
  alerts on the menu text itself (`ALERT [<role>] BLOCKED on a permission/trust menu`). If you see
  that, go look at the pane — do not wait.
- **BOTH CLIs show a trust menu in an untrusted directory** — `Do you trust the contents of this
  directory?` (codex) / `…this project?` (agy). A fresh worktree is untrusted by definition, so this
  fires every cycle unless you pre-seed both configs. Every paste lands in the menu; the pane looks
  alive and answers nothing.
- **`Antigravity CLI` is not a safe readiness pattern.** The trust menu's own text says
  *"Antigravity CLI requires permission to read, edit, and execute files here"*, so the bare pattern
  reports a healthy pane while it sits on a menu. Match `Antigravity CLI [0-9]`.
- **agy silently downgrades an unavailable model.** `agy models` prints the catalogue, not your
  entitlement; asking for one you cannot run prints `⚠ … is no longer available. Using …` and runs
  something else. Assert the banner, and treat that warning as a hard fail.
- **Sentinel appends die silently outside the workspace.** codex and agy both need
  `--add-dir <CYCLE_DIR>`; without it the append to `sentinels.log` is refused and the cycle stalls
  at the first phase boundary while the pane looks like it is still thinking.
- **Banner assertions expire.** The banner is printed once and scrolls away; after one long turn a
  healthy codex pane matches no banner pattern at all. Re-assert on the persistent footer
  (`gpt-5.5 high · <cwd>`, `Gemini 3.6 Flash · high`) instead.

## Common mistakes

- **Matching sentinel strings in prompt scrollback.** Always scope detection to the visible pane (no `-S`) AND only react to busy→idle transitions. The protocol prompt itself contains the sentinel literals; if you grep the full scrollback you will fire on the prompt echo.
- **Sending the worker prompt without bracketed paste.** Without `paste-buffer -p`, the CLI may interpret line breaks as Enter and submit half a prompt. Verified necessary on all three engines.
- **Approving the plan without reading it.** Codex reviews are valuable but you are still the orchestrator — open plan.md yourself and verify it covers every requirement clause before approving.
- **Looping forever on codex pickiness.** Codex will always find *something*. Cap at ~3 review rounds per phase; if still contentious, surface to the user.
- **Forgetting to re-base on requirement.md.** Before each codex dispatch, include the literal REQUIREMENT.md content so codex evaluates against the spec, not against the plan's own internal consistency.
