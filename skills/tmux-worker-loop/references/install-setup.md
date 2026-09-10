# Install & verify: tmux + codex + agy

Run these checks **before** the first cycle on a new machine.

**tmux is mandatory** — without it there are no worker panes and the skill cannot run at all.

**codex and agy are strongly preferred but not mandatory**, because each has a Claude fallback
(Reviewer → `claude --model opus`, Implementer → `claude --model sonnet`). Their absence does not
stop the cycle; it removes the independent-engine property that makes the review adversarial rather
than self-similar. So: install them if you can, tell the user once if you cannot, and proceed on the
fallback rather than stalling.

Installation and quota are different questions and a machine can pass one while failing the other —
the live "is it usable right now" check is the preflight probe in `engines.md`, not this file.

## tmux

`command -v tmux`. If empty, ask the user:

> "tmux is not installed on this machine, which this skill requires. Want me to install it for you, or would you prefer install instructions to run yourself?"

If install (confirm before executing — touches the system):
- **macOS** (`uname` = Darwin): `brew install tmux` (verify `brew` exists; if not, point them at https://brew.sh).
- **Debian/Ubuntu** (`apt-get` exists): `sudo apt-get update && sudo apt-get install -y tmux`.
- **Fedora/RHEL** (`dnf` exists): `sudo dnf install -y tmux`.
- **Arch** (`pacman` exists): `sudo pacman -S --noconfirm tmux`.
- **Alpine** (`apk` exists): `sudo apk add tmux`.

Re-run `command -v tmux` to confirm.

## codex plugin + CLI

```bash
plugins_json="$HOME/.claude/plugins/installed_plugins.json"
plugin_ok=0
if [ -f "$plugins_json" ] && grep -q '"codex@openai-codex"' "$plugins_json"; then
  plugin_ok=1
fi

cli_ok=0
if command -v codex >/dev/null 2>&1; then
  cli_ok=1
fi

echo "plugin_ok=$plugin_ok cli_ok=$cli_ok"
```

Both must be `1`. If either is `0`:

> "The codex plugin or its CLI isn't set up — this skill needs it for adversarial review of the plan and diff. Want me to install/configure it, or just give you the instructions to run yourself?"

**Plugin missing (`plugin_ok=0`)** — the user runs these in the Claude Code UI; you cannot run them via Bash:
1. `/plugin marketplace add openai/codex-plugin-cc`
2. `/plugin install codex@openai-codex`
3. Restart Claude Code so the new skills load.

**CLI missing (`cli_ok=0`):**
- **macOS** (Homebrew): `brew install codex` (the formula installs `codex-cli`; verify with `codex --version`).
- **npm (cross-platform)**: `npm install -g @openai/codex-cli`.
- **Manual**: https://github.com/openai/codex.

After install: `command -v codex && codex --version`.

**Auth / config:** tell the user to run `/codex:setup` (checks runtime, prompts for `OPENAI_API_KEY`, toggles stop-time review gate). Manual fallback:
1. `export OPENAI_API_KEY=sk-...` in `~/.zshrc` or `~/.bashrc`.
2. `codex login` if the CLI version requires interactive auth.
3. Verify with `codex exec "say hello"`.

**The codex plugin is optional now; the CLI is what matters.** The Reviewer runs codex as a live
pane, driven by `relay.sh`, not through `codex:codex-rescue`. `plugin_ok=0` with `cli_ok=1` is a
perfectly workable machine.

**codex trusts directories, not machines.** A launch in an unknown directory opens on
`Do you trust the contents of this directory?` and the pane never reaches its prompt. Since every
cycle runs in a fresh worktree, pre-seed `[projects."<path>"] trust_level = "trusted"` into
`~/.codex/config.toml` before launching — snippet in `engines.md`.

If codex is unusable, run the Reviewer on `claude --model opus` and say so in the report — the gate
still happens, just without a second model family attacking the work.

## agy (Antigravity CLI)

```bash
command -v agy && agy --version
```

If missing, point the user at the Antigravity CLI install for their platform; `agy install`
configures PATH and shell aliases once the binary is on disk. There is no plugin to add.

**Check what the account can actually run** — this is not the same as what the CLI lists:

```bash
agy models
```

`agy models` prints the whole catalogue, **not your entitlement**. Verified on a
"Antigravity Starter Quota" account: `agy models` listed `gemini-3.1-pro-high`, and launching with
it produced `⚠ "gemini-3.1-pro-high" is no longer available. Using "Gemini 3.6 Flash (High)".` —
a silent downgrade, not an error. Pick the strongest model the **banner** confirms, not the
strongest the list mentions. See `engines.md` for the assertion that catches this.

**Trust + permissions, both needed before an agy pane is usable:**

1. **Workspace trust.** A first launch in an untrusted directory opens on
   *"Do you trust the contents of this project?"* and every paste lands in that menu. Pre-seed the
   worktree into `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` (snippet in
   `engines.md`).
2. **Tool permissions.** agy asks for approval on **every** shell command, including the sentinel
   append — verified interactively (`Requesting permission for: printf … Do you want to proceed?`),
   and headlessly it does not even ask, it auto-denies: `no output produced — a tool required the
   "command" permission that headless mode cannot prompt for, so it was auto-denied`. Either add
   allow-rules under `permissions.allow` in that same settings file, or launch the pane with
   `--dangerously-skip-permissions`. **Ask the user which they want the first time; do not silently
   pick the bypass on their machine.** Whichever they choose, one of them is mandatory — an
   unconfigured agy pane stalls on its first sentinel and, because the menu keeps `esc to cancel` in
   the footer, it stalls *looking busy*.

If agy is unusable, run the Implementer on `claude --model sonnet` and say so in the report.
