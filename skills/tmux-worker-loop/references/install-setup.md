# Install & verify: tmux + codex

Run these checks **before** the first cycle on a new machine. Both tools are mandatory — without tmux there is no worker pane; without codex the adversarial review gate silently degrades to "skipped" and the worker can land subtly broken plans/code.

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

Do NOT proceed to the cycle with degraded codex; the adversarial review gate is the whole point of this skill.
