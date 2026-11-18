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
prefix_length="${MAIN_HEALTH_WORKTREE_PREFIX_LENGTH:-7}"
[[ "$prefix_length" =~ ^[1-9][0-9]*$ ]] || prefix_length=7
short="${sha:0:$prefix_length}"
wt_parent="$repo_health/wt-$short"
wt="$wt_parent/$repo"
path_lock="$wt_parent.lock"
mkdir -p "$repo_health"
diagnostic_log="$repo_health/.$sha.diagnostic.$$"

atomic_error() {
  local reason="$1" log_path="${2:-}"
  python3 - "$error_json" "$sha" "$reason" "$log_path" <<'PY'
import json, os, sys, time
from pathlib import Path
target, sha, reason, log = sys.argv[1:]
try:
    tail = "\n".join(Path(log).read_text(errors="replace").splitlines()[-30:]) if log else ""
except OSError:
    tail = ""
data = {"sha": sha, "reason": reason, "at": int(time.time() * 1000), "log_tail": tail}
target = Path(target)
temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
temporary.write_text(json.dumps(data, separators=(",", ":")) + "\n")
os.replace(temporary, target)
PY
}

publish_error() {
  atomic_error "$1" "${2:-}"
  cat "$error_json"
  exit 2
}

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
lock_token="$$-$RANDOM-$RANDOM"
lock_owner="$$ $lock_token"
while [ "$owns_lock" -eq 0 ]; do
  if mkdir "$lock" 2>/dev/null; then
    # El directorio puede haber sido movido y recreado antes de publicar. La creación
    # exclusiva del owner decide quién posee realmente la ruta que sigue visible.
    if (set -o noclobber; printf '%s\n' "$lock_owner" > "$lock/owner") 2>/dev/null \
      && [ "$(cat "$lock/owner" 2>/dev/null || true)" = "$lock_owner" ]; then
      owns_lock=1
      break
    fi
  fi
  if [ -f "$json" ]; then
    print_cached
    exit $?
  fi
  owner="$(cat "$lock/owner" 2>/dev/null || true)"
  owner_pid="${owner%% *}"
  if [[ "$owner" == *" "* ]] && [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
    sleep "$poll"
    continue
  fi
  # Un creador puede seguir entre mkdir y la publicación exclusiva del token.
  if [ -z "$owner" ]; then
    sleep "$lock_grace"
    [ -f "$json" ] && { print_cached; exit $?; }
  fi
  current="$(cat "$lock/owner" 2>/dev/null || true)"
  current_pid="${current%% *}"
  if [[ "$current" == *" "* ]] && [[ "$current_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$current_pid" 2>/dev/null; then
    continue
  fi
  if [ "$current" = "$owner" ]; then
    stale="$lock.stale.$$.$RANDOM"
    if mv "$lock" "$stale" 2>/dev/null; then
      rm -rf "$stale"
    fi
  fi
done

owns_path_lock=0
path_lock_token="$$-$RANDOM-$RANDOM"
path_lock_owner="$$ $path_lock_token"

acquire_path_lock() {
  local owner owner_pid current current_pid stale
  while [ "$owns_path_lock" -eq 0 ]; do
    if mkdir "$path_lock" 2>/dev/null; then
      if (set -o noclobber; printf '%s\n' "$path_lock_owner" > "$path_lock/owner") 2>/dev/null \
        && [ "$(cat "$path_lock/owner" 2>/dev/null || true)" = "$path_lock_owner" ]; then
        owns_path_lock=1
        return
      fi
    fi
    owner="$(cat "$path_lock/owner" 2>/dev/null || true)"
    owner_pid="${owner%% *}"
    if [[ "$owner" == *" "* ]] && [[ "$owner_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      sleep "$poll"
      continue
    fi
    [ -n "$owner" ] || sleep "$lock_grace"
    current="$(cat "$path_lock/owner" 2>/dev/null || true)"
    current_pid="${current%% *}"
    if [[ "$current" == *" "* ]] && [[ "$current_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$current_pid" 2>/dev/null; then
      continue
    fi
    if [ "$current" = "$owner" ]; then
      stale="$path_lock.stale.$$.$RANDOM"
      if mv "$path_lock" "$stale" 2>/dev/null; then rm -rf "$stale"; fi
    fi
  done
}

cleanup() {
  rm -f "$diagnostic_log"
  if [ -n "${wt:-}" ] && [ -e "$wt" ]; then
    git -C "$source_repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  fi
  git -C "$source_repo" worktree prune >/dev/null 2>&1 || true
  rmdir "$wt_parent" 2>/dev/null || true
  if [ "$owns_path_lock" -eq 1 ] && [ "$(cat "$path_lock/owner" 2>/dev/null || true)" = "$path_lock_owner" ]; then
    rm -f "$path_lock/owner"
    rmdir "$path_lock" 2>/dev/null || true
  fi
  if [ "$owns_lock" -eq 1 ] && [ "$(cat "$lock/owner" 2>/dev/null || true)" = "$lock_owner" ]; then
    rm -f "$lock/owner"
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

# Dos SHA completos pueden compartir los siete primeros caracteres y, por contrato, la
# misma ruta wt-<sha7>. Sólo un proceso puede usar esa ruta hasta retirarla por completo.
acquire_path_lock

# Un dueño muerto puede dejar tanto la ruta como el registro administrativo del worktree.
# La recuperación se hace siempre desde el repo fuente y sólo sobre la ruta exacta de este SHA.
git -C "$source_repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
git -C "$source_repo" worktree prune >/dev/null 2>&1 || true
mkdir -p "$wt_parent"
git -C "$source_repo" worktree add -q --detach "$wt" "$sha" || {
  printf 'main-health: no pude crear el worktree para %s@%s\n' "$repo" "$short" >&2
  exit 2
}

if [ -f "$wt/package.json" ]; then
  if [ -f "$wt/pnpm-lock.yaml" ]; then
    if ! (cd "$wt" && pnpm install --frozen-lockfile) >"$diagnostic_log" 2>&1; then
      publish_error "falló la instalación con pnpm" "$diagnostic_log"
    fi
  else
    if ! (cd "$wt" && npm ci) >"$diagnostic_log" 2>&1; then
      publish_error "falló la instalación con npm" "$diagnostic_log"
    fi
  fi
  rm -f "$diagnostic_log"
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

if [ ! -f "$junit" ]; then
  publish_error "la suite no produjo junit ($junit)" "$reports/unit-gate.log"
fi

coverage=""
for candidate in "$reports/coverage-gate.xml" "$reports/coverage-gate/cobertura-coverage.xml"; do
  [ -f "$candidate" ] && { coverage="$candidate"; break; }
done

validate_xml() {
  python3 - "$1" <<'PY' 2>"$diagnostic_log"
import sys
import xml.etree.ElementTree as ET
try:
    ET.parse(sys.argv[1])
except (OSError, ET.ParseError) as exc:
    print(exc, file=sys.stderr)
    raise SystemExit(1)
PY
}

if ! validate_xml "$junit"; then
  publish_error "JUnit malformado ($junit)" "$diagnostic_log"
fi
if [ -n "$coverage" ] && ! validate_xml "$coverage"; then
  publish_error "Cobertura malformado ($coverage)" "$diagnostic_log"
fi
rm -f "$diagnostic_log"

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
floor = ini_floor(worktree / ".coveragerc", "report")
if floor is None:
    try:
        report = tomllib.loads((worktree / "pyproject.toml").read_text())["tool"]["coverage"]["report"]
        floor = float(Decimal(str(report["fail_under"])))
    except (OSError, tomllib.TOMLDecodeError, KeyError, TypeError, ValueError, InvalidOperation):
        pass
if floor is None:
    floor = ini_floor(worktree / "setup.cfg", "coverage:report")
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
