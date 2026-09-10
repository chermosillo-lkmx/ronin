#!/usr/bin/env bash
# probe-repo.sh v1
#
# WHY THIS EXISTS
# The worker harness previously guessed test commands on every cycle. A wrong
# guess silently disabled every downstream RGR sensor, so Main now probes each
# declared worktree once and records an executable contract for its slot.
#
# Usage: probe-repo.sh <slot>
# Env: CYCLE_DIR must name the cycle artifacts directory.

set -u

if [ -z "${CYCLE_DIR:-}" ]; then
  echo "probe-repo: CYCLE_DIR unset; export the cycle artifacts directory" >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "probe-repo: usage: probe-repo.sh <slot>" >&2
  exit 1
fi

slot=$1
worktrees_file="$CYCLE_DIR/worktrees.env"
if [ ! -f "$worktrees_file" ]; then
  echo "probe-repo: missing $worktrees_file; declare physical worktree paths first" >&2
  exit 1
fi

validate_registry() {
  awk '
    {
      separator = index($0, "=")
      if (separator == 0) {
        print "invalid registry line; expected <slot>=<physical-path>"
        exit 1
      }
      slot = substr($0, 1, separator - 1)
      path = substr($0, separator + 1)
      if (slot !~ /^[A-Za-z0-9._-]+$/) {
        print "invalid slot \"" slot "\"; use only A-Za-z0-9._-"
        exit 1
      }
      if (path !~ /^\//) {
        print "invalid path for slot \"" slot "\"; record pwd -P output"
        exit 1
      }
      if (++slots[slot] > 1) {
        print "duplicate slot \"" slot "\""
        exit 1
      }
      if (++paths[path] > 1) {
        print "duplicate physical path \"" path "\""
        exit 1
      }
    }
  ' "$1"
}

registry_error=$(validate_registry "$worktrees_file")
registry_status=$?
if [ "$registry_status" -ne 0 ]; then
  echo "probe-repo: $registry_error; fix $worktrees_file before probing" >&2
  exit 1
fi

worktree=$(awk -F= -v wanted="$slot" '$1 == wanted { sub(/^[^=]*=/, ""); print }' "$worktrees_file")
if [ -z "$worktree" ] || [ ! -d "$worktree" ]; then
  echo "probe-repo: slot '$slot' is not a declared worktree in $worktrees_file" >&2
  exit 1
fi

env_file="$CYCLE_DIR/harness.$slot.env"

load_baseline() {
  baseline_ref=$(git -C "$worktree" rev-parse HEAD 2>/dev/null) || {
    echo "probe-repo: cannot resolve the frozen baseline for slot '$slot'" >&2
    return 1
  }
}

write_failure_baseline_contract() {
  printf '%s\n' \
    "FAILSET_FORMAT=$1" \
    'BASELINE_FAILSET=' \
    'BASELINE_FAILURES_N=0' \
    'BASELINE_AT='
}

if [ -f "$worktree/pytest.ini" ] || [ -f "$worktree/pyproject.toml" ] || [ -f "$worktree/setup.cfg" ]; then
  load_baseline || exit 1
  deps_ok=no
  if python3 -c 'import pytest' >/dev/null 2>&1; then
    deps_ok=yes
  fi
  fitness=''
  if [ -f "$worktree/alembic.ini" ] || [ -d "$worktree/alembic/versions" ]; then
    fitness=alembic32
  fi
  {
    printf '%s\n' \
      'STACK=python' \
      'TEST_CMD_N=1' \
      'TEST_CMD_1=pytest' \
      'TEST_ONE_CMD=pytest' \
      'TEST_GLOBS=test_*.py *_test.py' \
      'DOC_GLOBS=README.md docs/**' \
      'IGNORE_GLOBS=poetry.lock uv.lock' \
      'SNAPSHOT_EXCLUDE=.venv venv __pycache__ .pytest_cache *.egg-info' \
      'PASS_FORMAT=pytest'
    write_failure_baseline_contract pytest-rc
    printf '%s\n' \
      "DEPS_OK=$deps_ok" \
      'TEST_TIMEOUT=900' \
      'LINT_CMD=' \
      'TYPECHECK_CMD=' \
      'COVERAGE_CMD=' \
      "BASELINE_REF=$baseline_ref" \
      "FITNESS=$fitness" \
      'MISSING=lint,typecheck,coverage,ci'
  } > "$env_file"
  printf 'probe-repo: wrote %s\n' "$env_file"
  exit 0
fi

if [ ! -f "$worktree/package.json" ]; then
  echo "probe-repo: no detectable test command for slot '$slot'; define the harness contract explicitly" >&2
  exit 1
fi

package_has() {
  node -e 'const p=require(process.argv[1]); const values=process.argv[2] === "workspaces" ? (p.workspaces||[]) : Object.keys(p.scripts||{}); process.exit(values.includes(process.argv[3])?0:1)' \
    "$worktree/package.json" "$1" "$2" >/dev/null 2>&1
}

has_workspace() {
  package_has workspaces "$1"
}

has_script() {
  package_has scripts "$1"
}

if has_workspace server && has_workspace web && has_script test:desktop; then
  test_cmd_n=3
  test_cmd_1='npm test -w server'
  test_cmd_2='npm test -w web'
  test_cmd_3='npm run test:desktop'
else
  if ! has_script test; then
    echo "probe-repo: no detectable test command for slot '$slot'; add a package test script or define the harness contract explicitly" >&2
    exit 1
  fi
  test_cmd_n=1
  test_cmd_1='npm test'
  test_cmd_2=''
  test_cmd_3=''
fi

load_baseline || exit 1
deps_ok=no
if [ -e "$worktree/node_modules" ] && node --import tsx -e '' >/dev/null 2>&1; then
  deps_ok=yes
fi

missing=lint,coverage,ci
{
  printf '%s\n' \
    'STACK=node' \
    "TEST_CMD_N=$test_cmd_n" \
    "TEST_CMD_1=$test_cmd_1"
  [ "$test_cmd_n" -lt 2 ] || printf '%s\n' "TEST_CMD_2=$test_cmd_2"
  [ "$test_cmd_n" -lt 3 ] || printf '%s\n' "TEST_CMD_3=$test_cmd_3"
  printf '%s\n' \
    'TEST_ONE_CMD=node --import tsx --test --test-reporter=tap' \
    'TEST_GLOBS=*.test.ts *.test.mjs' \
    'DOC_GLOBS=skills/README.md README.md EVIDENCIA-*.md docs/**' \
    'IGNORE_GLOBS=package-lock.json' \
    'SNAPSHOT_EXCLUDE=node_modules dist build .next coverage' \
    'PASS_FORMAT=node-tap'
  write_failure_baseline_contract node-junit
  printf '%s\n' \
    "DEPS_OK=$deps_ok" \
    'TEST_TIMEOUT=900' \
    'LINT_CMD=' \
    'TYPECHECK_CMD=' \
    'COVERAGE_CMD=' \
    "BASELINE_REF=$baseline_ref" \
    'FITNESS=' \
    "MISSING=$missing"
} > "$env_file"

printf 'probe-repo: wrote %s\n' "$env_file"
