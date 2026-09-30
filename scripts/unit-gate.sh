#!/bin/bash
# unit-gate.sh — gate de pruebas unitarias para los workflows de Ronin (verifyCmd por etapa).
#
# Regla que hace cumplir (ver docs/unit-gate.md):
#   1. Todo cambio en código de producto (src/**, fuera de migraciones) viene con cambios en tests.
#   2. Los tests nuevos/modificados EXISTEN y se EJECUTAN (aparecen en el junit y pasan).
#   3. La suite unitaria completa del repo pasa (0 failed / 0 errors, >0 tests).
#   4. Las líneas nuevas están cubiertas, el total respeta el piso y el piso no retrocede.
# Sale con 0 sólo si las cuatro se cumplen en TODOS los sub-repos con cambios; cualquier duda
# (sin intérprete, sin junit, sin git) es fallo: un gate nunca da verde por defecto.
#
# Uso: unit-gate.sh [DIR]   (DIR = worktree de la sesión; default: cwd, que es lo que pasa Ronin)
# Env: UNIT_GATE_BASE (default origin/main) · UNIT_GATE_SKIP_SUITE=1 (sólo reglas 1-2, para depurar)
#      UNIT_GATE_MAIN_ROOT (default ~/code/lkmx/liebre: de ahí se toma el .venv si el worktree no tiene)
#      UNIT_GATE_EXTRA_JUNIT (junits extra «a.xml:b.xml», relativos al repo; SÓLO para la regla 2)
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

head_commit_time() { git log -1 --format=%ct 2>/dev/null; } # epoch del commit HEAD del repo actual

# Regla 2 (y sólo la 2) puede apoyarse en UNIT_GATE_EXTRA_JUNIT: junits de corridas aparte (p. ej.
# pruebas de BD real), separados por «:» y relativos al repo. Fail-closed: uno inexistente, ilegible
# o anterior al último commit se imprime como faltante (→ FAIL); un archivo con fallos ahí no cuenta.
# Los ❌/✅ de la evidencia extra van a stderr; stdout sigue siendo sólo la lista de faltantes.
tests_ran_from() { # $1 junit.xml, $2.. changed test files → imprime los que NO aparecen ejecutados y pasando
  GATE_EXTRA_JUNIT="${UNIT_GATE_EXTRA_JUNIT:-}" GATE_HEAD_CT="$(head_commit_time)" GATE_REPO="$(basename "$PWD")" \
  python3 - "$@" <<'PY'
import os, sys, re, xml.etree.ElementTree as ET
junit, files = sys.argv[1], sys.argv[2:]
repo = os.environ.get("GATE_REPO", "")
err = lambda msg: print(msg, file=sys.stderr)

def outcomes(path):  # → (claves con casos que pasan, claves con casos que fallan/revientan)
    passed, failed = set(), set()
    for tc in ET.parse(path).getroot().iter("testcase"):
        key = (tc.get("classname") or "") + "|" + (tc.get("file") or "")
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.add(key)
        elif tc.find("skipped") is None:
            passed.add(key)
    return passed, failed

def hit(f, keys):
    mod = re.sub(r"\.(py|ts|tsx|js|jsx)$", "", f).replace("/", ".")
    return any(k.split("|")[0].startswith(mod) or f in k.split("|")[1] or k.split("|")[0].endswith(f) for k in keys)

suite_passed, _ = outcomes(junit)
missing = [f for f in files if not hit(f, suite_passed)]

extras = [p for p in os.environ.get("GATE_EXTRA_JUNIT", "").split(":") if p.strip()]
if extras:
    head_ct = os.environ.get("GATE_HEAD_CT", "").strip()
    problems, via, broken = [], [], []
    if not head_ct.isdigit():
        problems.append("no pude leer la hora del último commit (git log -1 --format=%ct)")
    for p in extras:
        if not os.path.isfile(p):
            problems.append(f"{p}: no existe"); continue
        if head_ct.isdigit() and os.path.getmtime(p) < int(head_ct):
            problems.append(f"{p}: junit extra anterior al último commit: vuelve a correr esas pruebas"); continue
        try:
            ep, ef = outcomes(p)
        except (ET.ParseError, OSError) as e:
            problems.append(f"{p}: no se pudo leer como junit ({e})"); continue
        for f in files:
            if hit(f, ef):
                if f not in broken:
                    broken.append(f)
                err(f"❌ {repo}: UNIT_GATE_EXTRA_JUNIT {p} tiene casos que FALLAN de {f}: no cuenta para la regla 2")
            elif hit(f, ep) and f in missing and f not in via:
                via.append(f)
    via = [f for f in via if f not in broken]
    for msg in problems:
        err(f"❌ {repo}: UNIT_GATE_EXTRA_JUNIT inválido — {msg}")
    if via and not problems:
        err(f"✅ {repo}: tests tocados ejecutados vía UNIT_GATE_EXTRA_JUNIT: {' '.join(via)}")
    missing = [f for f in files if (f in missing and f not in via) or f in broken]
    missing += [f"(UNIT_GATE_EXTRA_JUNIT inválido — {msg})" for msg in problems]
for f in missing:
    print(f)
PY
}

coverage_rule() { # $1 base, $2 coverage.xml, $3 runner; usa GATE_CHANGED/GATE_SRC_CHANGED
  GATE_BASE="$1" GATE_COVERAGE="$2" GATE_RUNNER="$3" python3 <<'PY'
import configparser
import fnmatch
import os
import re
import subprocess
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from pathlib import Path

repo = Path.cwd().resolve()
base = os.environ["GATE_BASE"]
coverage_path = Path(os.environ["GATE_COVERAGE"])
runner = os.environ["GATE_RUNNER"]
changed = [p for p in os.environ.get("GATE_CHANGED", "").splitlines() if p]
src_changed = [p for p in os.environ.get("GATE_SRC_CHANGED", "").splitlines() if p]

def emit(kind, message):
    print(f"{kind}\t{message}")

def added_lines(path):
    file_path = repo / path
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0
    if not tracked:
        if not file_path.is_file():
            return set()
        return set(range(1, len(file_path.read_text(errors="replace").splitlines()) + 1))
    diff = subprocess.run(
        ["git", "diff", "--unified=0", base, "--", path],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    ).stdout
    result = set()
    for line in diff.splitlines():
        match = re.match(r"@@ .* \+(\d+)(?:,(\d+))? @@", line)
        if not match:
            continue
        start = int(match.group(1))
        count = int(match.group(2) or 1)
        result.update(range(start, start + count))
    return result

def text_at(path, line_number):
    try:
        lines = (repo / path).read_text(errors="replace").splitlines()
        return lines[line_number - 1] if 0 < line_number <= len(lines) else ""
    except OSError:
        return ""

def parse_ini(text, section):
    parser = configparser.ConfigParser(
        interpolation=None,
        strict=False,
        inline_comment_prefixes=("#", ";"),
    )
    try:
        match = re.search(rf"(?m)^\s*\[{re.escape(section)}\]\s*$", text)
        if not match:
            return None
        tail = text[match.end():]
        next_section = re.search(r"(?m)^\s*\[[^]]+\]\s*$", tail)
        body = tail[:next_section.start()] if next_section else tail
        parser.read_string(f"[{section}]\n{body}")
        return Decimal(parser.get(section, "fail_under"))
    except (configparser.Error, KeyError, ValueError, InvalidOperation):
        return None

def parse_floor_from(path, text):
    if path == ".coveragerc":
        return parse_ini(text, "report")
    if path == "pyproject.toml":
        return parse_ini(text, "tool.coverage.report")
    if path == "setup.cfg":
        return parse_ini(text, "coverage:report")
    if path == "vitest.config.ts":
        without_comments = re.sub(r"/\*[\s\S]*?\*/|//[^\n]*", "", text)
        coverage = js_object(without_comments, "coverage")
        if coverage is None:
            return None
        match = re.search(r"thresholds\s*:\s*\{[\s\S]*?\blines\s*:\s*(\d+(?:\.\d+)?)", coverage)
        return Decimal(match.group(1)) if match else None
    return None

def js_object(text, name):
    match = re.search(rf"\b{re.escape(name)}\s*:\s*\{{", text)
    if not match:
        return None
    start = text.find("{", match.start())
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:index]
    return None

def current_floor():
    paths = ["vitest.config.ts"] if runner == "node" else [".coveragerc", "pyproject.toml", "setup.cfg"]
    for path in paths:
        try:
            value = parse_floor_from(path, (repo / path).read_text())
        except OSError:
            continue
        if value is not None:
            return value
    return None

def base_floor():
    paths = ["vitest.config.ts"] if runner == "node" else [".coveragerc", "pyproject.toml", "setup.cfg"]
    for path in paths:
        shown = subprocess.run(
            ["git", "show", f"{base}:{path}"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        if shown.returncode == 0:
            value = parse_floor_from(path, shown.stdout)
            if value is not None:
                return value
    return None

def fmt(value):
    return f"{value.quantize(Decimal('0.01')):.2f}"

def resolve_filename(filename, sources):
    raw = Path(filename)
    candidates = []
    if raw.is_absolute():
        candidates.append(raw)
    for source in sources:
        source_path = Path(source)
        if not source_path.is_absolute():
            source_path = repo / source_path
        candidates.append(source_path / raw)
    candidates.append(repo / raw)
    inside = []
    for candidate in candidates:
        resolved = candidate.resolve()
        try:
            relative = resolved.relative_to(repo).as_posix()
        except ValueError:
            continue
        if resolved.exists():
            return relative
        inside.append(relative)
    return inside[0] if inside else None

def new_config_exclusions(path):
    if path not in {".coveragerc", "pyproject.toml", "setup.cfg", "vitest.config.ts"}:
        return []
    file_path = repo / path
    if not file_path.is_file():
        return []
    added = added_lines(path)
    lines = file_path.read_text(errors="replace").splitlines()
    found = []
    if path == "vitest.config.ts":
        in_exclude = False
        brackets = 0
        braces = 0
        coverage_depth = None
        for number, line in enumerate(lines, 1):
            started_exclude = False
            if coverage_depth is None and re.search(r"\bcoverage\s*:\s*\{", line):
                coverage_depth = braces + 1
            exclude = re.search(r"\bexclude\s*:\s*(.*)$", line) if coverage_depth is not None and not in_exclude else None
            if exclude:
                started_exclude = True
                value = exclude.group(1).strip().rstrip(",")
                if not value:
                    if number in added:
                        found.append((number, line.strip()))
                elif not value.startswith("["):
                    if number in added and value:
                        found.append((number, line.strip()))
                else:
                    in_exclude = True
                    brackets = value.count("[") - value.count("]")
                    inline = value.split("[", 1)[1].rsplit("]", 1)[0].strip(" ,") if "]" in value else ""
                    if number in added and inline:
                        found.append((number, line.strip()))
                if in_exclude and brackets <= 0:
                    in_exclude = False
            if in_exclude and not started_exclude:
                if number in added and line.strip().strip("[],"):
                    found.append((number, line.strip()))
                brackets += line.count("[") - line.count("]")
                if brackets <= 0:
                    in_exclude = False
            braces += line.count("{") - line.count("}")
            if coverage_depth is not None and braces < coverage_depth:
                coverage_depth = None
        return found
    in_omit = False
    array_mode = False
    for number, line in enumerate(lines, 1):
        match = re.match(r"\s*omit\s*=\s*(.*)$", line)
        if match:
            in_omit = True
            value = match.group(1).strip()
            array_mode = value.startswith("[") and "]" not in value
            inline = value.strip("[] ,")
            if number in added and inline:
                found.append((number, line.strip()))
            if value and not array_mode and not line[:1].isspace():
                in_omit = False
            continue
        if not in_omit:
            continue
        stripped = line.strip()
        if array_mode:
            value = stripped.strip("[] ,")
            if number in added and value and not value.startswith("#"):
                found.append((number, stripped))
            if "]" in line:
                in_omit = False
        elif stripped.startswith("[") or (line[:1] and not line[:1].isspace()):
            in_omit = False
        elif number in added and stripped and not stripped.startswith(("#", ";")):
            found.append((number, stripped))
    return found

NOT_MEASURED = re.compile(r"\.(test|spec|stories)\.[cm]?[jt]sx?$|(^|/)__tests__/|\.d\.ts$")

def omit_patterns(text):
    # Patrones de [run] omit de .coveragerc; sólo cuentan los del merge-base (un omit nuevo es trinquete aparte).
    match = re.search(r"(?m)^\s*\[run\]\s*$", text or "")
    if not match:
        return []
    patterns, in_omit = [], False
    for line in text[match.end():].splitlines():
        if re.match(r"\s*\[", line):
            break
        head = re.match(r"\s*omit\s*=\s*(.*)$", line)
        if head:
            in_omit = True
            patterns += [p.strip() for p in head.group(1).split(",") if p.strip()]
            continue
        if in_omit and line[:1].isspace() and line.strip() and not line.strip().startswith(("#", ";")):
            patterns.append(line.strip())
        elif line.strip() and not line[:1].isspace():
            in_omit = False
    return patterns

base_omit = []
if runner == "python":
    shown = subprocess.run(["git", "show", f"{base}:.coveragerc"], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if shown.returncode == 0:
        base_omit = omit_patterns(shown.stdout)

if not coverage_path.is_file():
    emit("BAD", f"la suite no produjo {coverage_path.as_posix()} (XML de cobertura)")
else:
    try:
        root = ET.parse(coverage_path).getroot()
        total = (Decimal(root.attrib["line-rate"]) * 100).quantize(Decimal("0.01"))
        sources = [(node.text or "").strip() for node in root.findall(".//sources/source") if (node.text or "").strip()]
        report_lines = {}
        reported_files = set()
        for cls in root.iter("class"):
            filename = cls.get("filename")
            if not filename:
                continue
            relative = resolve_filename(filename, sources)
            if relative is None:
                continue
            reported_files.add(relative)
            hits = report_lines.setdefault(relative, {})
            for line in cls.findall(".//line"):
                try:
                    number = int(line.get("number", ""))
                    count = int(float(line.get("hits", "0")))
                except ValueError:
                    continue
                hits[number] = max(hits.get(number, 0), count)
    except (ET.ParseError, OSError, KeyError, InvalidOperation) as error:
        emit("BAD", f"no pude leer {coverage_path.as_posix()} como Cobertura ({error})")
    else:
        uncovered = []
        missing_files = []
        executable_new = 0
        omitted = []
        for path in src_changed:
            file_path = repo / path
            if NOT_MEASURED.search(path):
                continue  # pruebas/stories/tipos: la cobertura no los mide
            if file_path.is_file() and file_path.suffix in {".py", ".ts", ".tsx", ".js", ".jsx"} and path not in reported_files:
                if any(fnmatch.fnmatch(path, pattern) for pattern in base_omit):
                    omitted.append(path)
                else:
                    missing_files.append(path)
                continue
            for number in sorted(added_lines(path)):
                if number not in report_lines.get(path, {}):
                    continue
                executable_new += 1
                if report_lines[path][number] == 0:
                    uncovered.append(f"{path}:{number}")
        if omitted:
            emit("WARN", "src cambiado bajo un omit que ya existía en el merge-base (no se mide; es deuda): " + " ".join(omitted))
        if missing_files:
            emit("BAD", "archivo(s) de src cambiado(s) no aparece en el reporte de cobertura: " + " ".join(missing_files))
        if uncovered:
            emit("BAD", "líneas nuevas sin cubrir: " + " ".join(uncovered))
        elif not missing_files:
            emit("OK", f"{executable_new} líneas nuevas de src, todas cubiertas")

        floor = current_floor()
        if floor is None:
            emit("BAD", "sin piso de cobertura declarado")
        elif total < floor:
            emit("BAD", f"cobertura {fmt(total)} % < piso {fmt(floor)} %")
        else:
            emit("OK", f"cobertura {fmt(total)} % ≥ piso {fmt(floor)} %")
        old_floor = base_floor()
        if floor is not None and old_floor is not None and floor < old_floor:
            emit("BAD", f"piso bajado de {fmt(old_floor)} a {fmt(floor)}")

patterns = re.compile(r"pragma:\s*no cover|istanbul\s+ignore|c8\s+ignore|v8\s+ignore", re.IGNORECASE)
for path in changed:
    if path == "tests" or path.startswith("tests/"):
        continue
    for number in sorted(added_lines(path)):
        line = text_at(path, number)
        if patterns.search(line):
            emit("BAD", f"exclusión de cobertura agregada: {path}:{number}: {line.strip()}")
    for number, line in new_config_exclusions(path):
        emit("BAD", f"entrada nueva en omit/coverage.exclude: {path}:{number}: {line}")
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
        say "   ⚠ $f: ningún test tocado menciona «${stem}» (revisa que el cambio tenga prueba propia)"
      fi
    done <<< "$src_changed"
  else
    ok "$name: sin cambios en src (sólo tests/docs/config)"
  fi

  [ "${UNIT_GATE_SKIP_SUITE:-0}" = "1" ] && continue

  # Reglas 3 y 4 comparten la misma corrida: suite completa + XML de cobertura.
  mkdir -p reports
  junit="reports/junit-gate.xml"; rm -f "$junit"
  if [ -d tests ] && { [ -f pytest.ini ] || [ -f pyproject.toml ] || [ -f setup.cfg ] || find tests -name 'test_*.py' -print -quit 2>/dev/null | grep -q .; }; then
    runner="python"; coverage_xml="reports/coverage-gate.xml"; rm -f "$coverage_xml"
    PY="$(py_for "$repo")" || { bad "$name: sin intérprete (.venv) ni en el worktree ni en $MAIN_ROOT/$name"; continue; }
    extra=()
    case "$name" in ant-ms-cfdis) extra=(-o log_cli=false -m "not functional");; esac
    say "   → $PY -m pytest tests -q -o addopts='' ${extra[*]+"${extra[*]}"} -p no:cacheprovider --cov=src --cov-report=xml:$coverage_xml --junitxml=$junit"
    "$PY" -m pytest tests -q -o addopts="" ${extra[@]+"${extra[@]}"} --continue-on-collection-errors --color=no -p no:cacheprovider --cov=src --cov-report="xml:$coverage_xml" --junitxml="$junit" > reports/unit-gate.log 2>&1
    rc=$?
  elif [ -f package.json ]; then
    [ -d node_modules ] || { bad "$name: sin node_modules en el worktree (corre npm ci antes)"; continue; }
    runner="node"; coverage_xml="reports/coverage-gate/cobertura-coverage.xml"
    mkdir -p reports/coverage-gate; rm -f "$coverage_xml"
    say "   → npx vitest run --coverage --coverage.reporter=cobertura --coverage.reportsDirectory=reports/coverage-gate --reporter=junit --outputFile=$junit"
    npx vitest run --coverage --coverage.reporter=cobertura --coverage.reportsDirectory=reports/coverage-gate --reporter=junit --outputFile="$junit" > reports/unit-gate.log 2>&1
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

  # Regla 4: líneas nuevas cubiertas, piso total y trinquete de exclusiones/umbral.
  coverage_output="$(GATE_CHANGED="$changed" GATE_SRC_CHANGED="$src_changed" coverage_rule "$base" "$coverage_xml" "$runner" 2>&1)"
  coverage_rc=$?
  if [ "$coverage_rc" -ne 0 ]; then
    bad "$name: el analizador de cobertura falló (rc=$coverage_rc)"
  else
    while IFS=$'\t' read -r result message; do
      case "$result" in
        OK) ok "$name: $message";;
        BAD) bad "$name: $message";;
        WARN) say "   ⚠ $name: $message";;
      esac
    done <<< "$coverage_output"
  fi
done

[ "$checked" -eq 0 ] && say "· ningún sub-repo con cambios: nada que gatear (verde)"
if [ "$fail" -ne 0 ]; then say "UNIT-GATE: FAIL"; exit 1; fi
say "UNIT-GATE: PASS"; exit 0
