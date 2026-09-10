#!/usr/bin/env bash
# fitness.sh v1
#
# WHY THIS EXISTS
# The Alembic revision-length rule used to live only as repeated prompt prose,
# so nothing executed it against the changed migration files. This command is
# the table-driven home for repository-specific fitness checks.
#
# Usage: fitness.sh <slot>
# Env: CYCLE_DIR must name the cycle artifacts directory.

set -u

die() {
  echo "fitness: $1" >&2
  exit "${2:-1}"
}

env_get() {
  awk -F= -v wanted="$1" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

alembic_revisions() {
  awk '
    /^[[:space:]]*revision([[:space:]]*:[[:space:]]*str)?[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      quote = substr(value, 1, 1)
      if (quote != "\"" && quote != "\047") next
      value = substr(value, 2)
      finish = index(value, quote)
      if (finish) print substr(value, 1, finish - 1)
    }
  ' "$1"
}

changed_worktree_files() {
  {
    git -C "$worktree" diff --name-only "$1" --
    git -C "$worktree" ls-files --others --exclude-standard
  } | LC_ALL=C sort -u
}

fitness_alembic32() {
  local baseline_ref changed_files changed_file revisions revision violations
  baseline_ref=$(env_get BASELINE_REF)
  [ -n "$baseline_ref" ] || die "BASELINE_REF is empty; rerun probe-repo.sh $slot"
  git -C "$worktree" cat-file -e "$baseline_ref^{commit}" 2>/dev/null \
    || die "BASELINE_REF does not name a commit: $baseline_ref"
  changed_files=$(changed_worktree_files "$baseline_ref") \
    || die "cannot enumerate the diff from BASELINE_REF=$baseline_ref"
  violations=0
  while IFS= read -r changed_file; do
    [ -n "$changed_file" ] || continue
    case "$changed_file" in */versions/*.py|versions/*.py) ;; *) continue ;; esac
    [ -f "$worktree/$changed_file" ] || continue
    revisions=$(alembic_revisions "$worktree/$changed_file")
    while IFS= read -r revision; do
      [ -n "$revision" ] || continue
      if [ "${#revision}" -gt 32 ]; then
        echo "fitness: alembic32 violation file=$changed_file revision=$revision length=${#revision} max=32" >&2
        violations=1
      fi
    done <<EOF
$revisions
EOF
  done <<EOF
$changed_files
EOF
  [ "$violations" -eq 0 ] || return 2
}

[ -n "${CYCLE_DIR:-}" ] || die "CYCLE_DIR unset; export the cycle artifacts directory"
[ -d "$CYCLE_DIR" ] || die "CYCLE_DIR does not exist: $CYCLE_DIR"
CYCLE_DIR=$(cd "$CYCLE_DIR" && pwd -P) || die "cannot resolve CYCLE_DIR"
[ "$#" -eq 1 ] || die "usage: fitness.sh <slot>"
slot=$1

worktrees_file="$CYCLE_DIR/worktrees.env"
[ -f "$worktrees_file" ] || die "missing $worktrees_file; declare physical worktree paths first"
worktree=$(awk -F= -v wanted="$slot" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$worktrees_file")
[ -n "$worktree" ] && [ -d "$worktree" ] \
  || die "slot '$slot' is not a declared worktree; run probe-repo.sh after declaring it"

env_file="$CYCLE_DIR/harness.$slot.env"
[ -f "$env_file" ] || die "missing $env_file; run probe-repo.sh $slot first"
fitness=$(env_get FITNESS)

case "$fitness" in
  '') exit 0 ;;
  *)
    for fitness_rule in $fitness; do
      case "$fitness_rule" in
        alembic32) fitness_alembic32 || exit $? ;;
        *) die "unsupported FITNESS rule '$fitness_rule'; update fitness.sh before enabling it" ;;
      esac
    done
    ;;
esac
