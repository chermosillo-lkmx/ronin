# EVIDENCIA — La pestaña "Harness" no aparecía en Ronin: estaba en la pantalla equivocada

Repo `claude-cowork` (remote `chermosillo-lkmx/ronin`). Base `fc6950f` → PR [#2](https://github.com/chermosillo-lkmx/ronin/pull/2)
mergeado en `main` como `50a5da9` (squash). Ticket: no hay (requerimiento directo). Ciclo: `/tmp/cowork-cycle-cowork-ui-20260908/`.

## Veredicto

**Corregido y verificado en DEV.** La vista Harness ahora vive en `WorkflowWorkspace` — la pantalla que el shell de
escritorio monta — con `allowVerifyCmd=false` porque el catálogo rechaza `verifyCmd`. Tests que renderizan la pantalla
real (7/8 rojos contra `fc6950f`) y pin de que `DesktopApp` monta `WorkflowWorkspace`.

## Causa y cadena

1. `web/src/main.tsx:18` — `window.roninDesktop ? <DesktopApp/> : <App/>`. En Electron (Ronin) se renderiza `DesktopApp`.
2. `web/src/DesktopApp.tsx:10,22` — importa y monta sólo `WorkflowWorkspace` en `view === "workflows"`. Cero referencias a
   `WorkflowEditorScreen` ni `HarnessView`.
3. `288f111` enganchó la pestaña en `web/src/screens/WorkflowEditorScreen.tsx` (VIEWS:43, import:30, render:225), alcanzable
   sólo desde `App.tsx:81` (⚙ Workflow) y `App.tsx:102` ("Overrides por repo") — la variante navegador.
4. El bundle traía "harness" 61 veces porque `HarnessView` está en el árbol de `App`; el empaquetado era correcto.
5. `WorkflowEditorScreen.test.ts:47-79` afirmaba por `readFileSync` que `<HarnessView` estaba en ESA pantalla: probaba el
   componente correcto en la pantalla equivocada. Nada renderizaba `WorkflowWorkspace` en vista harness.

**¿`WorkflowEditorScreen` es código muerto?** No: sigue viva en el dashboard web y es la única que edita el override
por-repo (donde `verifyCmd` sí se arma). Por eso la vista se **portó**, no se movió.

**¿Sigue valiendo el mapeo de controles en el catálogo?** Parcialmente, y eso cambia el montaje:

| Control | Campo | `PUT /api/workflows/:id` | Evidencia |
|---|---|---|---|
| instruction | `stage.instruction` | persiste | `server/src/workflow.ts:276` |
| executor (+model) | `stage.executor/model` | persiste | `workflow.ts:270-280` |
| verifier | `config.verifyAfter` | persiste | `workflow.ts:258,316` |
| verifyCmd | `stage.verifyCmd` | **400 `VERIFY_CMD_NOT_ALLOWED`** | `server/src/workflow-catalog.ts:130` → `workflow.ts:220-224` (`server/data/workflows.json` está en git) |
| maxRetries | `stage.maxRetries` | no (sub-campo de verifyCmd) | `workflow.ts:266-269` |

→ `CATALOG_ALLOW_VERIFY_CMD = false`: `verifyCmd` sale deshabilitado con motivo, la banda Gates cerrada, y el medidor
cuenta 0 sensores con campo detrás (sólo cuenta `verifyCmd` con texto). Los módulos puros (`harness-controls.ts`,
`harness-arm.ts`, `workflow-save.ts`, `workflow-draft.ts`) y `HarnessView.tsx` se reutilizan sin cambios.

## Cambios (PR #2, 2 commits → squash `50a5da9`)

- `web/src/components/workflows/WorkflowWorkspace.tsx`: cuarta pestaña `Harness` en el segmento (Grafo/Stepper/JSON/Harness);
  `HarnessView` sobre el mismo `WorkflowDraftState`; `verifyGate` desde `GET /api/health`; handlers `toggleHarnessControl` /
  `editControlValue` / `toggleHarnessSection` con `setDraft` funcional; aviso de descartes (`pendingDiscards`) en el footer;
  prop `initialView` (costura SSR). El guardado pasa por `confirmWorkflowSave(draft, null, …)` (repo null → guarda directo;
  la confirmación de shell sigue en el camino de guardado, no en la vista) y manda `workflowPayload(draft)`, que **conserva
  `inputs`** — el payload anterior `{stages, verifyAfter}` los perdía en cada guardado (control negativo en DEV, abajo).
- `web/src/components/workflows/WorkflowWorkspace.test.ts`: +7 tests que **renderizan** el workspace con `initialView:"harness"`
  (segmento de 4 pestañas y orden; pestaña activa; `data-control` × 4 etapas con `aria-pressed`; `verifyCmd` `disabled` y
  banda `gates` `disabled`; `data-coverage="0/2"`; `inputs` en el draft; pin de `confirmWorkflowSave`/`workflowPayload`).
- `web/src/DesktopApp.test.ts` (nuevo): pin por fuente de que `DesktopApp` monta `WorkflowWorkspace` y no
  `WorkflowEditorScreen`/`HarnessView` (DesktopApp importa CSS; tsx no lo renderiza — se declara como pin).
- `README.md`: dónde vive Harness en el shell de escritorio y por qué `verifyCmd` sale deshabilitado ahí.

Implementación delegada a codex (`gpt-5.6-sol`, ventana tmux `codex-impl`, rollout
`~/.codex/sessions/2026/09/10/rollout-2026-09-10T17-33-58-…jsonl` con `task_complete`); RGR por paso en
`/tmp/cowork-cycle-cowork-ui-20260908/rgr.log`. Main revisó el diff, quitó un shim `globalThis.React` innecesario,
recolocó la frase del README y commiteó.

## Suites

- Baseline `fc6950f`: `npm test -w web` 193/193.
- Control RED: los 8 tests de `WorkflowWorkspace.test.ts` contra el `WorkflowWorkspace.tsx` de `fc6950f` → **1 pass / 7 fail**.
- Final: `npm test -w web` **201/201**; server **616/616** (sin cambios, regresión); `npm run build -w web` OK y el bundle
  contiene `"graph","stepper","json","harness"` (en `fc6950f` el segmento no lo tenía).
- Ronin: `run-mtw7q2z9-8ea0bf29` (unit/web, 198 testcase) y `run-mtw7q4ys-3528ef09` (api/server, 616). Trampa documentada en
  `evidence/tests.md`: el reporter `junit` de node deja los tests de primer nivel como `<testcase>` sueltos bajo `<testsuites>`
  y el parser de Ronin (`server/src/test-harness/artifacts.ts:61-92`) sólo cuenta los que cuelgan de `<testsuite>` — el primer
  registro contó 7 de 198; se envolvieron con `evidence/wrap-junit.py` sin alterar ningún testcase.

## Pruebas en DEV por criterio (`evidence/curl.md`)

Servidor de Ronin en `50a5da9`, puerto 8790, `COWORK_DATA_DIR` de scratch (sin tocar el catálogo real); escrituras con
`X-Ronin-Capability`. Veredictos calculados por el script a partir del HTTP observado.

| AC | Prueba | Resultado |
|---|---|---|
| AC1 pestaña en la pantalla real | build + grep del bundle; tests T1–T3, T8 | PASA (tupla presente; 0 en fc6950f, 1 en 50a5da9) |
| AC2 instruction/executor/verifier persisten; verifyCmd no | POST 201 → PUT 200 con los tres → PUT con verifyCmd **400 `VERIFY_CMD_NOT_ALLOWED` `stages[0].verifyCmd`** → GET intacto → DELETE 200 | PASA, sin residuo |
| AC3 `inputs` se conservan | PUT con `inputs` 200 y GET los devuelve; **control negativo**: el payload viejo `{stages, verifyAfter}` los deja en `null` | PASA |
| AC4 `verifyGate` en `/api/health` | `{"verifyGate":false}` | PASA |
| AC5 el test nuevo falla en el código viejo | 7/8 rojos contra `fc6950f` | PASA |
| AC6 visual | vite 5180 → Workflows → Catálogo → Harness: segmento `[Grafo, Stepper, JSON, Harness]`, 16 `data-control`, 4× `verifyCmd` disabled, `data-coverage 0/4`, bandas guides:on / gates:off, aviso "El gate no está corriendo" | PASA (`evidence/ac6-0{1,2,3}-*.jpg`) |

## Limpieza

- Hecha: workflow desechable borrado (DELETE 200, id ausente); servidores 8790 y 5180 detenidos (el app Ronin en 8787 no se
  tocó); ventana tmux `codex-impl` cerrada; `reports/` y `web/dist` del worktree borrados; copias temporales de JUnit en
  `~/.cowork/worktrees/…/cowork-ui-20260908/reports/` borradas.
- Pendiente: worktree `/private/tmp/wt-harness-port` (rama `fix/harness-tab-workspace`, ya mergeada y en `origin`) — se puede
  `git worktree remove` y borrar la rama. `main` local se subió a `origin` (iba 4 commits por delante: era prerequisito del PR).

## Pendientes / hallazgos fuera de alcance

1. En la variante WEB (`App.tsx`), `.app` capa el ancho (~1200px) y las acciones del header del workspace se recortan (ya
   pasaba con tres pestañas); en Electron el workspace ocupa el ancho completo. No se tocó.
2. `WorkflowEditorScreen.test.ts` sigue probando por `readFileSync`; no se tocó (fuera del alcance, y ahora la cadena
   pantalla-real → componente → vista la cubren los tests nuevos).
3. H1 conocido desde `288f111`: `templates.ts:44` usa `??` y no atrapa `instruction:""`.
4. Parser JUnit de Ronin vs reporter de node (arriba): merece un arreglo en `artifacts.ts` para recorrer `<testcase>` sueltos.
