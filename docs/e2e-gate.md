# Gate de cobertura e2e contra DEV (`scripts/e2e-gate.sh`)

Regla del equipo (2026‑10):

> Todo criterio de aceptación verificado contra DEV en la etapa `curl` también se vuelve una prueba
> en `e2e_dev/` del repo afectado, corrida con `--route-coverage-xml`, para que los endpoints
> nuevos o cambiados queden cubiertos por la suite e2e y no sólo por un curl que nadie repite.

Por qué: la evidencia del `curl` vive en un comentario de ClickUp y se pudre; la suite `e2e_dev/`
se vuelve a correr contra DEV y su cobertura de rutas (Cobertura XML de `--route-coverage-xml`)
dice qué endpoints ejercitó de verdad. El gate une las dos cosas: si el ciclo cambió una ruta, la
ruta tiene que aparecer **ejercitada** en una corrida e2e posterior al último commit.

Mismo contrato que `unit-gate.sh`: `e2e-gate.sh [DIR]` (DIR = worktree de la sesión; default
`cwd`), líneas `✅/❌/⚠`, y al final `E2E-GATE: PASS` o `E2E-GATE: FAIL` (exit 0 / 1).
Default‑deny: sin `merge-base`, sin evidencia, evidencia ilegible o vieja → `FAIL`. **Sin red,
sin DEV**: el gate sólo lee git, el junit y el XML (tampoco hace `git fetch`: refresca
`origin/main` tú si hace falta).

## Qué comprueba (por cada sub‑repo con cambios respecto a `E2E_GATE_BASE`)

Sub‑repos: los directorios git inmediatos de DIR (o DIR mismo si es un repo); `*-base`,
`node_modules`, `reports` y ocultos se ignoran. Cambios = rama vs `merge-base` + working tree +
archivos sin rastrear.

0. **Sin `e2e_dev/`** → `· <repo>: sin suite e2e_dev — se omite` (no falla). Hoy tienen suite
   `ant-liebre-api`, `ant-ms-cfdis` y `ant-ms-permissions`.
1. **Rutas cambiadas**: decoradores FastAPI **añadidos o modificados** en `src/**/*.py`
   (`@router.get(`, `@app.post(`, `@api_router.patch(`, `…api_route(…, methods=[…])`), con el
   método y el path literal. Se resuelven decoradores multilínea (path en la línea siguiente;
   basta con que cambie cualquier línea entre el `@` y el path) y el `prefix=` del
   `APIRouter(...)` del mismo archivo. Las rutas borradas no cuentan.
2. **Regla A**: si hay rutas cambiadas (no excusadas), algún `e2e_dev/**/test_*.py` tiene líneas
   añadidas. Si no: `❌ <repo>: cambiaron rutas (<lista>) y ningún e2e_dev/test_*.py fue tocado`.
3. **Regla B (evidencia)**: si aplica A o se tocó algún `e2e_dev/test_*.py`, hacen falta una
   cobertura de rutas y un junit de una corrida. Cada archivo debe existir, ser legible y tener
   mtime **posterior al último commit** del sub‑repo (`git log -1 --format=%ct`, el mismo
   anti‑rancio que `UNIT_GATE_EXTRA_JUNIT`); una cobertura sin ninguna ruta también es `FAIL`.
4. **Regla C**: cada `e2e_dev/test_*.py` tocado tiene ≥1 caso que **pasa** en el junit (mismo
   emparejamiento que `tests_ran_from` de `unit-gate.sh`: `classname` `e2e_dev.test_x…` o
   atributo `file`). Skips no cuentan. Los rojos de **otros** archivos no importan (las suites
   guardan rojos intencionales de defectos conocidos del API); si el archivo tocado tiene además
   casos en rojo, sólo se avisa con `⚠`.
5. **Regla D**: cada ruta cambiada aparece **ejercitada** en la cobertura: mismo MÉTODO y el path
   del decorador (con el prefijo del archivo) es sufijo del path del XML (los routers se montan
   con prefijos como `/api/v1`; los parámetros se comparan literalmente por plantilla,
   `{business_id}` ≠ `{id}`; la barra final se ignora). Como el path del decorador empieza en
   `/`, el sufijo siempre cae en frontera de segmento.
   - no está en el XML → `❌ … ruta <M path> no aparece en la cobertura (¿se corrió con --route-coverage-xml?)`
   - está con 0 hits → `❌ … ruta <M path> no fue ejercitada por e2e`
   - si el sufijo coincide con varias rutas del XML basta una con hits (se avisa con `⚠`).

Formatos de cobertura aceptados (un archivo puede traer cualquiera):

| repo | elemento | ejercitada si |
|---|---|---|
| `ant-liebre-api` | `<method name="GET /api/v1/...">` | `line-rate > 0` o algún `<line hits>0>` dentro |
| `ant-ms-cfdis`, `ant-ms-permissions` | `<line number=N hits=H route="GET /api/v1/..."/>` | `hits > 0` |

## Variables de entorno y defaults

| variable | default | notas |
|---|---|---|
| `E2E_GATE_BASE` | `origin/main` | base del `merge-base` |
| `E2E_GATE_COVERAGE` | `ant-liebre-api`: `reports/route-coverage-e2e.xml` · resto: `.e2e_history/route-coverage.xml` | lista `a.xml:b.xml`, relativas al sub‑repo; las rutas se unen (hit en cualquiera) |
| `E2E_GATE_JUNIT` | `ant-liebre-api`: `reports/junit-e2e-dev.xml` · resto: `.e2e_history/junit.xml` | lista `a.xml:b.xml`; los casos se unen |

Con varios sub‑repos en una sesión, las variables aplican a todos: déjalas vacías y usa los
defaults por repo, o corre el gate por sub‑repo (`e2e-gate.sh <wt>/<repo>`).

## Válvula: `e2e_dev/.e2e-gate-skip`

Una ruta sólo se excusa por escrito, en el propio sub‑repo (queda en el PR y se revisa):

```
# METHOD path  # motivo (obligatorio)
POST /admin/rebuild-cache  # interno/M2M: el token de DEV no tiene el scope
DELETE /businesses/{business_id}/things/{thing_id}  # destructivo en DEV; cubierto por guarda unitaria
GET ""  # path vacío con prefijo montado fuera del archivo (ver limitaciones)
```

El path es el del decorador (con el prefijo del archivo, si lo hay) o el path completo del XML.
Una línea sin `# motivo` no excusa y es `FAIL`. Las rutas excusadas salen como
`⚠ <repo>: ruta M path excusada por e2e_dev/.e2e-gate-skip — <motivo>` y no cuentan para A ni D.
Pensado para rutas que DEV no permite ejercitar (internas/admin/M2M, destructivas, cubiertas sólo
por una guarda), no para ahorrarse la prueba.

## Lo que corre el agente antes del gate

Correr **sólo los archivos e2e tocados** (más los que ejerciten las rutas cambiadas) contra DEV,
dejando junit y cobertura en las rutas default, **después** del último commit:

```bash
# ant-liebre-api (desde el sub-repo del worktree)
LIEBRETEST_E2E_BUSINESS=<bu-…> LIEBRE_DEV_TOKEN_FILE=~/.liebre-dev-token \
  .venv/bin/python -m pytest e2e_dev/<archivos tocados> -o addopts= -q \
  --junitxml=reports/junit-e2e-dev.xml --route-coverage-xml=reports/route-coverage-e2e.xml

# ant-ms-cfdis / ant-ms-permissions (mismas credenciales de DEV que pide su e2e_dev/conftest.py)
.venv/bin/python -m pytest e2e_dev/<archivos tocados> -o addopts= -q \
  --junitxml=.e2e_history/junit.xml --route-coverage-xml=.e2e_history/route-coverage.xml

# el gate
~/code/claude-cowork/scripts/e2e-gate.sh <worktree de la sesión>
```

Si después de la corrida hay otro commit, la evidencia queda vieja: se vuelve a correr.

## Limitaciones (deliberadas: el gate es determinista y no adivina)

- Sólo los **decoradores** añadidos/modificados cuentan como rutas cambiadas. Un cambio en el
  cuerpo del handler o en un servicio que usa la ruta **no** la marca; eso sigue siendo criterio
  del `curl`/revisión.
- El path tiene que ser un literal de string. Un decorador añadido con path no literal (constante,
  f‑string) sale como `⚠ … decorador de ruta sin path literal reconocible` y no se gatea.
- El prefijo sólo se resuelve si está en el `APIRouter(prefix=…)` del **mismo archivo**. Un path
  vacío (`""`/`"/"`) cuyo prefijo se monta en `include_router(…, prefix=…)` de otro archivo no se
  puede ubicar en la cobertura → `FAIL` («path vacío»); hoy hay una sola ruta así en
  `ant-liebre-api`. Si aparece, excúsala con `GET ""  # motivo` o declara el prefijo en el router.
- Un path de decorador corto (p. ej. `/{id}`) puede ser sufijo de varias rutas del XML; basta con
  que una tenga hits (`⚠`).
- No valida que la prueba e2e **afirme** algo útil: eso sigue siendo revisión con mutantes.

Pruebas del propio gate: `node --test scripts/e2e-gate.test.mjs` (`npm run test:scripts`).
