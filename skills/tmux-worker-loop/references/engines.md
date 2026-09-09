# Engines: codex, agy, claude

Three different CLIs now run the three worker panes. This file is the per-engine contract:
how to probe it, how to launch it, how to tell which model actually landed, how to tell whether
it is busy, and what its limit looks like.

**Everything in this file was verified by launching both CLIs in a real tmux pane** (codex-cli
0.146.0, agy/Antigravity CLI 1.1.8) and pasting real prompts into them. Where something could
**not** be reproduced — mainly the exact wording of an exhausted-quota banner — it is marked
`UNVERIFIED` rather than guessed at.

## Role → engine

| Role | Primary engine | Fallback | Why |
|---|---|---|---|
| Main | `claude --model opus` (4.8) | — | highest volume, lowest judgment need |
| Brain | `claude --model opus` (5) | — | design judgment stays on Claude |
| **Reviewer** | **`codex`** | `claude --model opus` | a genuinely different model family is a better adversary than a second Claude |
| **Implementer** | **`agy`** (Antigravity) | `claude --model sonnet` | executing a precise plan; tests are the oracle |

The fallbacks are not "nice to have" — they are the reason the cycle survives a rate limit
without parking. See "Falling back" below.

## Preflight probes (Step 0.5)

Run these **before** building the layout. Each is one cheap non-interactive turn; the point is to
learn *now* whether the engine has quota, instead of discovering it after you have pasted a
2,000-line plan into a dead pane.

```bash
# --- codex ---------------------------------------------------------------
reviewer_engine=claude
if command -v codex >/dev/null 2>&1; then
  if codex exec --sandbox read-only --skip-git-repo-check -m gpt-5.4-mini \
       'Reply with exactly: READY' >"$D/preflight-codex.log" 2>&1 \
     && grep -q READY "$D/preflight-codex.log"; then
    reviewer_engine=codex
  fi
fi

# --- agy -----------------------------------------------------------------
impl_engine=claude
if command -v agy >/dev/null 2>&1; then
  if agy -p 'Reply with exactly: READY' --model gemini-3.6-flash-low \
       >"$D/preflight-agy.log" 2>&1 \
     && grep -q READY "$D/preflight-agy.log"; then
    impl_engine=agy
  fi
fi

echo "reviewer_engine=$reviewer_engine impl_engine=$impl_engine"
```

Both probes exit `0` on success and non-zero on a bad model, missing auth, or an exhausted quota,
so `command -v` + exit code + the `READY` string covers "not installed", "broken", and "no quota"
in one check. Use a cheap model for the probe (`gpt-5.4-mini`, `gemini-3.6-flash-low`) — you are
testing the account, not the model you will actually run.

**Record the outcome in `panes.env`** so `relay.sh` and `watch-multi.sh` can key on it:

```bash
cat >> "$D/panes.env" <<EOF
reviewer_engine=$reviewer_engine
impl_engine=$impl_engine
brain_engine=claude
EOF
```

**Tell the user which engines the cycle is running on, in one line, before you dispatch.** A cycle
reviewed by a fallback Claude instead of codex is a different cycle, and the user should not have
to read `panes.env` to find that out.

## Launch commands

```bash
# Brain — unchanged
tmux send-keys -t "$brain" "cd $cwd && claude --model opus" Enter

# Reviewer
tmux send-keys -t "$reviewer" \
  "cd $cwd && codex --sandbox workspace-write --add-dir $D --add-dir $WT -a never -c model_reasoning_effort=high" Enter
# fallback:  cd $cwd && claude --model opus

# Implementer
tmux send-keys -t "$impl" \
  "cd $cwd && agy --model gemini-3.6-flash-high --add-dir $D --add-dir $WT --dangerously-skip-permissions" Enter
# fallback:  cd $cwd && claude --model sonnet
```

`$WT` is the worktree the role works in; repeat `--add-dir` once per worktree.

**Why each flag is there — none of them are decoration:**

| Flag | Without it |
|---|---|
| codex `--add-dir $D` | `<CYCLE_DIR>` is outside the workspace, so **every `sentinels.log` append is refused** and the cycle stalls at the first phase boundary |
| codex `-a never` | codex stops to ask for command approval and the pane waits on a human that is not there |
| codex `-c model_reasoning_effort=high` | you get the config default (`medium`); the Reviewer is the one role where reasoning depth is the product |
| codex `--sandbox workspace-write` | `read-only` blocks the Reviewer from writing its own report files |
| agy `--add-dir $D` | same sentinel problem as codex |
| agy `--dangerously-skip-permissions` | interactive agy stops on a *"Requesting permission for: … Do you want to proceed?"* menu for **every** shell command, including the sentinel append; headless agy auto-denies them outright. The alternative is pre-seeding `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` — pick one, but you must pick one |
| trust pre-seed (below) | the pane opens on a *"Do you trust the contents of this …?"* menu and every paste lands in the menu instead of the prompt — **both CLIs, not just agy** |

### Pre-trust the worktree — for BOTH engines, every cycle

This is not an edge case: the skill creates a **fresh `git worktree` per cycle**, so the path is
always new and therefore always untrusted. Verified: launching either CLI in a new directory opens
on a trust menu (`Do you trust the contents of this directory?` for codex,
`…of this project?` for agy) and the pane never reaches its prompt.

```bash
# codex — ~/.codex/config.toml
python3 - "$WT" <<'EOF'
import sys, pathlib
p = pathlib.Path.home() / ".codex/config.toml"
path = sys.argv[1]
txt = p.read_text() if p.exists() else ""
if f'[projects."{path}"]' not in txt:
    p.write_text(txt + f'\n[projects."{path}"]\ntrust_level = "trusted"\n')
    print("codex trusted:", path)
EOF

# agy — ~/.gemini/antigravity-cli/settings.json
python3 - "$WT" <<'EOF'
import json, sys, pathlib
p = pathlib.Path.home() / ".gemini/antigravity-cli/settings.json"
s = json.loads(p.read_text()) if p.exists() else {}
tw = s.setdefault("trustedWorkspaces", [])
if sys.argv[1] not in tw:
    tw.append(sys.argv[1]); p.write_text(json.dumps(s, indent=2))
    print("agy trusted:", sys.argv[1])
EOF
```

Verified end to end: with both pre-seeds in place, both CLIs relaunched in the same fresh worktree
came straight up on their banners with no menu.

If you skip it, the recovery is `tmux send-keys -t "$pane" Enter` to accept the highlighted
"yes" option — but do that deliberately, after reading the pane, not as a reflex.

### ⚠️ A pane stuck on a menu looks *busy*, not stuck

The worst property of these menus: agy renders `esc to cancel` in its footer while a permission
menu is up, so the busy predicate reports **busy** and every observer agrees the pane is working.
Measured: `relay.sh` waited out its full 240 s timeout and the v8 watcher emitted *nothing at all*
for the entire hang. Nothing distinguished it from a long turn.

`watch-multi.sh` v9 therefore alerts on the menus themselves:

```
ALERT [impl] BLOCKED on a permission/trust menu — waiting on a human, NOT working: Do you want to proceed?
```

It fires once while the menu is up and clears when it goes away, so a pane that gets unblocked and
later blocks again alerts again. Treat that alert as an immediate hands-on: either accept the menu
deliberately or relaunch the pane with the permissions actually configured. Do not wait it out.

## Model assertion, per engine

The generic `grep -qE 'Opus|Sonnet|Haiku'` check does not survive contact with three CLIs. Assert
the banner **each engine actually prints**, and assert the negative too.

| Engine | Idle banner line | Assert | Forbid |
|---|---|---|---|
| claude | `Opus 5 with high effort` | `opus` (Brain) / `sonnet` (Impl) | the other tiers |
| codex | `model:     gpt-5.5 high   /model to change` and footer `gpt-5.5 high · ~/…` | `model: *<slug> <effort>` | `not supported when using Codex with a ChatGPT account`, any trust menu |
| agy | banner `Antigravity CLI 1.1.8` + `Gemini 3.6 Flash (High)`; footer right-aligned `Gemini 3.6 Flash · high` | `Antigravity CLI <version>` **and** the model you asked for | `is no longer available. Using`, any trust menu |

```bash
expect_engine() {   # expect_engine <pane> <role> <want-regex> <forbid-regex>
  local t=$1 role=$2 want=$3 nope=$4 tries=0 snap
  while [ $tries -lt 45 ]; do
    snap=$(tmux capture-pane -t "$t" -p -S -50)
    if echo "$snap" | grep -qiE "$want"; then
      echo "$snap" | grep -qiE "$nope" \
        && { echo "ENGINE FAIL [$role] $t: $(echo "$snap" | grep -iE "$nope" | tail -1)"; return 1; }
      echo "ENGINE OK [$role] $t"; return 0
    fi
    tries=$((tries+1)); sleep 2
  done
  echo "ENGINE FAIL [$role] $t: no banner after 90s"; return 1
}

MENU='Do you trust the contents of'

expect_engine "$brain"    BRAIN       'opus' 'sonnet|haiku'
expect_engine "$reviewer" REVIEWER    'model: *gpt-[0-9.]+ *(high|medium|low)' \
                                      "not supported when using Codex|$MENU"
expect_engine "$impl"     IMPLEMENTER 'Antigravity CLI [0-9]' \
                                      "is no longer available\. Using|$MENU"
```

⚠️ **`Antigravity CLI` alone is not a valid assertion** — the trust menu's own text reads
*"Antigravity CLI requires permission to read, edit, and execute files here"*, so a bare match
reports OK for a pane that is sitting on a menu and has never reached its prompt. This was
observed, not theorized. Anchor on the version (`Antigravity CLI [0-9]`), which only the banner
carries, and forbid the menu explicitly so the failure names itself.

### Assert at launch on the banner; re-assert later on the footer

The banner is a **launch-time** signal: it is printed once and scrolls away as the conversation
grows. Verified — after one long turn, a codex pane no longer matched `model: *gpt-…` anywhere in
`-S 50`, and the assertion reported "no banner" for a perfectly healthy pane.

So when you re-assert **mid-cycle** — after a fallback swap, after a relaunch, or any time you want
to know what a working pane is actually running — match the persistent footer instead:

| Engine | Footer, always present | Example |
|---|---|---|
| codex | `<slug> <effort> · <cwd>` | `gpt-5.5 high · ~/code/lkmx/liebre` |
| agy | right-aligned model name | `Gemini 3.6 Flash · high` |
| claude | model in the status line | `Opus 5 …` |

A regex that works in both situations, for codex:

```bash
'model: *gpt-[0-9.]+ *(high|medium|low)|gpt-[0-9.]+ +(high|medium|low) +·'
```

Use the banner form right after launch (it is stricter and catches the trust menu), and the
banner-or-footer form for everything after.

### ⚠️ agy lists models it cannot run

`agy models` prints the full catalogue, not your entitlement. Asking for one you are not entitled
to does **not** fail — agy prints a warning and silently runs a different model:

```
⚠ Warning
  ⎿  "gemini-3.1-pro-high" is no longer available. Using "Gemini 3.6 Flash (High)".
```

Observed on a "Antigravity Starter Quota" account with `gemini-3.1-pro-high`, which `agy models`
listed. **That warning line is a hard ENGINE FAIL**, exactly like a Reviewer coming up on Sonnet:
the cycle would run on a model nobody chose and nothing downstream would mention it. Verify the
current roster with `agy models`, then trust only the banner.

## Busy / idle detection — the part that is genuinely different

The old predicate was `capture-pane -S -25 | grep -qE 'esc to|\([0-9]+s ·'`. Measured against all
three CLIs:

| Engine | Busy footer | Survives streaming? |
|---|---|---|
| claude | `esc to interrupt` at the bottom | yes — pinned footer |
| agy | `esc to cancel` at the bottom | yes — pinned footer |
| **codex** | `• Working (1s • esc to interrupt)` **inline, in the transcript** | **no** |

codex renders its working indicator as a transcript line, so the moment the response starts
streaming, that line scrolls up past the 25-line window and the pane looks *idle while it is
mid-turn*. Measured over a 16-second codex turn: the `esc to` grep matched on the first poll and
returned **0 on every poll after it**, while output was still streaming. That is precisely the
state `relay.sh` refuses to paste into, so the guard was silently off for the Reviewer pane.

**The predicate is now: busy if the footer matches, OR the pane changed over ~1.5 s.**

```bash
is_busy() {   # is_busy <pane> -> 0 = busy
  tmux capture-pane -t "$1" -p -S -40 2>/dev/null | grep -qE 'esc to|\([0-9]+s [·•]' && return 0
  local a b
  a=$(tmux capture-pane -t "$1" -p -S -40 2>/dev/null)
  sleep 1.5
  b=$(tmux capture-pane -t "$1" -p -S -40 2>/dev/null)
  [ "$a" != "$b" ]
}
```

Verified on all three: idle panes are byte-stable across 1.5 s, streaming panes are not, and a
codex pane that is *thinking* (no output yet) keeps its `Working (Ns` timer ticking — so it trips
the change check even when nothing is being printed. The two halves cover each other; keep both.

Note the character class `[·•]`: Claude's timer uses U+00B7 `·`, codex's uses U+2022 `•`.

## Limits, and what each engine does when it hits one

| Engine | What you will see | Verified? |
|---|---|---|
| claude | `you've hit your limit`, `usage limit will reset`, `5-hour limit reached`, `Extra usage is required` | yes (existing) |
| codex | `You've hit your usage limit for …`, `rate limit reached`, HTTP `429`, `too many requests` | strings present in the codex binary; the live banner was not reproduced |
| agy | quota/`RESOURCE_EXHAUSTED`/`429`-shaped errors; the account tier shows in the banner (`(Antigravity Starter Quota)`) | **UNVERIFIED** — could not exhaust the quota to observe it |

Because agy's exhausted-quota wording is unverified, **do not rely on pattern-matching it alone.**
The reliable signal is behavioural: the pane returns an error instead of an answer, twice in a row,
for a request that should have worked. Treat that as exhaustion and re-run the preflight probe —
the probe's exit code is the arbiter, not your reading of the pane.

## Falling back mid-cycle

A limit on **codex or agy is not a park** — it is an engine swap. Park is for when *Claude itself*
is out, because there is nothing left to fall back to.

```bash
. "$D/panes.env"
tmux send-keys -t "$reviewer" C-c; sleep 1; tmux send-keys -t "$reviewer" C-c; sleep 1
tmux send-keys -t "$reviewer" "cd $cwd && claude --model opus" Enter
# re-assert the banner, then re-send reviewer_prompt_template.md from scratch
sed -i '' 's/^reviewer_engine=.*/reviewer_engine=claude/' "$D/panes.env"
```

Three things this procedure must not skip:

1. **Re-assert the model** on the new engine before sending anything. A fallback launched blind is
   how a Reviewer ends up on Sonnet.
2. **Re-send the full role prompt.** The replacement process has no memory of the cycle. For the
   Reviewer that is cheap. For the **Implementer it is not** — a mid-RGR swap loses every cycle of
   context, so the replacement must be handed `plan.md`, `rgr.log`, and `git diff` explicitly, and
   told which cycle it is resuming at. Anything less and it re-implements work that is already in
   the diff.
3. **Say so in the final report.** "Reviewed by codex" and "reviewed by codex until cycle 4, then
   Claude" are different claims. Write down which one is true, and update `panes.env` so the
   watcher's alert patterns follow the engine that is actually running.

## Clearing a pane between cycles

`/clear` is Claude-only. The engine-agnostic reset is to kill the CLI and relaunch it:

```bash
tmux send-keys -t "$pane" C-c; sleep 1; tmux send-keys -t "$pane" C-c; sleep 1
tmux send-keys -t "$pane" "clear && <launch command>" Enter
```

Verified on codex and agy — both exit cleanly on a double `C-c` and come back with a fresh banner
and no prior conversation. For a Claude pane, `/clear` is cheaper; use it there.

## What does NOT change

- **Bracketed paste works on all three.** `tmux load-buffer` + `paste-buffer -p -d` + `Enter`
  delivers a multi-line prompt intact into codex's and agy's input fields, same as Claude's.
  `relay.sh` needs no per-engine paste logic.
- **Escape interrupts all three** (codex: *esc to interrupt*, agy: *esc to cancel*), so the Park
  procedure's `--raw-key Escape` is unchanged.
- **The sentinel contract holds on all three.** Verified end to end: a codex pane launched with the
  flags above, handed a pasted instruction, ran `printf … >> <CYCLE_DIR>/sentinels.log` with no
  approval stall and the line appeared in the file. Sentinels are shell appends, and all three
  engines run shell — this is why the contract is portable and why it must stay a file append
  rather than a pane-scrape.
