# EVIDENCIA — Semáforo de atención + prompt de lanzamiento truncado

Rama `ronin/cowork-ronin` · base `abf1e80` · HEAD `23a1f85`
Workflow `claude-plan-codex-impl` · sesión `cowork-ronin`

## Veredicto

**Las dos peticiones quedan resueltas y verificadas en DEV.**

- **T1 — semáforo.** No había semáforo que revisar: el inventario de sesiones no transportaba
  ningún estado de actividad. Ahora cada sesión trae `attention { level, paneId, question, since }`
  y la UI distingue *esperando una decisión* de *trabajando* y de *libre*. Cazó un true positive
  real durante la propia verificación.
- **T2 — prompt.** El prompt de lanzamiento se entregaba por `send-keys -l` y se cortaba: llegaban
  1 012 de 2 928 caracteres. Ahora se entrega por bracketed paste y llega íntegro.

## Causa / cadena

### T1 — la señal existía pero nadie la transportaba

- `server/src/types.ts:166-177` — `TmuxSessionInfo` no tenía ningún campo de actividad.
- `server/src/sessions.ts:186-207` — `readTmuxInventory()` sólo ejecutaba `list-sessions` y
  `list-panes -a`; nunca miraba el CONTENIDO de un pane, que es donde está la señal.
- `web/src/components/sessions/SessionContext.tsx:6` — la fila sólo pintaba managed/foreign y
  adjunta; `web/src/ronin-shell.css:10` no tenía clase por actividad.
- `server/src/tmux.ts:761` `paneStatus()`, `:774` `lastMeaningfulLine()`, `:797`
  `parseContextPressure()` y `server/src/types.ts:96` `PaneView` estaban **muertos**: ningún
  import en todo el repo, y el "endpoint propio" que documenta `PaneView` nunca se registró.

Dos defectos de fondo impedían que conectarlos bastara:

- `server/src/tmux.ts:742` — `BUSY_FOOTER` exigía `esc to interrupt`. Capturas reales de panes que
  SÍ trabajaban: `· Schlepping… (16m 55s · ↓ 19.9k tokens)` y
  `✢ Beboppin'… (22s · ↓ 631 tokens · thinking with high effort)`. Ninguna la contiene ⇒ se leían
  como **idle** llevando 17 minutos trabajando.
- `paneStatus` colapsaba en `idle` dos situaciones OPUESTAS para el operador: *terminó* y *está
  detenido en un diálogo*. Ese es literalmente el hueco del ticket.

### T2 — el prompt se entregaba como pulsaciones sueltas

`server/src/session-launch.ts:150` → `deliverPrompt` = `sendWhenReady` (`:85`) →
`server/src/engine.ts:11-14` → `sendText()` = `send-keys -l` (`server/src/tmux.ts:145`).

El repo ya documentaba que eso es incorrecto para textos largos (`server/src/tmux.ts:151-157`:
*«el Enter llega mientras la caja todavía está componiendo y se lo TRAGA… Verificado en vivo 2/2
con el prompt del driver (~7KB)»*) y ya tenía la solución escrita: `pastePrompt()`
(`server/src/tmux.ts:160`) + `promptPending()` (`:187`). La ruta HTTP por pane las usaba
(`server/src/index.ts:627`, umbral 200 B); **la de lanzamiento no** — justo la que manda el prompt
más largo del sistema. Además `sendWhenReady` no esperaba nada, pese al nombre.

Medición sobre esta misma sesión (reconstruyendo el prompt con la plantilla `workflow` y el flow
congelado `flow.json`): debieron entregarse **2 928 caracteres / 2 960 bytes**; llegaron **1 012 /
1 025**. Se perdieron las etapas 3 (tests), 4 (curl DEV), 5 (evidencia) y la línea del verificador
— es decir, el worker no recibió ni sus criterios de aceptación ni la orden de dejar evidencia.

Descartado que fuera el búfer del tty: `send-keys -l` con 3 713 B contra un pane con `cat`, y
contra otro que tarda 4 s en empezar a leer, entregó 3 712/3 713 B en ambos casos.

## Cambios

10 commits sobre `abf1e80`:

```
e267fbc feat(server): añade semáforo de atención en sesiones
2ff45bc fix(server): entrega prompts largos por bracketed paste
4450236 test(server): cubre confirmaciones genéricas de atención
3ca11d5 feat(web): muestra decisiones pendientes en sesiones
39f31e2 fix(server): corrige batch de captura de panes tmux
ee74e9d fix(server): limpia marcos TUI en decisiones
1a386bd fix(server): une capturas tmux y conserva decisiones
eedea9b fix(server): conserva decisiones y compatibilidad ES2022
bc65213 fix(web): acota el ámbar al badge de decisión
23a1f85 fix(web): corrige contador y badge de decisión
```

**Nuevos**: `server/src/attention.ts`, `attention-tracker.ts` y sus tests;
`server/src/deliver-prompt.test.ts`; `web/src/components/sessions/SessionContext.test.ts`.

**Modificados**: `server/src/tmux.ts` (BUSY_FOOTER actualizado, `capturePanesTail` con `-J`,
`buildCaptureArgs`/`parseCaptureBatch` puras, `PASTE_THRESHOLD_BYTES` compartido),
`sessions.ts` (`attachAttention`), `types.ts` + `web/src/types.ts` (espejo),
`engine.ts` (`deliverPromptWhenReady`), `index.ts` (umbral compartido + broadcast),
`web/src/components/sessions/SessionContext.tsx`, `SessionWorkspace.tsx`, `DesktopApp.tsx`,
`web/src/ronin-shell.css`.

### Seis defectos encontrados en verificación (no por los tests)

Los tests de la primera pasada pasaban en verde con el semáforo **muerto en producción**. Cada uno
se devolvió a codex con la causa ya diagnosticada y un test RED exigido:

1. **`capturePanesTail` no separaba los comandos tmux.** Faltaba el `;` entre grupos ⇒
   `command display-message: too many arguments`; el `catch` devolvía un Map vacío y `attention`
   NUNCA llegaba al inventario. → `39f31e2`, con `buildCaptureArgs`/`parseCaptureBatch` puras.
2. **La pregunta salía con el marco de la TUI** (`│ Para probar…`). → `ee74e9d`.
3. **Panes angostos partían la pregunta.** Sin `-J`, tmux devuelve la fila envuelta y el API servía
   `"u-818. ¿Cómo lo hago?"`. → `1a386bd` (`capture-pane -J`, medido a 80 columnas).
4. **Panes altos perdían la decisión.** La ventana de 25 líneas se la comían las filas vacías del
   final. → `1a386bd`.
5. **Build del servidor roto** (`findLastIndex`, TS2550 con target ES2022): los tests pasaban
   porque tsx no hace typecheck. → `eedea9b`. A partir de ahí los cuatro comandos
   (2 suites + 2 builds) son obligatorios en cada pasada.
6. **Un guard sobreajustado suprimía decisiones** dentro de cajas de Claude Code (falso negativo,
   justo lo que el ticket quiere evitar). → `eedea9b`, eliminado; la asimetría queda documentada:
   una pregunta truncada es aceptable, no enterarse no lo es.

Más dos correcciones visuales: el ámbar se había aplicado a `<b>` sin acotar y teñía el marcador de
TODAS las filas (diluía el semáforo) → `bc65213`; y concordancia del contador + ancho del badge →
`23a1f85`.

## Resultado de suites

| Suite | Resultado |
|---|---|
| `npm test -w server` | **438 pass / 0 fail** |
| `npm test -w web` | **49 pass / 0 fail** |
| `npm run build -w server` | OK |
| `npm run build -w web` | OK |

Ningún test preexistente fue editado para pasar: sólo se añadieron casos.
Cobertura: el repo no tiene instrumentación configurada (`node --test` sin
`--experimental-test-coverage` ni umbral); montarla queda fuera del alcance. Detalle en
`{cycle}/evidence/tests.md`.

## Curl en DEV por criterio

DEV = servidor de esta rama en `:8799` con el data dir real de la app
(`~/Library/Application Support/claude-cowork/data`), levantado aparte para no tocar la app
Electron del operador (que corre `main` en `:8787`). Detalle completo en `{cycle}/evidence/curl.md`.

| AC | Criterio | Veredicto |
|---|---|---|
| AC1 | `GET /api/sessions` trae `attention.level` en toda sesión con panes | **PASA** (antes: `None` en todas) |
| AC2 | Una sesión detenida en una decisión sale `decision` con su pregunta | **PASA** (sintético + true positive en vivo) |
| AC3 | Un pane con el spinner actual sale `working`, no `idle` | **PASA** |
| AC4 | El prompt de lanzamiento llega COMPLETO | **PASA** (etapas 3-5 y VERIFICADOR presentes; antes 0) |
| AC5 | Sin regresiones (suites + builds) | **PASA** |
| AC6 | Visible en la UI | **PASA** (capturas en `{cycle}/evidence/`) |

### AC2 — true positive en producción

Durante la verificación el semáforo marcó `decision` en una sesión REAL del operador
(`cowork-PR-Multi-idioma`, pane `%77`) que llevaba rato bloqueada en un `AskUserQuestion` sin que
nada lo indicara:

```json
{"level":"decision",
 "question":"Para probar el AC de `language=en` necesito encender el feature en dev sobre bu-818. ¿Cómo lo hago?",
 "paneId":"%77"}
```

Es exactamente el escenario del ticket, cazado en vivo.

## Limpieza pendiente en dev

Ninguna. Todo lo creado para probar quedó revertido:

- sesión `cowork-ac4-probe` cerrada, worktree eliminado, rama `ronin/cowork-ac4-probe` borrada
  (`git worktree list` limpio), cycle dir borrado;
- sesiones sintéticas `cowork-ac2-probe`, `cowork-decision-demo`, `cowork-wrap-probe`,
  `cowork-probe`/`cowork-probe2` cerradas y sus cycle dirs borrados;
- servidores auxiliares `:8799` y `:8800` apagados; el `:8787` del operador nunca se tocó;
- panes de codex cerrados; `git status` limpio.

## Pendientes / PRs

- **Sin push y sin PR**: los 10 commits viven en `ronin/cowork-ronin` en el worktree.
- La app Electron empaquetada (`:8787`) sigue corriendo `main`; hay que reempaquetarla o reiniciar
  el backend en modo dev para ver el semáforo en la app del operador.

### Fuera de alcance (dicho, no omitido)

- **Notificación nativa del sistema / badge en el Dock.** Este ticket cierra el "no hay forma de
  saberlo" DENTRO de la app; una notificación fuera de la ventana es un canal nuevo.
- **Endpoint por pane** que materialice el `PaneView` muerto de `types.ts:96`.
- **Picker de `/model` sin numerar** (`❯ Opus 4.8`): no se detecta. La caja de input es `❯ ` + lo
  que el usuario escribe, así que aceptar `❯ <texto>` sin número convertiría cualquier prompt a
  medio teclear en una alerta. Límite conocido y deliberado.
- **Ingesta al backup-tester**: no hay `curl.env` para esta sesión y el ticket es sobre la app local
  de escritorio, no sobre un servicio con DEV remoto.
