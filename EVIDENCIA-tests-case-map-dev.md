# EVIDENCIA — Pruebas: mapa de casos por corrida, detalle por prueba y origen (sesión · ticket · commit)

Repo `claude-cowork`. Base `62d27d4` → PR [#10](https://github.com/chermosillo-lkmx/ronin/pull/10) mergeado en `main` como `5ae2088`.
Ticket: no hay. Ciclo: `/tmp/cowork-cycle-tests-cases-20260914/`. Implementador: codex (`gpt-5.6-sol`, ventana `codex-tests`), orquestado por Main.

## Veredicto
**Implementado, mergeado y verificado en DEV, en el navegador y a través del app reempaquetado.**

## Antes
Un `Run` guardaba `totals` + `failures` (máx. 200) y la UI listaba los fallos como texto (`TestsScreen.tsx:257-300`). Nadie guardaba los casos ni
quién disparó la corrida. Y `summarizeJUnit` (`artifacts.ts:59-90`) sólo recorría `<testsuites>/<testsuite>/<testcase>`: el reporter `junit`
de `node:test` deja los tests de primer nivel sueltos y una suite de 198 se registraba como 7 (`run-mtw7ph1y`, 2026-09-10).

## Cambios (5 commits → squash)
- Parser: testcase sueltos + `cases[]` (id estable, estado, duración, mensaje, stack, stdout; máx. 5000). Modelo `TestCase`, `TestCasesFile`, `TestTrigger`.
- Persistencia `test-artifacts/<runId>/cases.json` (harness y agente, redactado) + `GET /api/tests/runs/:id/cases` (404 `CASES_NOT_FOUND` en corridas viejas).
- Origen (`trigger.ts`): commit/rama por `git` en la carpeta del JUnit o el cwd; sesión gestionada cuyo worktree contiene la carpeta (ticket de `launch.json`
  o patrón `86xxxxxxx`); explícito por MCP (`ticket`, `commit`, `session`) gana; `source` lo dice. `estado_pruebas` y la respuesta del reporte lo muestran.
- UI: fila Origen; mapa de cuadros (fallos/errores primero, verde/rojo/ámbar, filtro «fallidas»); detalle al click. README + skill.

## Suites
web 219/219 · server 642/642 · builds OK. Ronin con el app reempaquetado y el JUnit crudo: unit/web **216** (`run-mu25k9ic`), api/server 642 (`run-mu25kdzv`),
ambos con `origen: sesión cowork-ui-20260908 · commit 5ae2088`.

## DEV (`evidence/curl.md`)
| AC | Resultado |
|---|---|
| AC1 JUnit de node (198 sueltos) | 199 casos / `cases.json` 199 (control histórico: 7) |
| AC2 casos con detalle | `falla#1 failed 200ms · message · stack · stdout`, `error#2 error`, `skip#3 skipped` |
| AC3 origen | derivado `{session, ticket 86e36wnhq, commit a90335d, branch feat/probe, source: derived}`; con `ticket` explícito → gana, `mixed` |
| AC4 UI | Origen + 4 cuadros `failed, error, skipped, passed` + detalle; 199 cuadros en la corrida grande (`evidence/ac4-*.jpg`) |
| AC5 control | `GET …/run-nope/cases` → 404 |

## Limpieza
Servidores 8790/5180 parados; ventana `codex-tests` cerrada; worktree y rama `feat/tests-case-map` (local/remota) eliminados; cycle dir y worktree
simulados de la sonda borrados; scratch borrado. App reempaquetada y relanzada.

## Pendientes
1. `listLaunches` lee `/tmp/cowork-cycle-*/launch.json` directamente (no reusa `stages.ts` para no acoplar): si cambia la ruta de los cycle dirs, hay que tocar `trigger.ts`.
2. Los cuadros no enlazan a la sesión (sólo texto); un click que lleve a Sesiones sería el siguiente paso.
