#!/bin/bash
# main-health.sh — mide la salud unitaria de un SHA de main en un worktree desechable.
set -u

usage() { printf 'uso: %s <repo> [--sha <sha>]\n' "$(basename "$0")" >&2; exit 2; }
[ "$#" -ge 1 ] || usage
repo="$1"; shift
requested_sha=""
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = "--sha" ] || usage
  requested_sha="$2"
fi

repo_root="${MAIN_HEALTH_REPO_ROOT:-${UNIT_GATE_MAIN_ROOT:-$HOME/code/lkmx/liebre}}"
health_root="${MAIN_HEALTH_DIR:-$HOME/.cowork/main-health}"
source_repo="$repo_root/$repo"
poll="${MAIN_HEALTH_POLL:-15}"
[[ "$poll" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || poll=15
lock_grace="${MAIN_HEALTH_LOCK_GRACE:-0.1}"
[[ "$lock_grace" =~ ^([0-9]+([.][0-9]+)?|[.][0-9]+)$ ]] || lock_grace=0.1
[ -d "$source_repo/.git" ] || { printf 'main-health: no existe el repo %s\n' "$source_repo" >&2; exit 2; }

git -C "$source_repo" fetch -q origin main || { printf 'main-health: falló git fetch origin main en %s\n' "$repo" >&2; exit 2; }
sha="$(git -C "$source_repo" rev-parse "${requested_sha:-origin/main}^{commit}" 2>/dev/null)" || {
  printf 'main-health: SHA inválido para %s: %s\n' "$repo" "${requested_sha:-origin/main}" >&2
  exit 2
}
repo_health="$health_root/$repo"
json="$repo_health/$sha.json"
error_json="$repo_health/$sha.error.json"
lock="$repo_health/$sha.lock"
short="${sha:0:7}"
wt_parent="$repo_health/wt-$short"
wt="$wt_parent/$repo"
mkdir -p "$repo_health"

print_cached() {
  [ -f "$json" ] || return 1
  cat "$json"
  python3 - "$json" <<'PY' >/dev/null 2>&1
import json, sys
raise SystemExit(0 if json.load(open(sys.argv[1])).get("status") == "green" else 1)
PY
  return $?
}

if [ -f "$json" ]; then
  print_cached
  exit $?
fi

owns_lock=0
while ! mkdir "$lock" 2>/dev/null; do
  if [ -f "$json" ]; then
    print_cached
    exit $?
  fi
  owner="$(cat "$lock/pid" 2>/dev/null || true)"
  if [[ "$owner" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner" 2>/dev/null; then
    sleep "$poll"
    continue
  fi
  # mkdir es atómico, pero el dueño necesita un instante para publicar pid. Un lock todavía
  # vacío sólo se considera abandonado si sigue idéntico después de la gracia de inicialización.
  if ! [[ "$owner" =~ ^[1-9][0-9]*$ ]]; then
    sleep "$lock_grace"
    [ -f "$json" ] && { print_cached; exit $?; }
  fi
  current="$(cat "$lock/pid" 2>/dev/null || true)"
  if [[ "$current" =~ ^[1-9][0-9]*$ ]] && kill -0 "$current" 2>/dev/null; then
    continue
  fi
  if [ "$current" = "$owner" ]; then
    stale="$lock.stale.$$.$RANDOM"
    if mv "$lock" "$stale" 2>/dev/null; then
      rm -rf "$stale"
    fi
  fi
done
printf '%s\n' "$$" > "$lock/.pid.$$"
mv "$lock/.pid.$$" "$lock/pid"
owns_lock=1

cleanup() {
  if [ -n "${wt:-}" ] && [ -e "$wt" ]; then
    git -C "$source_repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  fi
  git -C "$source_repo" worktree prune >/dev/null 2>&1 || true
  rmdir "$wt_parent" 2>/dev/null || true
  if [ "$owns_lock" -eq 1 ] && [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$lock/pid"
    rmdir "$lock" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM INT

# Otro proceso pudo publicar el resultado entre nuestro último chequeo y el mkdir.
if [ -f "$json" ]; then
  print_cached
  exit $?
fi

mkdir -p "$wt_parent"
git -C "$source_repo" worktree add -q --detach "$wt" "$sha" || {
  printf 'main-health: no pude crear el worktree para %s@%s\n' "$repo" "$short" >&2
  exit 2
}

if [ -f "$wt/package.json" ]; then
  if [ -f "$wt/pnpm-lock.yaml" ]; then
    (cd "$wt" && pnpm install --frozen-lockfile) || exit 2
  else
    (cd "$wt" && npm ci) || exit 2
  fi
fi

now_ms() { python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}
started="$(now_ms)"
unit_gate="${MAIN_HEALTH_UNIT_GATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/unit-gate.sh}"
set +e
UNIT_GATE_RECORD_BASE=1 UNIT_GATE_MAIN_HEALTH_AUTO=0 "$unit_gate" "$wt"
gate_rc=$?
set -e
ended="$(now_ms)"
duration=$((ended-started))
reports_rel="${UNIT_GATE_REPORTS_DIR:-reports}"
reports="$wt/$reports_rel"
junit="$reports/junit-gate.xml"

atomic_error() {
  python3 - "$error_json" "$sha" "$junit" "$reports/unit-gate.log" <<'PY'
import json, os, sys, time
from pathlib import Path
target, sha, junit, log = map(Path, sys.argv[1:])
try:
    tail = "\n".join(log.read_text(errors="replace").splitlines()[-30:])
except OSError:
    tail = ""
data = {
    "sha": str(sha),
    "reason": f"la suite no produjo junit ({junit})",
    "at": int(time.time() * 1000),
    "log_tail": tail,
}
temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
temporary.write_text(json.dumps(data, separators=(",", ":")) + "\n")
os.replace(temporary, target)
PY
}

if [ ! -f "$junit" ]; then
  atomic_error
  cat "$error_json"
  exit 2
fi

coverage=""
for candidate in "$reports/coverage-gate.xml" "$reports/coverage-gate/cobertura-coverage.xml"; do
  [ -f "$candidate" ] && { coverage="$candidate"; break; }
done

python3 - "$json" "$sha" "$repo" "$junit" "$coverage" "$wt" "$duration" "$gate_rc" <<'PY'
import configparser
import json
import os
import re
import sys
import time
import tomllib
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path

target, sha, repo, junit, coverage, worktree, duration, gate_rc = sys.argv[1:]
target = Path(target)
worktree = Path(worktree)

root = ET.parse(junit).getroot()
cases = list(root.iter("testcase"))
failed, errors = [], []
skipped = Counter()
for case in cases:
    test_id = f'{case.get("classname") or ""}::{case.get("name") or ""}'
    if case.find("failure") is not None:
        failed.append(test_id)
    if case.find("error") is not None:
        errors.append(test_id)
    skip = case.find("skipped")
    if skip is not None:
        reason = (skip.get("message") or (skip.text or "").strip() or "sin razón")
        skipped[reason] += 1

total = None
uncovered = defaultdict(set)
if coverage:
    cov = ET.parse(coverage).getroot()
    try:
        total = float((Decimal(cov.attrib["line-rate"]) * 100).quantize(Decimal("0.01")))
    except (KeyError, InvalidOperation):
        total = None
    for cls in cov.iter("class"):
        filename = cls.get("filename")
        if not filename:
            continue
        for line in cls.findall(".//line"):
            try:
                number = int(line.get("number", ""))
                hits = int(float(line.get("hits", "0")))
            except ValueError:
                continue
            if hits == 0:
                uncovered[filename].add(number)

def ini_floor(path, section):
    parser = configparser.ConfigParser(interpolation=None, inline_comment_prefixes=("#", ";"))
    try:
        parser.read(path)
        return float(Decimal(parser.get(section, "fail_under")))
    except (OSError, configparser.Error, KeyError, ValueError, InvalidOperation):
        return None

floor = None
for filename, section in ((".coveragerc", "report"), ("setup.cfg", "coverage:report")):
    floor = ini_floor(worktree / filename, section)
    if floor is not None:
        break
if floor is None:
    try:
        report = tomllib.loads((worktree / "pyproject.toml").read_text())["tool"]["coverage"]["report"]
        floor = float(Decimal(str(report["fail_under"])))
    except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError, ValueError, InvalidOperation):
        pass
if floor is None:
    try:
        text = (worktree / "vitest.config.ts").read_text()
        text = re.sub(r"/\*[\s\S]*?\*/|//[^\n]*", "", text)
        match = re.search(r"\bcoverage\s*:\s*\{[\s\S]*?\bthresholds\s*:\s*\{[\s\S]*?\blines\s*:\s*(\d+(?:\.\d+)?)", text)
        if match:
            floor = float(Decimal(match.group(1)))
    except (OSError, InvalidOperation):
        pass

green = len(cases) > 0 and not failed and not errors and (floor is None or (total is not None and total >= floor))
data = {
    "sha": sha,
    "repo": repo,
    "status": "green" if green else "red",
    "tests": len(cases),
    "total": total,
    "floor": floor,
    "failed": failed,
    "errors": errors,
    "skipped": sum(skipped.values()),
    "skipped_by_reason": dict(sorted(skipped.items())),
    "uncovered_by_file": {name: sorted(lines) for name, lines in sorted(uncovered.items())},
    "duration": int(duration),
    "at": int(time.time() * 1000),
    "gate_rc": int(gate_rc),
}
temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
temporary.write_text(json.dumps(data, separators=(",", ":")) + "\n")
os.replace(temporary, target)
PY
rm -f "$error_json"
cat "$json"
status="$(python3 - "$json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["status"])
PY
)"
[ "$status" = "green" ] && exit 0
exit 1
