#!/bin/bash
# ticket-evidence-gate.sh — gate de la etapa `done`: la evidencia resumida tiene que estar
# COMENTADA en el ticket de ClickUp, no sólo escrita en EVIDENCIA-*.md o en {ev}/summary.md.
#
# Por qué existe: los flujos pedían "deja {ev}/summary.md listo para el ticket" y nada lo
# comprobaba; varios ciclos cerraron sin un solo comentario en el ticket, y quien revisa
# el ticket no ve nada. Este gate pregunta a ClickUp, no al agente.
#
# Regla: por cada ticket del ciclo, debe existir un comentario creado DESPUÉS de que arrancó
# el ciclo (launch.json.createdAt) cuyo texto contenga "Evidencia" y tenga al menos
# MIN_CHARS caracteres (un "listo" no es evidencia).
#
# Tickets del ciclo: launch.json inputs.ticket / inputs.tickets (id de cualquier forma, con o sin
# CU-, o la URL de la tarea). Si no hay inputs, todo id de ClickUp de launch.json.request o del
# nombre: URLs app.clickup.com/t/[<workspace>/]<id> e ids 86xxxxxxx sueltos (con o sin CU-).
# Con inputs, el request no suma tickets: suele mencionar tickets relacionados.
# Ciclo sin ticket → PASS explícito (no hay a quién comentar).
# Cualquier otra duda (sin token, sin launch.json, API caída) es FAIL: un gate nunca da
# verde por defecto.
#
# Uso: ticket-evidence-gate.sh [WORKTREE|CYCLE_DIR]  (default: cwd, que es lo que pasa Ronin)
# Env: COWORK_CLICKUP_TOKEN (si no, se lee de ~/code/claude-cowork/server/.env)
#      TICKET_EVIDENCE_MIN_CHARS (default 300)
set -u
ARG="${1:-$PWD}"
MIN_CHARS="${TICKET_EVIDENCE_MIN_CHARS:-300}"
ENV_FILE="${COWORK_ENV_FILE:-$HOME/code/claude-cowork/server/.env}"

TOKEN="${COWORK_CLICKUP_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$ENV_FILE" ]; then
  TOKEN="$(grep -E '^COWORK_CLICKUP_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
fi

ARG="$ARG" TOKEN="$TOKEN" MIN_CHARS="$MIN_CHARS" python3 - <<'PY'
import glob, json, os, re, subprocess, sys

arg = os.path.abspath(os.environ["ARG"].rstrip("/"))
token = os.environ["TOKEN"]
min_chars = int(os.environ["MIN_CHARS"])

def fail(msg):
    print(f"❌ {msg}")
    print("TICKET-EVIDENCE-GATE: FAIL")
    sys.exit(1)

# 1) Cycle dir: el propio argumento, /tmp/cowork-cycle-<basename>, o el ciclo cuyo
#    launch.json declara este worktree.
cycle = None
if os.path.isfile(os.path.join(arg, "launch.json")):
    cycle = arg
else:
    guess = f"/tmp/cowork-cycle-{os.path.basename(arg)}"
    if os.path.isfile(os.path.join(guess, "launch.json")):
        cycle = guess
    else:
        for launch in glob.glob("/tmp/cowork-cycle-*/launch.json"):
            try:
                if os.path.abspath(json.load(open(launch)).get("worktree", "")) == arg:
                    cycle = os.path.dirname(launch)
                    break
            except Exception:
                continue
if not cycle:
    fail(f"no encuentro el cycle dir (launch.json) para {arg}")

launch = json.load(open(os.path.join(cycle, "launch.json")))
created_ms = int(launch.get("createdAt") or 0)
if not created_ms:
    fail(f"{cycle}/launch.json sin createdAt: no puedo saber qué comentarios son de este ciclo")

inputs = launch.get("inputs") or {}
raw = []
for key in ("ticket", "tickets"):
    value = inputs.get(key)
    if isinstance(value, list):
        raw.extend(str(v).strip() for v in value if str(v).strip())
    elif value and str(value).strip():
        raw.append(str(value).strip())

# Ids de ClickUp: la URL de la tarea (con o sin workspace) o el id 86xxxxxxx suelto. Los ids no
# siempre empiezan con 86 (p. ej. 1dfkggwe07k), así que un id sin URL sólo se reconoce suelto en
# inputs, donde el usuario lo declaró; en el texto libre un token arbitrario sería un falso positivo.
URL_ID = re.compile(r"app\.clickup\.com/t/(?:\d+/)?([0-9a-z]+)", re.I)
LEGACY_ID = re.compile(r"(?<![0-9a-z])(?:CU-)?(86[0-9a-z]{7})(?![0-9a-z])", re.I)
BARE_ID = re.compile(r"^(?:CU-)?([0-9a-z]{6,15})$", re.I)

def ids_in_text(text):
    return [m.group(1) for m in sorted([*URL_ID.finditer(text), *LEGACY_ID.finditer(text)], key=lambda m: m.start())]

if raw:
    # Los inputs mandan: el request puede mencionar tickets relacionados (el original, el del
    # front) a los que este ciclo no les debe un comentario de evidencia.
    found = []
    for value in raw:
        match = URL_ID.search(value) or BARE_ID.match(value)
        if not match:
            fail(f"inputs.ticket «{value}» no parece un id de ClickUp (ni URL app.clickup.com/t/…): corrígelo en launch.json")
        found.append(match.group(1))
else:
    found = ids_in_text(" ".join([launch.get("request") or "", launch.get("name") or ""]))
tickets = list(dict.fromkeys(t.lower() for t in found))

if not tickets:
    print(f"ℹ️  el ciclo {os.path.basename(cycle)} no declara ningún ticket de ClickUp: nada que comentar")
    print("TICKET-EVIDENCE-GATE: PASS")
    sys.exit(0)
if not token:
    fail("sin COWORK_CLICKUP_TOKEN (ni en el entorno ni en server/.env): no puedo verificar el ticket")

def comments(task_id):
    out = subprocess.run(
        ["curl", "-sS", "--max-time", "30", "-H", f"Authorization: {token}",
         f"https://api.clickup.com/api/v2/task/{task_id}/comment"],
        capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or f"curl rc={out.returncode}")
    data = json.loads(out.stdout)
    if "comments" not in data:
        raise RuntimeError(str(data)[:200])
    return data["comments"]

bad = 0
for task_id in tickets:
    try:
        items = comments(task_id)
    except Exception as exc:
        print(f"❌ {task_id}: no pude leer los comentarios en ClickUp ({exc})")
        bad = 1
        continue
    fresh = [c for c in items if int(c.get("date") or 0) >= created_ms]
    good = [c for c in fresh
            if "evidencia" in (c.get("comment_text") or "").lower()
            and len((c.get("comment_text") or "").strip()) >= min_chars]
    if good:
        print(f"✅ {task_id}: comentario de evidencia presente ({len((good[0].get('comment_text') or '').strip())} caracteres, "
              f"de {good[0].get('user', {}).get('username', '?')})")
    else:
        print(f"❌ {task_id}: sin comentario de evidencia desde que arrancó el ciclo "
              f"({len(fresh)} comentario(s) nuevos; se exige texto con «Evidencia» y ≥{min_chars} caracteres). "
              f"Comenta en el ticket el resumen de EVIDENCIA-*-dev.md: veredicto, causa, cambios/PR, suites y pruebas en DEV por criterio.")
        bad = 1

print("TICKET-EVIDENCE-GATE: " + ("FAIL" if bad else "PASS"))
sys.exit(bad)
PY
