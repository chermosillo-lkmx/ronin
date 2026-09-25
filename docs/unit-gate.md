# Gate de pruebas unitarias (`scripts/unit-gate.sh`)

Regla que hace cumplir en **todos los workflows** de Ronin para el monorepo Liebre (2026‑09‑15):

> Ningún PR se mergea sin pruebas unitarias que lo cubran y sin la suite del servicio en verde.

El gate es un `verifyCmd` de etapa (P2): Ronin lo corre en el **worktree de la sesión** cuando el
worker toca el sentinela de la etapa y está ocioso; `maxRetries: 2`; el veredicto queda en
`<cycle>/verify-<stage>.json` y en el medidor del Harness. Ronin observa, no ejecuta: la
instrucción de la etapa le pide al worker correr el mismo script y no avanzar/mergear sin
`UNIT-GATE: PASS`. Como `verifyCmd` sólo se honra en fuentes gitignored, vive en:

| dónde | etapa con gate | notas |
|---|---|---|
| `workflows.json` (catálogo): `tmux-worker-loop`, `claude-plan-codex-impl`, `hotfix-verificado` | `tests` | además `pr` pide re‑correrlo antes del merge |
| `workflows.json`: `pr-review-merge-dev` | `arreglar` (antes de `merge`) | `merge` pide re‑correrlo sobre el estado final |
| `repo-config.json` → `monorepo.workflow` (default cuando no se elige del catálogo) | `tests` | |
| `workflow.json` (global legacy, git-tracked) | — | sólo el texto de la regla; `verifyCmd` se ignora ahí por diseño (B3) |

Las sesiones ya creadas conservan su `flow.json` congelado: el gate aplica a sesiones nuevas.

## Qué comprueba (por cada sub‑repo con cambios respecto a `origin/main`)

1. **Cambios en código de producto traen tests.** `src/**` (o `app/`, `lib/`), excluyendo
   `migrations/`, requiere al menos un archivo bajo `tests/` (o `*.test.*`/`*.spec.*`) tocado en la
   misma rama o working tree. Aviso (no bloquea) por cada módulo de `src` cuyo nombre no aparece en
   ningún test tocado.
2. **Los tests tocados existen y se ejecutan**: cada archivo de tests cambiado debe tener al menos un
   caso en el `junit` que pase (un archivo que pytest no colecta, o que sólo tiene skips, falla).
   Puede apoyarse en junits de corridas aparte vía `UNIT_GATE_EXTRA_JUNIT` (ver abajo).
3. **La suite completa pasa**: `0 failed / 0 errors` y `> 0` tests. Python:
   `pytest tests -q -o addopts="" --continue-on-collection-errors -p no:cacheprovider --junitxml=reports/junit-gate.xml`
   (`ant-ms-cfdis` añade `-o log_cli=false -m "not functional"`); Node: `npx vitest run --reporter=junit`.
   Intérprete: `<repo>/.venv/bin/python` y, si el worktree no tiene, `~/code/lkmx/liebre/<repo>/.venv/bin/python`.

Default‑deny: sin intérprete, sin `junit`, sin `merge-base` o sin runner reconocible → `FAIL`.
Sub‑repos sin cambios se omiten; `*-base` (checkouts de control) se ignoran.

## Uso a mano

```bash
~/code/claude-cowork/scripts/unit-gate.sh /ruta/al/worktree     # default: cwd
UNIT_GATE_SKIP_SUITE=1 …   # sólo reglas 1‑2 (rápido, para depurar la clasificación de archivos)
UNIT_GATE_BASE=origin/main # base de comparación
UNIT_GATE_EXTRA_JUNIT=a.xml:b.xml … # junits extra para la regla 2 (ver abajo)
```

### Evidencia extra para la regla 2: `UNIT_GATE_EXTRA_JUNIT`

Por qué existe: en `ant-liebre-api` las pruebas de BD real se **saltan** si no hay un Postgres
migrado en `localhost:5432` (`test_db`/`test_user`, ver `tests/conftest.py`), y la suite **no es
hermética**: con esa BD disponible fallan ~267 pruebas unitarias ajenas (sólo está verde SIN BD).
Un PR que tiene que editar un archivo de pruebas de BD real no podía pasar nunca: sin BD falla la
regla 2 (sólo skips); con BD falla la regla 3.

`UNIT_GATE_EXTRA_JUNIT` es una lista de junits separados por `:` (como `PATH`; vale una sola ruta),
relativos al repo gateado. **Sólo afecta a la regla 2**: un archivo de tests tocado cuenta como
ejecutado si tiene ≥1 caso que pasa en el junit de la suite **o** en algún junit extra. La
**regla 3 no cambia**: la suite en verde se calcula sólo con la corrida propia del gate.

```bash
# 1) correr sólo las pruebas de BD real tocadas, con Postgres migrado (test_db/test_user en :5432)
.venv/bin/python -m pytest tests/periods/test_x_db.py -q -o addopts='' --junitxml=reports/junit-realdb.xml
# 2) apagar esa BD y correr el gate con la evidencia extra
UNIT_GATE_EXTRA_JUNIT=reports/junit-realdb.xml ~/code/claude-cowork/scripts/unit-gate.sh <wt>
```

Fail‑closed:
- junit extra inexistente o ilegible → `FAIL` (nunca se ignora en silencio);
- junit extra más viejo (mtime) que el último commit del repo (`git log -1 --format=%ct`) → `FAIL`
  con «junit extra anterior al último commit: vuelve a correr esas pruebas»;
- un archivo tocado con algún caso en `failure`/`error` en un junit extra **no cuenta** (❌ aparte).

Cuando la evidencia extra cubre archivos, el gate lo dice:
`✅ <repo>: tests tocados ejecutados vía UNIT_GATE_EXTRA_JUNIT: <archivos>`.

Pruebas del propio gate: `node --test scripts/unit-gate.test.mjs` (`npm run test:scripts`).

Salida: una línea `✅/❌` por regla y repo, cola de `reports/unit-gate.log` cuando la suite falla,
y al final `UNIT-GATE: PASS` o `UNIT-GATE: FAIL` (exit 0 / 1). El log completo de la suite queda
en `<repo>/reports/unit-gate.log` y el junit en `<repo>/reports/junit-gate.xml`.

## Qué NO es

- No sustituye a `mcp__ronin__reportar_pruebas` (el gate no registra corridas en el harness).
- No mide cobertura ni impone umbrales; los umbrales por repo viven en `liebre/CLAUDE.md`.
- No detecta pruebas vacuas (mocks que afirman llamadas, `assert x is not None`): eso sigue siendo
  revisión humana/de Main con mutantes.
