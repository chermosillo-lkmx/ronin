# Provisioned panes (Ronin Driver mode)

**Replaces Steps 0–2 of `SKILL.md`.** Use this variant when the panes already exist and their ids
were handed to you in the prompt — i.e. Ronin launched this ticket in **Driver mode**. Everything
from Step 3 onward in `SKILL.md` is unchanged, including the RGR protocol and the refactor audit.

The difference from the standard flow: you do **not** discover or create panes, and you do **not**
invent a cycle dir. Ronin created a single tmux window with four panes and passed you their
`pane_id`s; it also created the cycle dir and is polling it to drive the dashboard.

## 0′. Preflight

```bash
command -v tmux || echo "MISSING tmux"
# Only when reviewTool is codex:
command -v codex || echo "MISSING codex"
```

If `reviewTool` is `codex` and codex is **not** installed: **do not proceed to the review gate.**
Write the problem to `<CYCLE_DIR>/evidence/summary.md` and say so in your pane. Stalling silently at
the gate is the failure mode to avoid — Ronin can only see sentinels, so a driver that quietly waits
forever looks identical to one that is thinking.

Do **not** create panes, kill panes, or run `select-layout`. The 2×2 layout is Ronin's, and
`tmux.ts` asserts the window has exactly four panes — a fifth pane throws
`la ventana driver quedó con N pane(s), no 4` and kills the run.

## 1′. Targets are given — never discovered

The prompt contains four `pane_id`s of the form `%N`. **Ronin's pane names are slots, not roles** —
the skill's four roles map onto them like this:

| Ronin slot | Placeholder | Skill role | Model | Writes |
|---|---|---|---|---|
| driver | `{driverPane}` | **Main** (you) | operator's choice | relays, decisions |
| worker | `{workerPane}` | **Implementer** | **Sonnet** | code + tests + KB + `rgr.log` |
| review | `{reviewPane}` | **Reviewer** | **Opus** (or codex) | report files only |
| verify | `{verifyPane}` | **Brain** | **Opus** | `plan.md`, consult answers |

Two things about this mapping are worth stating plainly, because both are easy to get backwards:

- **`worker` is the Implementer, not the planner.** It is the pane that writes code, which is why it
  runs Sonnet — matching `WORKER_MODEL`. Under the four-role topology the planning it used to do
  moved out to its own pane.
- **`verify` hosts the Brain.** The slot is named for the old flow's verification step; verification
  now belongs to Main and the Reviewer. Giving the Brain its own long-lived pane is the whole point
  of the split — it stays alive as a consultant while the Implementer works from `plan.md` alone.

Use the ids verbatim as `-t` targets: `tmux send-keys -t %13 …`, `tmux capture-pane -t %13 -p`.

**Never use pane indices** (`session:driver.0`, `.1`, …). tmux recomputes `pane_index` when a pane
dies, so if any pane exits, the indices shift and you would silently relay the Brain's plan into the
Reviewer pane — every send succeeds, and the cycle scrambles with no error. `%N` ids are stable for
the life of the pane. If you ever need to re-derive them, each pane carries its slot:

```bash
tmux list-panes -t "$SESSION" -F '#{pane_id} #{@cowork-role}'
```

## 1.5′. Write `panes.env` — do this before anything else

`relay.sh` and `watch-multi.sh` both resolve roles through `<CYCLE_DIR>/panes.env`. In Driver mode
you do not generate it from splits (Step 1 of `SKILL.md`) — you **translate** the ids you were
given, once, at the top of the cycle:

```bash
cat > "$CYCLE_DIR/panes.env" <<EOF
main=$DRIVER_PANE
impl=$WORKER_PANE
reviewer=$REVIEW_PANE
brain=$VERIFY_PANE
win=$SESSION
EOF
```

Get this file right and every later `relay.sh brain …` lands where you mean. Get it wrong and every
message in the cycle goes to the wrong pane while each individual command reports success — which
is exactly the failure the `%N` discipline above exists to prevent, reintroduced one layer up.

Copy the two scripts into the cycle dir as Step 3 describes; Ronin does not place them for you:

```bash
S=~/.claude/skills/tmux-worker-loop   # or the vendored skills/ dir
cp "$S/watch-multi.sh" "$S/relay.sh" "$CYCLE_DIR"/ && chmod +x "$CYCLE_DIR"/{watch-multi.sh,relay.sh}
touch "$CYCLE_DIR/sentinels.log" "$CYCLE_DIR/rgr.log"
```

## 2′. Start Claude in the three sibling panes

They start as bare shells, so you start the tools yourself. **Launch each with the explicit
`--model` your prompt gave you** (§2.6′) — in Driver mode nothing else sets it, and riding the
account default is how a Reviewer ends up on Sonnet:

```bash
start_pane() {  # $1 = pane id, $2 = command
  snap=$(tmux capture-pane -t "$1" -p -S -50)
  if ! grep -qE 'Opus|Sonnet|Haiku|Claude Max|esc to' <<<"$snap"; then
    tmux send-keys -t "$1" "$2" Enter
    until tmux capture-pane -t "$1" -p -S -50 | grep -qE 'Opus|Sonnet|Haiku|esc to'; do sleep 2; done
  fi
}

start_pane "$VERIFY_PANE" "claude --model $BRAIN_MODEL"   # Brain
start_pane "$REVIEW_PANE" "$REVIEW_CMD"                   # Reviewer: codex, or claude --model $REVIEWER_MODEL
start_pane "$WORKER_PANE" "claude --model $IMPL_MODEL"    # Implementer
```

Start a pane only when you actually need it: the Brain at cycle start, the Reviewer at the first
review gate, the Implementer after `PLAN APPROVED`. Every idle Claude still costs tokens once it has
a conversation.

Then run the per-pane model assertions from `SKILL.md` Step 2 (`expect_model`). They apply here
unchanged and they are worth more in this mode, not less — you did not launch these panes from a
clean layout, so a leftover session from a prior run on the wrong model is a live possibility.

## 2.6′. Models — they come from your prompt, and there is no `/model` switch

**The engine's plan→impl `/model` switch is already off in Driver mode** — `launchDriverLive`
persists `switchEnabled:false` in `models.json` *and* `maybeSwitchModel` early-returns on
`mode === "driver"`. Two guards, because after a restart `worker.mode` does not exist yet when the
poller runs. You do not need to defend against it; it will not fire. (The reason it is off: `/model`
is typed into the window's *active* pane, which in a 4-pane layout is whatever the operator last
clicked — possibly the codex pane, or a bare shell where the text would simply *execute*.)

**In the four-role topology there is nothing to switch:** planning and implementation live in
different panes, so each role launches on its model and keeps it for the whole cycle.

**Use the models given in your prompt, not the ones in `SKILL.md`.** The driver prompt carries
`brain` / `reviewer` / `implementer` models resolved from the repo's config (`repo-config.ts`
`plannerModel`/`workerModel`, or the operator's choice in the launch dialog). `SKILL.md`'s
opus/opus/sonnet are the *defaults* those settings fall back to — if you hardcode them you silently
override a per-repo override, and nothing will tell you that you did.

If you ever must change a model mid-cycle, target the pane explicitly and only while it is idle:
`tmux send-keys -t "$WORKER_PANE" "/model sonnet" Enter`. Never send a slash command to a bare
`-t "$SESSION"` target — it lands on the active pane. Your own pane's model is the operator's
choice; don't change it.

## 3′. Cycle dir is given

`CYCLE_DIR` comes in the prompt (Ronin's convention: `/tmp/cowork-cycle-<session>`). **Do not generate
a `/tmp/tmux-worker-cycle-<timestamp>` dir** as `SKILL.md` Step 3 describes.

This matters more than it looks: Ronin's dashboard polls `CYCLE_DIR` for stage sentinels. If you write
them anywhere else, the stepper and the ⌘ Sessions sidebar sit frozen at "no stage" for the entire
run even though the cycle is progressing perfectly.

Write `REQUIREMENT.md`, `sentinels.log`, `rgr.log`, `panes.env` and `relay.log` there, and `touch`
each stage sentinel **when you start that stage** — the keys are listed in your prompt:

```
planning · plan-review · implementing · diff-review · verifying · done
```

Map them to the four-role flow: `planning` = Brain drafting, `plan-review` = Reviewer's plan pass,
`implementing` = Implementer's RGR cycles, `diff-review` = Reviewer's diff pass **including the RGR
refactor audit**, `verifying` = your own final KB + test verification, `done` = cycle closed.

The sentinel contract from `SKILL.md` is unchanged: append to `<CYCLE_DIR>/sentinels.log` **and**
print. Ronin reads that file too — it is how the dashboard distinguishes "a pane parked on its usage
limit" from "the driver died", which are otherwise identical from the outside.

## From Step 4 onward

Unchanged — see `SKILL.md`: send the role prompts, run the orchestration loop
(plan → review → relay → approve → impl → diff-review + RGR audit → relay → approve → verify), watch
for drift, and honor the usage self-throttle (70% / 95% / 99% and the Park procedure).

The only difference is *where* the review happens: instead of calling `codex:codex-rescue` or an
`Agent` tool from your own context, you drive the **Reviewer pane** as a live conversation.

- **`reviewTool: agent`** — the Reviewer pane is a Claude. Send it
  `reviewer_prompt_template.md` verbatim; it already contains the adversarial protocol, the severity
  ladder, and the mandatory RGR/refactor audit.
- **`reviewTool: codex`** — codex will not follow the sentinel contract. Paste the plan/diff into
  its pane and read the answer with `capture-pane`. **Include the RGR audit explicitly in what you
  ask it**, since it is not running the reviewer template: *"read `<CYCLE_DIR>/rgr.log`; for each
  cycle, was RED real, and did REFACTOR change behavior? Tests must be byte-identical across a
  refactor."* Then relay its findings to the Implementer prefixed `REVIEW:`.

Relay findings prefixed `REVIEW:` in both cases — that prefix is what the role protocols key on.
(`CODEX REVIEW:` is also accepted by the Brain, for continuity with older cycles.)

## Notes

- One ttyd renders all four panes, and tmux `mouse` is on: the operator can click any pane and type
  into it directly. Assume a human may interject at any time.
- Ronin kills the whole session on Stop, so all four panes die together. You don't need to clean up.
- If a pane dies, the remaining `%N` ids stay valid. Restart the tool in that pane (`start_pane`)
  rather than re-splitting — Ronin expects exactly four panes with their slot options set. Note that
  `relay.sh` exits `rc=3` on a dead pane rather than pasting into the void, so a died-and-restarted
  pane surfaces as a loud failure instead of a stalled cycle.
