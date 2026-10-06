# gate-source-dirs.sh — ¿dónde está el código de producto de un repo? Lo comparten unit-gate.sh e
# i18n-gate.sh (se carga con `source`; no se ejecuta solo).
#
# Los gates suponían `src/`. messaging-gateway guarda su código en `hub/` (pyproject
# `[tool.setuptools.packages.find] include = ["hub*"]`) y un cambio ahí pasaba la regla 1 como
# «sin cambios en src» con la cobertura medida sobre nada. Orden de detección:
#   1. `source` de coverage declarado: `.coveragerc [run]`, `pyproject [tool.coverage.run]`,
#      `setup.cfg [coverage:run]` → esos directorios (si declara y ninguno existe: fallo).
#   2. existe `src/` → `src` (el comportamiento de siempre).
#   3. `pyproject [tool.setuptools.packages.find] include` (sin el `*` final) → los que existan.
#   4. nada → fallo cerrado: un gate nunca adivina.
#
# source_dirs DIR → imprime un directorio por línea (relativos a DIR) y sale 0; si no puede
# decidir, imprime el motivo en stderr y sale 1.
source_dirs() {
  python3 - "$1" <<'PY'
import configparser
import re
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve()

try:
    import tomllib
except ImportError:  # Python < 3.11: sin TOML se cae a lo demás
    tomllib = None


def ini_value(path, section, key):
    try:
        text = (repo / path).read_text(errors="replace")
    except OSError:
        return None
    match = re.search(rf"(?m)^\s*\[{re.escape(section)}\]\s*$", text)
    if not match:
        return None
    tail = text[match.end():]
    nxt = re.search(r"(?m)^\s*\[[^]]+\]\s*$", tail)
    body = tail[:nxt.start()] if nxt else tail
    parser = configparser.ConfigParser(interpolation=None, strict=False, inline_comment_prefixes=("#", ";"))
    try:
        parser.read_string(f"[s]\n{body}")
        return parser.get("s", key) if parser.has_option("s", key) else None
    except configparser.Error:
        return None


def pyproject():
    if tomllib is None:
        return {}
    try:
        return tomllib.loads((repo / "pyproject.toml").read_text(errors="replace"))
    except (OSError, ValueError):
        return {}


def dig(data, *keys):
    for key in keys:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data


def entries(value):
    if value is None:
        return []
    if isinstance(value, str):
        value = re.split(r"[,\s]+", value)
    return [str(v).strip() for v in value if str(v).strip()]


def as_dir(entry, base="."):
    entry = entry.strip().rstrip("/")
    while entry.startswith("./"):
        entry = entry[2:]
    if not entry or entry == "." or entry.startswith("/") or ".." in Path(entry).parts:
        return None
    for candidate in (entry, entry.replace(".", "/")):
        rel = (Path(base) / candidate).as_posix()
        rel = rel[2:] if rel.startswith("./") else rel
        if (repo / rel).is_dir():
            return rel
    return None


def unique(items):
    seen = []
    for item in items:
        if item and item not in seen:
            seen.append(item)
    return seen


data = pyproject()
for origin, declared in (
    (".coveragerc [run] source", ini_value(".coveragerc", "run", "source")),
    ("pyproject.toml [tool.coverage.run] source", dig(data, "tool", "coverage", "run", "source")),
    ("setup.cfg [coverage:run] source", ini_value("setup.cfg", "coverage:run", "source")),
):
    names = entries(declared)
    if not names:
        continue
    dirs = unique(as_dir(n) for n in names)
    if not dirs:
        print(f"{origin} = {', '.join(names)}, pero ninguno es un directorio del repo", file=sys.stderr)
        sys.exit(1)
    print("\n".join(dirs))
    sys.exit(0)

if (repo / "src").is_dir():
    print("src")
    sys.exit(0)

find = dig(data, "tool", "setuptools", "packages", "find") or {}
patterns = entries(find.get("include")) if isinstance(find, dict) else []
wheres = entries(find.get("where")) if isinstance(find, dict) else []
dirs = []
for where in wheres or ["."]:
    for pattern in patterns:
        top = pattern.rstrip("*").rstrip(".").split(".")[0]
        if top and not any(ch in top for ch in "*?[]"):
            dirs.append(as_dir(top, where))
dirs = unique(dirs)
if dirs:
    print("\n".join(dirs))
    sys.exit(0)

print("ni coverage `source`, ni src/, ni [tool.setuptools.packages.find] include con directorios existentes",
      file=sys.stderr)
sys.exit(1)
PY
}
