#!/bin/bash
# e2e-gate.sh — gate de cobertura e2e contra DEV para los workflows de Ronin (ver docs/e2e-gate.md).
#
# Regla del equipo (2026-10): todo criterio de aceptación verificado contra DEV en la etapa `curl`
# también se vuelve una prueba en `e2e_dev/` del repo afectado, corrida con `--route-coverage-xml`,
# para que los endpoints nuevos/cambiados queden cubiertos. Por cada sub-repo con cambios:
#   A. Si cambió alguna ruta (decorador FastAPI añadido/modificado en src/), algún
#      e2e_dev/test_*.py tiene líneas añadidas en la rama o el working tree.
#   B. Si aplica A o se tocó un e2e_dev/test_*.py: hay un junit y una cobertura de rutas de una
#      corrida POSTERIOR al último commit del repo (inexistente/ilegible/vieja → FAIL).
#   C. Cada e2e_dev/test_*.py tocado tiene ≥1 caso que pasa en el junit (los rojos intencionales
#      de OTROS archivos no cuentan).
#   D. Cada ruta cambiada aparece ejercitada (hits>0) en la cobertura.
# Válvula: `e2e_dev/.e2e-gate-skip` con líneas `METHOD /path  # motivo` (⚠, no falla).
# Paths vacíos con prefijo externo: `e2e_dev/.e2e-gate-routes` (`METHOD src/archivo.py /path`).
# Sin red, sin DEV: sólo lee git, junit y XML. Cualquier duda es fallo (default-deny).
#
# Uso: e2e-gate.sh [DIR]   (DIR = worktree de la sesión; default: cwd, que es lo que pasa Ronin)
# Env: E2E_GATE_BASE (default origin/main; NO se hace fetch)
#      E2E_GATE_COVERAGE / E2E_GATE_JUNIT («a.xml:b.xml», relativas al sub-repo; default por repo:
#        ant-liebre-api → reports/route-coverage-e2e.xml + reports/junit-e2e-dev.xml;
#        resto → .e2e_history/route-coverage.xml + .e2e_history/junit.xml)
set -u
ROOT="${1:-$PWD}"
BASE_REF="${E2E_GATE_BASE:-origin/main}"
say() { printf '%s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || { say "❌ sin python3: no puedo leer junit/XML"; say "E2E-GATE: FAIL"; exit 1; }

# Sub-repos candidatos: directorios git inmediatos (o el propio ROOT si es un repo de servicio).
candidates=()
if [ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ]; then candidates+=("$ROOT"); fi
for d in "$ROOT"/*/; do
  [ -d "$d" ] || continue
  d="${d%/}"; name="$(basename "$d")"
  case "$name" in *-base|node_modules|reports|.*) continue;; esac
  { [ -d "$d/.git" ] || [ -f "$d/.git" ]; } || continue
  candidates+=("$d")
done
if [ ${#candidates[@]} -eq 0 ]; then say "❌ no encontré ningún repo de servicio bajo $ROOT"; say "E2E-GATE: FAIL"; exit 1; fi

GATE_BASE="$BASE_REF" python3 - "${candidates[@]}" <<'PY'
import os, re, subprocess, sys, xml.etree.ElementTree as ET

BASE_REF = os.environ["GATE_BASE"]
fail = False
checked = 0
say = lambda m: print(m, flush=True)

def bad(m):
    global fail
    fail = True
    say(f"❌ {m}")

def git(*args):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f"git {' '.join(args)} → {r.returncode}")
    return r.stdout

METHODS = "get|post|put|patch|delete|head|options"
DECO_RE = re.compile(
    r"@\s*(\w+)\s*\.\s*(" + METHODS + r"|api_route)\s*\(\s*(?:path\s*=\s*)?[rRuU]?(\"|')(.*?)\3", re.S)
DECO_START_RE = re.compile(r"^\s*@\s*\w+\s*\.\s*(?:" + METHODS + r"|api_route)\s*\(")
ROUTER_RE = re.compile(r"(\w+)\s*(?::[^=\n]*)?=\s*(?:\w+\.)?APIRouter\s*\(")

def src_of(where):
    return where.rsplit(":", 1)[0]

def show(p):
    return p or '""'

def norm(p):
    p = p.strip()
    if p and not p.startswith("/"):
        p = "/" + p
    return p.rstrip("/") if p != "/" else ""

def router_prefixes(text):
    out = {}
    for m in ROUTER_RE.finditer(text):
        i, depth = m.end(), 1
        while i < len(text) and depth:
            depth += {"(": 1, ")": -1}.get(text[i], 0)
            i += 1
        pm = re.search(r"prefix\s*=\s*[rRuU]?([\"'])(.*?)\1", text[m.end():i], re.S)
        out[m.group(1)] = pm.group(2) if pm else ""
    return out

def added_lines(path, base, untracked):
    if untracked:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return set(range(1, len(fh.read().splitlines()) + 1))
    lines = set()
    for h in re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", git("diff", "-U0", base, "--", path), re.M):
        start, count = int(h.group(1)), int(h.group(2) if h.group(2) is not None else 1)
        lines.update(range(start, start + count))
    return lines

def changed_routes(path, added):
    """→ (rutas [(METHOD, path_mostrado, archivo:línea)], avisos)"""
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    prefixes = router_prefixes(text)
    line_of = lambda pos: text.count("\n", 0, pos) + 1
    routes, notes, covered_starts = [], [], set()
    for m in DECO_RE.finditer(text):
        start, end = line_of(m.start()), line_of(m.end())
        covered_starts.add(start)
        if not added.intersection(range(start, end + 1)):
            continue
        obj, verb, raw = m.group(1), m.group(2), m.group(4)
        if verb == "api_route":
            mm = re.search(r"methods\s*=\s*[\[\(]([^\]\)]*)[\]\)]", text[m.end():m.end() + 600])
            verbs = re.findall(r"[\"'](\w+)[\"']", mm.group(1)) if mm else ["GET"]
        else:
            verbs = [verb]
        shown = norm(prefixes.get(obj, "") + raw)
        for v in verbs:
            routes.append((v.upper(), shown, f"{path}:{start}"))
    for n, ln in enumerate(text.splitlines(), 1):
        if n in added and n not in covered_starts and DECO_START_RE.match(ln):
            notes.append(f"{path}:{n}: decorador de ruta sin path literal reconocible — revísalo a mano")
    return routes, notes

def read_skip(path):
    skips, problems = {}, []
    if not os.path.isfile(path):
        return skips, problems
    with open(path, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            body, _, reason = line.partition("#")
            parts = body.split()
            if len(parts) != 2 or not reason.strip():
                problems.append(f"{path}:{n}: se espera «METHOD /path  # motivo» — «{line}»")
                continue
            p = "" if parts[1] in ('""', "''") else norm(parts[1])
            skips[(parts[0].upper(), p)] = reason.strip()
    return skips, problems

def read_aliases(path):
    """`METHOD src/archivo.py /path` → resuelve el path VACÍO de los decoradores de ese archivo
    (prefijo montado fuera del archivo). Resolver no excusa: la ruta resuelta sigue pasando por D."""
    aliases, problems = {}, []
    if not os.path.isfile(path):
        return aliases, problems
    with open(path, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            if len(parts) != 3 or not parts[2].startswith("/"):
                problems.append(f"{path}:{n}: se espera «METHOD src/archivo.py /path» — «{raw.strip()}»")
                continue
            aliases[(parts[0].upper(), parts[1])] = norm(parts[2])
    return aliases, problems

def excused(route, skips):
    m, p = route
    for (sm, sp), reason in skips.items():
        if sm == m and (sp == p or (p and sp.endswith(p))):
            return reason
    return None

def evidence_paths(env, default):
    v = os.environ.get(env, "")
    lst = [x for x in v.split(":") if x.strip()]
    return lst or [default]

def junit_outcomes(path):
    passed, failed = set(), set()
    for tc in ET.parse(path).getroot().iter("testcase"):
        key = (tc.get("classname") or "") + "|" + (tc.get("file") or "")
        if tc.find("failure") is not None or tc.find("error") is not None:
            failed.add(key)
        elif tc.find("skipped") is None:
            passed.add(key)
    return passed, failed

def junit_hit(f, keys):  # mismo criterio que tests_ran_from de unit-gate.sh
    mod = re.sub(r"\.py$", "", f).replace("/", ".")
    return any(k.split("|")[0].startswith(mod) or f in k.split("|")[1] or k.split("|")[0].endswith(f) for k in keys)

def coverage_routes(path):
    """→ {(METHOD, /path): ejercitada?} de los dos formatos de --route-coverage-xml."""
    out = {}
    def put(label, hit):
        parts = (label or "").split(None, 1)
        if len(parts) != 2:
            return
        k = (parts[0].upper(), norm(parts[1]))
        out[k] = out.get(k, False) or hit
    root = ET.parse(path).getroot()
    for el in root.iter("line"):            # ms-cfdis / ms-permissions
        if el.get("route"):
            put(el.get("route"), int(float(el.get("hits") or 0)) > 0)
    for el in root.iter("method"):          # ant-liebre-api
        name = el.get("name") or ""
        if " " not in name:
            continue
        hit = float(el.get("line-rate") or 0) > 0 or any(
            int(float(l.get("hits") or 0)) > 0 for l in el.iter("line"))
        put(name, hit)
    return out

def fresh_files(repo, label, paths, head_ct, parse):
    """Valida cada evidencia (existe, posterior al último commit, legible) → lista de parseos."""
    results, ok = [], True
    for p in paths:
        if not os.path.isfile(p):
            bad(f"{repo}: {label} {p}: no existe — corre las pruebas e2e tocadas con --junitxml/--route-coverage-xml"); ok = False; continue
        if os.path.getmtime(p) < head_ct:
            bad(f"{repo}: {label} {p}: anterior al último commit: vuelve a correr las pruebas e2e"); ok = False; continue
        try:
            results.append((p, parse(p)))
        except (ET.ParseError, OSError, ValueError) as e:
            bad(f"{repo}: {label} {p}: no se pudo leer ({e})"); ok = False
    return results, ok

def gate_repo(repo_dir):
    global checked
    name = os.path.basename(os.path.abspath(repo_dir))
    os.chdir(repo_dir)
    try:
        base = git("merge-base", "HEAD", BASE_REF).strip()
    except RuntimeError:
        bad(f"{name}: sin merge-base con {BASE_REF}"); return
    try:
        tracked = set(filter(None, git("diff", "--name-only", base).splitlines()))
        untracked = set(filter(None, git("ls-files", "--others", "--exclude-standard").splitlines()))
        head_ct = int(git("log", "-1", "--format=%ct").strip())
    except (RuntimeError, ValueError) as e:
        bad(f"{name}: no pude leer git ({e})"); return
    changed = sorted(tracked | untracked)
    if not changed:
        say(f"· {name}: sin cambios respecto a {BASE_REF} — se omite"); return
    if not os.path.isdir("e2e_dev"):
        say(f"· {name}: sin suite e2e_dev — se omite"); return
    checked += 1
    say(f"── {name}  (base {base[:7]}, {len(changed)} archivos cambiados)")

    routes, seen = [], set()
    for f in changed:
        if not (f.startswith("src/") and f.endswith(".py")) or not os.path.isfile(f):
            continue
        rs, notes = changed_routes(f, added_lines(f, base, f in untracked))
        for n in notes:
            say(f"   ⚠ {n}")
        for m, p, where in rs:
            if (m, p) not in seen:
                seen.add((m, p)); routes.append((m, p, where))

    touched = [f for f in changed
               if re.match(r"^e2e_dev/(?:.*/)?test_[^/]*\.py$", f) and os.path.isfile(f)
               and added_lines(f, base, f in untracked)]

    skips, problems = read_skip("e2e_dev/.e2e-gate-skip")
    aliases, alias_problems = read_aliases("e2e_dev/.e2e-gate-routes")
    for pr in alias_problems:
        bad(f"{name}: {pr}")
    resolved = []
    for m, p, where in routes:
        alias = aliases.get((m, src_of(where))) if not p else None
        if alias:
            say(f"   · {name}: {m} \"\" de {where} resuelta como {m} {alias} (e2e_dev/.e2e-gate-routes)")
            p = alias
        if (m, p) not in [(rm, rp) for rm, rp, _ in resolved] or not p:
            resolved.append((m, p, where))
    routes = resolved
    for pr in problems:
        bad(f"{name}: {pr}")
    pending = []
    for m, p, where in routes:
        reason = excused((m, p), skips)
        if reason is not None:
            say(f"   ⚠ {name}: ruta {m} {show(p)} excusada por e2e_dev/.e2e-gate-skip — {reason}")
        else:
            pending.append((m, p, where))

    if not pending and not touched:
        say(f"✅ {name}: sin rutas cambiadas ni e2e_dev/test_*.py tocados — nada que exigir"); return

    # Regla A
    label = ", ".join(f"{m} {show(p)}" for m, p, _ in pending)
    if pending and not touched:
        bad(f"{name}: cambiaron rutas ({label}) y ningún e2e_dev/test_*.py fue tocado")
    elif pending:
        say(f"✅ {name}: {len(pending)} ruta(s) cambiada(s) con {len(touched)} e2e_dev/test_*.py tocado(s): {' '.join(touched)}")

    # Regla B
    is_api = name == "ant-liebre-api"
    cov_paths = evidence_paths("E2E_GATE_COVERAGE", "reports/route-coverage-e2e.xml" if is_api else ".e2e_history/route-coverage.xml")
    jun_paths = evidence_paths("E2E_GATE_JUNIT", "reports/junit-e2e-dev.xml" if is_api else ".e2e_history/junit.xml")
    covs, cov_ok = fresh_files(name, "cobertura", cov_paths, head_ct, coverage_routes)
    juns, jun_ok = fresh_files(name, "junit", jun_paths, head_ct, junit_outcomes)
    for p, c in covs:
        if not c:
            bad(f"{name}: cobertura {p}: no contiene rutas (¿es la salida de --route-coverage-xml?)"); cov_ok = False

    # Regla C
    if jun_ok and touched:
        passed = set().union(*(j[0] for _, j in juns))
        failed = set().union(*(j[1] for _, j in juns))
        for f in touched:
            if junit_hit(f, passed):
                say(f"✅ {name}: {f} tiene casos que pasan en el junit")
                if junit_hit(f, failed):
                    say(f"   ⚠ {name}: {f} también tiene casos en rojo (se admite: rojos intencionales de defectos conocidos)")
            else:
                bad(f"{name}: {f} no tiene ningún caso que pase en {':'.join(jun_paths)} (¿no se corrió, sólo skips o sólo rojos?)")

    # Regla D
    if cov_ok:
        cov = {}
        for _, c in covs:
            for k, v in c.items():
                cov[k] = cov.get(k, False) or v
        for m, p, where in pending:
            if not p:
                bad(f"{name}: ruta {m} con path vacío ({where}): el prefijo se monta fuera del archivo y no puedo ubicarla en la cobertura — declárala en e2e_dev/.e2e-gate-routes («{m} {src_of(where)} /path/completa»)")
                continue
            cands = [(k, v) for k, v in cov.items() if k[0] == m and (k[1] == p or k[1].endswith(p))]
            if not cands:
                bad(f"{name}: ruta {m} {p} no aparece en la cobertura (¿se corrió con --route-coverage-xml?)")
            elif not any(v for _, v in cands):
                bad(f"{name}: ruta {m} {p} no fue ejercitada por e2e ({', '.join(k[0] + ' ' + k[1] for k, _ in cands)} con 0 hits)")
            else:
                hits = [k[0] + " " + k[1] for k, v in cands if v]
                say(f"✅ {name}: ruta {m} {p} ejercitada por e2e ({hits[0]})")
                if len(cands) > 1:
                    say(f"   ⚠ {name}: {m} {p} es sufijo de {len(cands)} rutas de la cobertura; basta con que una tenga hits")

for d in sys.argv[1:]:
    try:
        gate_repo(d)
    except Exception as e:  # default-deny: cualquier sorpresa es fallo, nunca verde
        bad(f"{os.path.basename(d)}: error inesperado del gate ({type(e).__name__}: {e})")

if checked == 0 and not fail:
    say("· ningún sub-repo con cambios y suite e2e_dev: nada que gatear (verde)")
say("E2E-GATE: FAIL" if fail else "E2E-GATE: PASS")
sys.exit(1 if fail else 0)
PY
