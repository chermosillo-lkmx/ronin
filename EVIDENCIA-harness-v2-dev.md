# EVIDENCIA — Harness v2: gate por comando y revisión por modelo en cada etapa del catálogo; vista de lista

Repo `claude-cowork` (remote `chermosillo-lkmx/ronin`). Base `178d5d8` → PR [#4](https://github.com/chermosillo-lkmx/ronin/pull/4)
mergeado en `main` como `c567215` (squash de 8 commits). Diseño aprobado (dirección A):
https://claude.ai/code/artifact/5c07cc2d-201d-439b-bf8b-b67ebf46eed6. Ticket: no hay. Ciclo: `/tmp/cowork-cycle-harness-v2-20260910/`.

## Veredicto

**Implementado, mergeado y verificado en DEV.** Codex (`gpt-5.6-sol`, ventana tmux `codex-v2`) implementó por RGR los 7 pasos del
plan; Main revisó y commiteó cada paso, corrigió tres cosas del diff (abajo) y verificó en DEV con servidor de la rama y navegador.

## Causa y cadena (lo que impedía cada cosa)

1. **El verifier "se movía"**: `verifyAfter: string | null` (`server/src/workflow.ts:51`), un solo valor; el cliente lo reflejaba en
   `workflow-draft.ts` (`toggleHarnessControl`: `verifyAfter = on ? stageKey : null`). No era un bug de la vista: era el dato.
2. **No había gate por etapa en el catálogo**: `workflow-catalog.ts:111,130` validaban `strict` sin `allowVerifyCmd` →
   `workflow.ts:220-224` 400 `VERIFY_CMD_NOT_ALLOWED`.
3. **Y aunque se hubiera aceptado, no habría corrido**: `verify-driver-deps.ts:39` resolvía `flowFor(repo)` del override por-repo /
   global; una sesión gestionada congela el config del catálogo en `<cycle>/flow.json` (`session-launch.ts:186`) que el driver ignoraba.
   Control negativo reproducido: en `410c4fa` el mismo fixture no ejecuta ningún gate; en `e887bef` ejecuta y deja `verify-tests.json: passed`.
4. **Hallazgo**: el verificador independiente no se lanza desde el servidor desde `ba15520` (`spawnVerifier` retirado). Hoy `verifyAfter`
   es la frase `{verifier}` del prompt (`templates.ts`), el nodo del grafo y el selector del Stepper. Verifier por etapa = enumerar.

## Cambios (PR #4)

Servidor: `verifyAfter: string[]` con carga tolerante del legado y errores estrictos `VERIFY_AFTER_UNKNOWN`/`VERIFY_AFTER_TYPE` en
`verifyAfter[i]`; catálogo con `allowVerifyCmd` (global legacy y `actions.json` siguen rechazando); driver lee `flow.json`; prompt
enumera etapas; retiro de helpers huérfanos (`stepperFor`, `liveMapFor`, `spliceFlow`, `toGraph`, `getStepperStages`, `liveStageByKey`,
`VERIFY_STAGE`; `stageOrder()` pasa a `getStages()` — codex cazó ese llamador que mi grep no vio).
Web: modelo puro con verifier por inclusión y bandas por control (`instruction|executor|gates|verifiers`); `HarnessList` (lista por
etapa + fila abierta + rail editable) en `WorkflowWorkspace` y `WorkflowEditorScreen`; `HarnessView` retirado; Stepper con checkboxes;
grafo con un nodo verify por etapa; `confirmWorkflowSave` confirma shell también en el catálogo.

Correcciones de Main sobre el diff de codex: (a) el chip de ejecutor y el resumen de instrucción **abren la fila** en vez de apagar el
control con un click (codex los había hecho toggles para cumplir los selectores del plan); (b) clase `sr-only` inexistente → `aria-label`;
(c) `.wf-harness-v2` con `overflow-x:auto` + `minmax(780px)` para que el shell web (~450px) desborde en vez de recortar; (d) se revirtió la
edición que codex hizo del documento histórico `EVIDENCIA-harness-tab-workspace-dev.md` para satisfacer un grep.

## Suites

web 201 → **202/202** (`HarnessView.test.ts` con 19 tests se retira; +20 nuevos) · server 619 → **618/618** (A1 retira tests de helpers
muertos; A2–A4 añaden) · builds web/server OK · `git grep HarnessView` vacío en código. Ronin: `run-mtwc5zy1-3c202ff2` (unit/web),
`run-mtwc63qe-7377d0ea` (api/server). RGR por paso en `rgr.log` (RED reales: A2 7, A3 2, A4 3, B1 7, B2 1, B3 5+1).

## DEV por criterio (`evidence/curl.md`, `evidence/ac3-ac4.md`)

| AC | Prueba | Resultado |
|---|---|---|
| AC1 gate por etapa en el catálogo | `PUT /api/workflows/:id` con `verifyCmd` en `tests` (maxRetries 3) y `curl` (→2) → 200, `GET` conserva; legacy `PUT /api/workflow` → 400 `VERIFY_CMD_NOT_ALLOWED` | PASA |
| AC2 verifier por etapa | `["done","curl"]` → `["curl","done"]`; `"curl"` legado → `["curl"]`; `["nope"]` → 400 `VERIFY_AFTER_UNKNOWN verifyAfter[0]`; el `workflows.json` sembrado (strings) se lee como arrays | PASA |
| AC3 el gate corre para una sesión del catálogo | `tickOnce` con deps reales + `flow.json` con gate → `verify-tests.json: passed`; control negativo en `410c4fa`: nada | PASA |
| AC4 prompt | `[]` sin frase; `["curl"]` singular; `["curl","done"]` "Al terminar cada una de las etapas…" | PASA |
| AC5 UI | vite→8790: 6 filas, 4 bandas, chips de modelo; verifier `done` con `curl` encendido → ambos; gate en `tests` arma→on con `npm test -w web` y 3 reintentos, medidor 1/6; rail apaga/restaura todo y el footer avisa descartes | PASA (`evidence/ac5-*.jpg`) |
| AC6 regresión | suites y builds verdes | PASA |

## Limpieza

Hecha: workflow desechable borrado; servidores 8790/5180 parados; ventana `codex-v2` cerrada; `vite.8790.config.ts` temporal borrado;
data dir de scratch sólo en el scratchpad de la sesión. Pendiente: `git worktree remove /private/tmp/wt-harness-port` y borrar las ramas
mergeadas (`fix/harness-tab-workspace`, `feat/verify-gate-default-on`, `feat/harness-v2`).

## Pendientes / siguientes pasos

1. "Probar ahora" (endpoint que corre un gate a demanda) y "último resultado" del gate en la fila — fuera de alcance, viven en el inspector.
2. Pulido: los botones del `ExecutorPicker` quedan apretados en la fila abierta; la variante web sigue con `.app` a 1200px.
3. `workflows.json` real del app (`~/Library/Application Support/claude-cowork/data/`) sigue con `verifyAfter` string hasta el primer guardado.
4. Riesgo aceptado y documentado: `server/data/workflows.json` es git-tracked y ahora puede llevar shell ejecutable.
