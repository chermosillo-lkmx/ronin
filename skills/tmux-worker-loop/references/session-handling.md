# Session handling

Covers: clearing the worker between cycles, the worker's 5-hour limit, and the driver's 99% self-throttle.

## Clearing the worker before a new requirement

If the worker pane already has Claude running with an active conversation (prior cycle's plan, codex review pastes, implementation diff, etc.), that history burns tokens on every turn of the new cycle and risks bleed-through ("the worker keeps referring to the old plan"). Decide:

- **Fresh worker** (banner just appeared, no prior turns visible in scrollback) → skip clearing, proceed.
- **Mid-execution** (snapshot still shows `esc to interrupt`, i.e. a previous task is running) → ask the user first:
  > "The worker is still running a previous task. Clear it and start the new requirement, or wait for the current cycle to finish?"
  - If clear: send `Escape` (twice if needed) to interrupt, wait for idle, then clear.
  - If wait: stop and resume when the prior cycle emits `===CYCLE-DONE===`.
- **Idle but with prior conversation in scrollback** → clear it.

To clear, send `/clear` (Claude Code's built-in conversation reset):

```bash
tmux send-keys -t "$sib" "/clear" Enter
until tmux capture-pane -t "$sib" -p -S -20 | grep -qE 'Opus|Sonnet|Haiku'; do
  sleep 1
done
```

Detect prior conversation by checking the bottom of the scrollback for either an old sentinel (`===CYCLE-DONE===`, `===PLAN-READY===`, etc.) or a non-trivial number of `>` prompt entries. When in doubt, clear — a fresh context is cheap; a polluted one is not.

## Worker hits 5-hour limit

Symptoms in the worker pane:
- `5-hour limit reached`
- `usage limit will reset at <time>`

When the watcher emits an `ALERT` line containing "limit", do NOT spam the pane. Sleep until the reset time (use `ScheduleWakeup` for delays > 5 min), then check the pane again. The worker resumes from its last state when re-prompted.

## Driver self-throttle at 99% session usage

The **driver** session has its own 5-hour usage budget. If the driver burns through it, the orchestration dies and the worker is stranded mid-cycle. To prevent that:

1. **Watch your own usage.** As soon as you see the driver session is at **99% usage** (status-line indicator, `/cost`, or any "approaching limit" warning), stop initiating new work in this pane.
2. **Pause the worker(s) immediately.** For each worker pane:
   - If the worker is mid-phase, send `tmux send-keys -t <sib> Escape` to interrupt cleanly, then paste:
     `PAUSE — driver at 99% session usage. Hold here, do not run tools or write files until I send RESUME. Reply only with the literal string ===WORKER-PAUSED===.`
   - Wait for `===WORKER-PAUSED===` to confirm the worker is parked.
3. **Spend the remaining 1% on keep-alive only.** Do NOT dispatch subagents, do NOT call codex, do NOT read large files, do NOT capture giant scrollback. The only allowed actions are:
   - `ScheduleWakeup` to sleep until the reset time the system reports (compute `delaySeconds` from the reset clock).
   - A single short `tmux capture-pane -t <sib> -p` (no `-S`) per wake to confirm the worker is still parked.
   - A one-line status message to the user.
4. **Resume after reset.** When usage resets, send `RESUME — proceed from where you paused` to each paused worker and continue the orchestration loop from the last sentinel.

Rule of thumb: at 99%, your job is to *survive* until reset, not to make progress. Every token spent on review, planning, or capture risks the driver dying before it can park the worker.
