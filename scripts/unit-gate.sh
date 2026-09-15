#!/bin/bash
# unit-gate.sh — gate de pruebas unitarias para los workflows de Ronin (verifyCmd por etapa).
#
# Regla que hace cumplir (ver docs/unit-gate.md):
#   1. Todo cambio en código de producto (src/**, fuera de migraciones) viene con cambios en tests.
#   2. Los tests nuevos/modificados EXISTEN y se EJECUTAN (aparecen en el junit y pasan).
#   3. La suite unitaria completa del repo pasa (0 failed / 0 errors, >0 tests).
# Sale con 0 sólo si las tres se cumplen en TODOS los sub-repos con cambios; cualquier duda
# (sin intérprete, sin junit, sin git) es fallo: un gate nunca da verde por defecto.
#
# Uso: unit-gate.sh [DIR]   (DIR = worktree de la sesión; default: cwd, que es lo que pasa Ronin)
# Env: UNIT_GATE_BASE (default origin/main) · UNIT_GATE_SKIP_SUITE=1 (sólo reglas 1-2, para depurar)
#      UNIT_GATE_MAIN_ROOT (default ~/code/lkmx/liebre: de ahí se toma el .venv si el worktree no tiene)
set -u
ROOT="${1:-$PWD}"
BASE_REF="${UNIT_GATE_BASE:-origin/main}"
MAIN_ROOT="${UNIT_GATE_MAIN_ROOT:-$HOME/code/lkmx/liebre}"
fail=0; checked=0
say() { printf '%s\n' "$*"; }
bad() { say "❌ $*"; fail=1; }
ok()  { say "✅ $*"; }

# Sub-repos candidatos: directorios git inmediatos (o el propio ROOT si es un repo de servicio).
candidates=()
if [ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ]; then
  [ -d "$ROOT/tests" ] || [ -f "$ROOT/package.json" ] && candidates+=("$ROOT")
fi
for d in "$ROOT"/*/; do
  d="${d%/}"; name="$(basename "$d")"
  case "$name" in *-base|node_modules|reports|.*) continue;; esac
  { [ -d "$d/.git" ] || [ -f "$d/.git" ]; } || continue
  [ -d "$d/tests" ] || [ -f "$d/package.json" ] || continue
  candidates+=("$d")
done
[ ${#candidates[@]} -eq 0 ] && { bad "no encontré ningún repo de servicio bajo $ROOT"; exit 1; }

py_for() { # $1 = repo dir
  local r="$1" n; n="$(basename "$r")"
  for p in "$r/.venv/bin/python" "$MAIN_ROOT/$n/.venv/bin/python"; do [ -x "$p" ] && { echo "$p"; return; }; done
  return 1
}

junit_summary() { # $1 = junit.xml → "tests failures errors skipped"
  python3 - "$1" <<'PY'
import sys, xml.etree.ElementTree as ET
r = ET.parse(sys.argv[1]).getroot()
ss = r.findall("testsuite") or [r]
f = lambda k: sum(int(s.get(k, 0) or 0) for s in ss)
print(f("tests"), f("failures"), f("errors"), f("skipped"))
PY
}

tests_ran_from() { # $1 junit.xml, $2.. changed test files → imprime los que NO aparecen ejecutados y pasando
  python3 - "$@" <<'PY'
import sys, re, xml.etree.ElementTree as ET
junit, files = sys.argv[1], sys.argv[2:]
r = ET.parse(junit).getroot()
passed = set()
for tc in r.iter("testcase"):
    if tc.find("failure") is not None or tc.find("error") is not None or tc.find("skipped") is not None:
        continue
    passed.add((tc.get("classname") or "") + "|" + (tc.get("file") or ""))
for f in files:
    mod = re.sub(r"\.(py|ts|tsx|js|jsx)$", "", f).replace("/", ".")
    hit = any(k.split("|")[0].startswith(mod) or f in k.split("|")[1] or k.split("|")[0].endswith(f) for k in passed)
    if not hit:
        print(f)
PY
}

for repo in "${candidates[@]}"; do
  name="$(basename "$repo")"
  cd "$repo" || { bad "$name: no puedo entrar"; continue; }
  git fetch -q origin main 2>/dev/null || true
  base="$(git merge-base HEAD "$BASE_REF" 2>/dev/null)" || { bad "$name: sin merge-base con $BASE_REF"; continue; }
  # Cambios de la rama + working tree (el worker puede no haber commiteado aún).
  changed="$( { git diff --name-only "$base" HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } 2>/dev/null | sort -u)"
  [ -z "$changed" ] && { say "· $name: sin cambios respecto a $BASE_REF — se omite"; continue; }
  checked=$((checked+1))
  src_changed="$(printf '%s\n' "$changed" | grep -E '^(src|app|lib)/.*\.(py|ts|tsx|js|jsx)$' | grep -vE '/migrations/|/__pycache__/' || true)"
  test_changed="$(printf '%s\n' "$changed" | grep -E '(^|/)tests?/.*\.(py|ts|tsx|js|jsx)$|\.(test|spec)\.(ts|tsx|js|jsx)$' | grep -vE 'conftest\.py$|/fixtures?/|/support/|/__snapshots__/' || true)"
  say "── $name  (base $(git rev-parse --short "$base"), $(printf '%s\n' "$changed" | wc -l | tr -d ' ') archivos cambiados)"

  # Regla 1: código de producto sin tests que lo acompañen.
  if [ -n "$src_changed" ] && [ -z "$test_changed" ]; then
    bad "$name: hay cambios en código de producto sin ningún cambio en tests:"
    printf '%s\n' "$src_changed" | sed 's/^/     /'
  elif [ -n "$src_changed" ]; then
    ok "$name: $(printf '%s\n' "$src_changed" | wc -l | tr -d ' ') archivo(s) de src con $(printf '%s\n' "$test_changed" | wc -l | tr -d ' ') archivo(s) de tests tocados"
    # Aviso (no bloquea): módulos de src cuyo nombre no aparece en ningún test tocado.
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      stem="$(basename "$f")"; stem="${stem%.*}"
      if ! printf '%s\n' "$test_changed" | xargs -I{} grep -l -- "$stem" {} 2>/dev/null | grep -q .; then
        say "   ⚠ $f: ningún test tocado menciona «$stem» (revisa que el cambio tenga prueba propia)"
      fi
    done <<< "$src_changed"
  else
    ok "$name: sin cambios en src (sólo tests/docs/config)"
  fi

  [ "${UNIT_GATE_SKIP_SUITE:-0}" = "1" ] && continue

  # Regla 3: la suite completa pasa. Regla 2: los tests tocados se ejecutaron y pasaron.
  mkdir -p reports
  junit="reports/junit-gate.xml"; rm -f "$junit"
  if [ -d tests ] && { [ -f pytest.ini ] || [ -f pyproject.toml ] || [ -f setup.cfg ] || find tests -name 'test_*.py' -print -quit 2>/dev/null | grep -q .; }; then
    PY="$(py_for "$repo")" || { bad "$name: sin intérprete (.venv) ni en el worktree ni en $MAIN_ROOT/$name"; continue; }
    extra=()
    case "$name" in ant-ms-cfdis) extra=(-o log_cli=false -m "not functional");; esac
    say "   → $PY -m pytest tests -q -o addopts='' ${extra[*]+"${extra[*]}"} -p no:cacheprovider --junitxml=$junit"
    "$PY" -m pytest tests -q -o addopts="" ${extra[@]+"${extra[@]}"} --continue-on-collection-errors --color=no -p no:cacheprovider --junitxml="$junit" > reports/unit-gate.log 2>&1
    rc=$?
  elif [ -f package.json ]; then
    [ -d node_modules ] || { bad "$name: sin node_modules en el worktree (corre npm ci antes)"; continue; }
    say "   → npx vitest run --reporter=junit --outputFile=$junit"
    npx vitest run --reporter=junit --outputFile="$junit" > reports/unit-gate.log 2>&1
    rc=$?
  else
    bad "$name: no reconozco el runner (ni tests/ de pytest ni package.json)"; continue
  fi
  [ -f "$junit" ] || { bad "$name: la suite no produjo $junit (rc=$rc); cola de reports/unit-gate.log:"; tail -15 reports/unit-gate.log | sed 's/^/     /'; continue; }
  read -r t f e s <<< "$(junit_summary "$junit")"
  if [ "$t" -eq 0 ]; then bad "$name: el junit no tiene casos (0 tests)"; continue; fi
  if [ "$f" -ne 0 ] || [ "$e" -ne 0 ]; then
    bad "$name: suite en ROJO — $t tests, $f failed, $e errors, $s skipped"
    grep -E "^(FAILED|ERROR) " reports/unit-gate.log | head -20 | sed 's/^/     /'
    continue
  fi
  ok "$name: suite en verde — $t tests, 0 failed, $s skipped"
  if [ -n "$test_changed" ]; then
    missing="$(tests_ran_from "$junit" $test_changed)"
    if [ -n "$missing" ]; then
      bad "$name: tests tocados que NO aparecen ejecutados y pasando en el junit:"
      printf '%s\n' "$missing" | sed 's/^/     /'
    else
      ok "$name: los $(printf '%s\n' "$test_changed" | wc -l | tr -d ' ') archivo(s) de tests tocados se ejecutaron y pasan"
    fi
  fi
done

[ "$checked" -eq 0 ] && say "· ningún sub-repo con cambios: nada que gatear (verde)"
if [ "$fail" -ne 0 ]; then say "UNIT-GATE: FAIL"; exit 1; fi
say "UNIT-GATE: PASS"; exit 0
