# Gate de mensajes i18n (`scripts/i18n-gate.sh`)

Regla que hace cumplir en **todos los workflows** de Ronin para el monorepo Liebre (2026‑09‑22):

> Todo error 4xx que ve un usuario de Liebre nace con su código del catálogo de `ant-ms-i18n`,
> nunca con un literal escrito a mano.

Doce lotes entre 2026‑09‑15 y 2026‑09‑22 movieron ~1330 `raise` de `ant-liebre-api` al catálogo
(67 → 949 códigos). El gate existe porque esa deuda **se regenera sola**: 14 de los 84 raises del
lote final venían de `fixed_assets/import_*`, que entró en un PR posterior al lote que le tocaba y
nadie lo notó hasta el barrido. Un literal nuevo no rompe ninguna prueba: simplemente se queda en
inglés para siempre.

El gate es un `verifyCmd` de etapa, igual que [`unit-gate.sh`](unit-gate.md): Ronin lo corre en el
worktree de la sesión cuando el worker toca el sentinela de la etapa y está ocioso; `maxRetries: 2`;
el veredicto queda en `<cycle>/verify-i18n.json` y en el medidor del Harness. La instrucción de la
etapa le pide al worker correr el mismo script y no avanzar sin `I18N-GATE: PASS`.

| workflow | la etapa `i18n` va… | por qué ahí |
|---|---|---|
| `tmux-worker-loop` | tras `diff-review`, antes de `tests` | el literal se arregla con el contexto del cambio abierto |
| `claude-plan-codex-impl` | tras `implementing`, antes de `tests` | igual |
| `hotfix-verificado` | tras `implementing`, antes de `tests` | igual |
| `pr-review-merge-dev` | tras `arreglar`, antes de `merge` | última puerta antes de que entre a dev |

## Qué comprueba (por cada sub‑repo con líneas nuevas bajo `src/`)

1. **Ningún 4xx nuevo con mensaje escrito a mano.** En `ant-liebre-api` lo comprueba el trinquete
   del propio repo, `tests/contracts/test_no_new_error_literals.py`, que recorre TODO
   `src/endpoints/` por AST y lo compara contra su inventario `PENDIENTES` (92 raises en 18
   archivos al 2026‑09‑22, **sólo puede encoger**). En los demás servicios, un barrido de las
   líneas AÑADIDAS del diff.
2. **Todo `error_code=` nuevo del diff EXISTE en el catálogo**: sembrado en las migraciones de
   `ant-ms-i18n`, o sembrado en el mismo ciclo (el diff de `ant-ms-i18n` cuenta). Un código sin
   sembrar nunca se traduce y nada se pone rojo.
3. **Todo `AppError(...)` nuevo trae `default_message`**: es lo que lee el usuario cuando ms‑i18n
   no responde, y sin él lee el código pelón — `str(AppError)` devuelve el `error_code` a secas.

No cuentan como literal: el mensaje que sólo repite otra excepción atrapada (`str(e)`, `{e}`), el
que hace eco de otro servicio junto con su status (`{response.text}`), y todo lo que no sea 4xx.

Default‑deny: sin `git`, sin catálogo de `ant-ms-i18n` o sin intérprete para el trinquete → `FAIL`.

## Cómo se migra un literal

```python
raise AppError(
    error_code="TU_CODIGO",
    http_status=404,                    # el mismo que da hoy
    params={"business_id": business_id},  # TODOS los placeholders de la plantilla
    default_message="Period not found",   # el literal EXACTO de hoy
)
```

y se siembra el código en una migración de `ant-ms-i18n` en el **mismo ciclo**.

**Antes de REUSAR un código existente**, abre su plantilla sembrada y compara sus placeholders
contra tu literal. Cuatro reusos de los lotes 9‑12 habrían borrado información —el rol, la lista de
cuentas, un id— en cuanto ms‑i18n respondiera, porque la plantilla no tenía dónde ponerla. Si no
encajan, siembra un código nuevo.

Si migras algo del inventario, **baja su número** en `PENDIENTES` (o borra la línea si quedó en 0):
el trinquete falla si el inventario queda holgado, para que un archivo ya migrado no conserve
presupuesto para literales nuevos.

## Uso a mano

```bash
~/code/claude-cowork/scripts/i18n-gate.sh <worktree>
# I18N-GATE: PASS  |  I18N-GATE: FAIL
```

Env: `I18N_GATE_BASE` (default `origin/main`) · `I18N_GATE_MAIN_ROOT` (default `~/code/lkmx/liebre`,
de ahí salen el `.venv` y el catálogo si el worktree no los tiene).
