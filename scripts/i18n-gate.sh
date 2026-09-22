#!/bin/bash
# i18n-gate.sh — gate de mensajes de error para los workflows de Ronin (verifyCmd de la etapa i18n).
#
# Los 12 lotes de 2026-09 movieron ~1330 `raise` de 4xx de ant-liebre-api al catálogo de
# ant-ms-i18n (67 → 949 códigos). La deuda se regenera sola: 14 de los 84 raises del lote
# final venían de un PR que entró DESPUÉS del lote que le tocaba, y nadie lo notó hasta el
# barrido. Este gate cierra esa puerta en cada ciclo, no cada seis meses.
#
# Reglas que hace cumplir, por cada sub-repo con cambios respecto a origin/main:
#   1. Ningún 4xx NUEVO con mensaje escrito a mano. En ant-liebre-api lo comprueba el
#      trinquete `tests/contracts/test_no_new_error_literals.py`; en los demás servicios,
#      un barrido AST de las líneas AÑADIDAS del diff.
#   2. Todo `error_code=` nuevo del diff EXISTE en el catálogo: sembrado en las migraciones
#      de ant-ms-i18n, o sembrado en el mismo ciclo (el diff de ant-ms-i18n cuenta).
#      Un código sin sembrar nunca se traduce: el usuario se queda con el `default_message`
#      en inglés para siempre, y nada se pone rojo.
#   3. Todo `AppError(...)` nuevo trae `default_message`: es lo que se ve cuando ms-i18n
#      no responde, y sin él el usuario lee el código pelón (`str(AppError)` es el código).
#
# Sale con 0 sólo si las tres se cumplen. Cualquier duda (sin git, sin catálogo, sin
# intérprete para el trinquete) es fallo: un gate nunca da verde por defecto.
#
# Uso: i18n-gate.sh [DIR]   (DIR = worktree de la sesión; default: cwd, que es lo que pasa Ronin)
# Env: I18N_GATE_BASE (default origin/main) · I18N_GATE_MAIN_ROOT (default ~/code/lkmx/liebre:
#      de ahí salen el .venv y el catálogo de ant-ms-i18n si el worktree no los tiene)
set -u
ROOT="${1:-$PWD}"
BASE_REF="${I18N_GATE_BASE:-origin/main}"
MAIN_ROOT="${I18N_GATE_MAIN_ROOT:-$HOME/code/lkmx/liebre}"
fail=0; checked=0
say() { printf '%s\n' "$*"; }
bad() { say "❌ $*"; fail=1; }
ok()  { say "✅ $*"; }

# El catálogo vive en las migraciones de siembra de ant-ms-i18n. Se busca primero en el
# worktree (un ciclo puede estar sembrando códigos nuevos) y luego en el checkout principal.
catalog_dirs=()
for d in "$ROOT/ant-ms-i18n" "$MAIN_ROOT/ant-ms-i18n"; do
  [ -d "$d/src/database/migrations/versions" ] && catalog_dirs+=("$d/src/database/migrations/versions")
done
if [ ${#catalog_dirs[@]} -eq 0 ]; then
  bad "no encuentro las migraciones de ant-ms-i18n (ni en $ROOT ni en $MAIN_ROOT): sin catálogo no puedo verificar ningún código"
  say "I18N-GATE: FAIL"; exit 1
fi

candidates=()
if [ -d "$ROOT/.git" ] || [ -f "$ROOT/.git" ]; then
  [ -d "$ROOT/src" ] && candidates+=("$ROOT")
fi
for d in "$ROOT"/*/; do
  d="${d%/}"; name="$(basename "$d")"
  case "$name" in *-base|node_modules|reports|.*) continue;; esac
  { [ -d "$d/.git" ] || [ -f "$d/.git" ]; } || continue
  [ -d "$d/src" ] || continue
  candidates+=("$d")
done
[ ${#candidates[@]} -eq 0 ] && { bad "no encontré ningún repo de servicio bajo $ROOT"; say "I18N-GATE: FAIL"; exit 1; }

py_for() { # $1 = repo dir
  local r="$1" n; n="$(basename "$r")"
  for p in "$r/.venv/bin/python" "$MAIN_ROOT/$n/.venv/bin/python"; do [ -x "$p" ] && { echo "$p"; return; }; done
  return 1
}

# Las líneas AÑADIDAS del diff (rama + working tree + sin rastrear), sólo bajo src/.
added_lines() { # $1 = base sha
  { git diff -U0 "$1" HEAD -- src; git diff -U0 HEAD -- src; } 2>/dev/null | grep '^+' | grep -v '^+++'
  for f in $(git ls-files --others --exclude-standard -- src 2>/dev/null); do sed 's/^/+/' "$f"; done
}

for repo in "${candidates[@]}"; do
  name="$(basename "$repo")"
  cd "$repo" || { bad "$name: no puedo entrar"; continue; }
  git fetch -q origin main 2>/dev/null || true
  base="$(git merge-base HEAD "$BASE_REF" 2>/dev/null)" || { bad "$name: sin merge-base con $BASE_REF"; continue; }
  added="$(added_lines "$base")"
  [ -z "$added" ] && { say "· $name: sin líneas nuevas bajo src/ — se omite"; continue; }
  checked=$((checked+1))
  say "── $name  (base $(git rev-parse --short "$base"))"

  # Regla 1 en ant-liebre-api: el trinquete del propio repo, que lee TODO src/endpoints/
  # por AST y compara contra su inventario.
  if [ -f tests/contracts/test_no_new_error_literals.py ]; then
    if PY="$(py_for "$repo")"; then
      mkdir -p reports
      if "$PY" -m pytest tests/contracts/test_no_new_error_literals.py -q -o addopts="" \
           --color=no -p no:cacheprovider > reports/i18n-gate.log 2>&1; then
        ok "$name: trinquete de literales 4xx en verde"
      else
        bad "$name: trinquete de literales 4xx en ROJO:"
        grep -E "^E |FAILED" reports/i18n-gate.log | head -25 | sed 's/^/     /'
      fi
    else
      bad "$name: sin intérprete (.venv) para correr el trinquete de literales"
    fi
  else
    # Regla 1 en los demás servicios: barrido de las líneas añadidas. Sin el inventario del
    # trinquete sólo se puede mirar lo nuevo, que es justo lo que este gate tiene que atajar.
    nuevos="$(printf '%s\n' "$added" | grep -nE 'raise +(HTTPException|NotFoundException|ConflictException|BadRequestException|ForbiddenException|UnauthorizedException|UnprocessableEntityException|create_(bad_request|not_found|conflict|forbidden|unauthorized|field_validation|unprocessable_content)_error)\(' | grep -E '"[^"]*[A-Za-z][^"]*"|'"'"'[^'"'"']*[A-Za-z][^'"'"']*'"'"'' | grep -vE 'str\(|\.text|\{e\}|\{exc\}|status_code=5|HTTP_5' || true)"
    if [ -n "$nuevos" ]; then
      bad "$name: 4xx nuevos con mensaje escrito a mano (levántalos con AppError + código del catálogo):"
      printf '%s\n' "$nuevos" | head -20 | sed 's/^/     /'
    else
      ok "$name: ningún 4xx nuevo con mensaje propio"
    fi
  fi

  # Regla 2: los códigos nuevos del diff existen en el catálogo.
  codes="$(printf '%s\n' "$added" | grep -oE 'error_code *= *["'"'"'][A-Z0-9_]+["'"'"']' | grep -oE '[A-Z0-9_]{3,}' | sort -u || true)"
  if [ -n "$codes" ]; then
    faltan=""
    while IFS= read -r code; do
      [ -z "$code" ] && continue
      found=0
      for dir in "${catalog_dirs[@]}"; do
        grep -rqF "'$code'" "$dir" 2>/dev/null && { found=1; break; }
        grep -rqF "\"$code\"" "$dir" 2>/dev/null && { found=1; break; }
      done
      [ "$found" -eq 0 ] && faltan="$faltan$code"$'\n'
    done <<< "$codes"
    if [ -n "$faltan" ]; then
      bad "$name: estos error_code NO están sembrados en ant-ms-i18n (el usuario nunca vería el mensaje traducido):"
      printf '%s' "$faltan" | sed 's/^/     /'
      say "     Siembra cada uno en una migración de ant-ms-i18n en el MISMO ciclo."
    else
      ok "$name: los $(printf '%s\n' "$codes" | wc -l | tr -d ' ') error_code del diff están sembrados"
    fi
  fi

  # Regla 3: cada AppError nuevo trae su default_message. Se cuentan bloques, no líneas:
  # `AppError(` y `default_message=` casi nunca caen en el mismo renglón.
  n_app="$(printf '%s\n' "$added" | grep -c 'AppError(' || true)"
  n_def="$(printf '%s\n' "$added" | grep -c 'default_message *=' || true)"
  if [ "$n_app" -gt 0 ]; then
    if [ "$n_def" -lt "$n_app" ]; then
      bad "$name: $n_app AppError nuevos pero sólo $n_def default_message: sin él el usuario lee el código pelón cuando ms-i18n no responde"
    else
      ok "$name: los $n_app AppError nuevos traen default_message"
    fi
  fi
done

[ "$checked" -eq 0 ] && say "· ningún sub-repo con cambios en src/: nada que gatear (verde)"
if [ "$fail" -ne 0 ]; then say "I18N-GATE: FAIL"; exit 1; fi
say "I18N-GATE: PASS"; exit 0
