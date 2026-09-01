# EVIDENCIA — Captura de nueva sesión grande + paridad de tmux en la terminal normal

Rama `ronin/cowork-ronin-fixes` · base `4dceda0` · HEAD `52e2c74`
Workflow `claude-plan-codex-impl` · sesión `cowork-ronin-fixes`

## Veredicto

**Las dos peticiones quedan resueltas y verificadas contra el servidor real de Ronin.**

- **T1 — la captura de nueva sesión.** El modal era de 390 px fijos y el `textarea` de la petición
  no lo alcanzaba **ninguna** regla CSS: heredaba el tamaño por defecto del navegador con
  `rows="4"`. Ahora el diálogo mide `min(760px, 92vw)` (con `max-height: 88vh`) y la petición es un
  campo monoespaciado de ancho completo, 12 filas, `min-height: 220px` y redimensionable a mano.
- **T2 — la terminal normal.** La premisa era **parcialmente cierta** y hubo que corregirla: las
  opciones de *sesión* (`mouse on`, `history-limit 50000`) sí se aplicaban, pero llegaban **tarde**
  para el pane inicial, que es el único que tiene una sesión `mode:"terminal"`. Ese pane nacía con
  el default de fábrica de tmux: **2 000 líneas**. Además, el copiado con el ratón lo bloqueaba el
  propio `claude`/`codex` al tomar el reporte de ratón. Las dos cosas están arregladas y medidas.

## Causa / cadena

### T1 — el textarea no estaba estilado

- `web/src/ronin-shell.css:17` (antes) — `.ronin-new-session,.ronin-inline-modal>div { width: 390px; … }`.
  Un solo ancho fijo compartido con el modal inline chico.
- `web/src/ronin-shell.css:15` y `:17` (antes) — las reglas de tamaño sólo listaban
  `select` e `input`: `.ronin-new-session select,.ronin-new-session input { width:100%; box-sizing:border-box }`.
  **El `textarea` no aparecía en ninguna**, así que no tenía ancho, ni fuente monoespaciada, ni
  `resize`, ni `min-height`.
- `web/src/components/NewSessionDialog.tsx:70` (antes) — `<textarea … rows={4} />`.

Resultado: 4 renglones proporcionales dentro de una caja de 390 px ⇒ cualquier párrafo hace scroll.

### T2 — el `history-limit` llegaba después de que el pane ya existía

- `server/src/tmux.ts:139-143` — `createSession()` hacía `tmux new-session …` y **después**
  `applyBaseSessionOptions()`.
- `server/src/tmux.ts:412-420` — `baseSessionOptionCommands()` fija `history-limit 50000` con
  `set-option -t <sesión>`.
- En tmux el `history-limit` se aplica **al crear** el pane: el pane inicial se queda con el default
  global. Comprobado en un servidor tmux desechable:
  `new-session → set-option -t s history-limit 50000` ⇒ pane con **2000**;
  `set-option -g history-limit 50000 → new-session` ⇒ pane con **50000**;
  `respawn-pane -k` **no** lo corrige.
- Medición en vivo antes del cambio (`tmux list-panes -a -F '#{session_name} #{pane_id} #{history_limit} mouse_any=#{mouse_any_flag}'`):

  ```
  cowork-86e31achb-DIOT-no-sumar-iva %200 2000  mouse_any=1   <- pane inicial (claude)
  cowork-86e31achb-DIOT-no-sumar-iva %201 50000 mouse_any=0   <- pane creado por el skill (shell)
  cowork-cfdis-download              %202 2000  mouse_any=1   <- sesión mode=terminal (único pane)
  cowork-ronin-fixes                 %203 2000  mouse_any=1
  ```

  De ahí la asimetría que reportaba el ticket: en **workflow** el skill `tmux-worker-loop` parte
  panes nuevos *después* de fijar la opción y ésos sí quedan con 50 000; la sesión **terminal**
  tiene un solo pane y siempre se quedaba con el degradado.

### T2b — el copiado con ratón lo bloqueaba la propia CLI

- `mouse_any_flag=1` en el pane que corre `claude`/`codex`: la CLI activa el reporte de ratón.
- El bind *root* por defecto de tmux es
  `MouseDrag1Pane → if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" {send-keys -M} {copy-mode -M}`:
  con la app pidiendo ratón, el arrastre **se le manda a la app** y nunca se entra a copy-mode.
- Los binds de copiado que Ronin ya instalaba (`server/src/tmux.ts:424-427`, tablas `copy-mode` y
  `copy-mode-vi`) sólo actúan **una vez dentro** de copy-mode ⇒ nunca se disparaban.
- En workflow los panes extra del skill son shells (`mouse_any_flag=0`) y ahí sí funcionaba el
  arrastre: la misma asimetría, otra causa.

## Cambios

| Archivo | Qué cambia |
|---|---|
| `web/src/components/NewSessionDialog.tsx` | `textarea` de la petición: `rows={12}`, `className="ronin-request-input"`, `spellCheck={false}`; la nota del modo terminal menciona el atajo de copiado |
| `web/src/ronin-shell.css` | `.ronin-new-session` se separa de `.ronin-inline-modal>div` y pasa a `min(760px, 92vw)` + `max-height: 88vh` + `overflow: auto`; nueva regla `.ronin-request-input` (ancho completo, `min-height: 220px`, `resize: vertical`, monoespaciada) |
| `server/src/tmux.ts` | nuevo `serverDefaultOptionCommands()` + `applyServerDefaults()`: fija `set-option -g history-limit 50000` **antes** del `new-session`, en `createSession` y `createDriverWindow`; `baseSessionOptionCommands()` añade 4 binds en la tabla `root` (`M-`/`S-MouseDrag1Pane → copy-mode -M`, `M-`/`S-WheelUpPane → copy-mode -e`) |
| `skills/tmux-worker-loop/SKILL.md` | mismo `set-option -g history-limit` previo a los splits + los 4 binds nuevos (si el skill diverge del server, vuelve la asimetría) |
| `skills/tmux-worker-loop/references/pane-discovery.md` | idem para la ruta de provisión de panes |
| `server/src/tmux.test.ts` | + assert de `history_limit` del pane inicial (`createSession`) y de los 4 panes (`createDriverWindow`); + los 4 binds `root` en los dos casos de `baseSessionOptionCommands` |
| `web/src/components/NewSessionDialog.test.ts` | + render SSR del diálogo: el `textarea` es `ronin-request-input` con `rows="12"`, y el CSS declara el ancho del modal y el `min-height` del campo |

Commits: `377bf1c fix(ui): amplía la captura de nueva sesión`, `52e2c74 fix(tmux): historial y copiado en terminal normal`.
Implementados por Codex (`codex exec`, ventana tmux `cowork-ronin-fixes:codex-impl`) con
`/tmp/cowork-cycle-cowork-ronin-fixes/plan.md` como contrato. El diff coincide exactamente con la
lista de archivos prometida en el plan.

## Resultado de suites y cobertura

**RED primero** — worktree desechable en `4dceda0` con *sólo* los dos archivos de test nuevos
copiados encima (`/tmp/cowork-cycle-cowork-ronin-fixes/evidence/red-baseline.txt`):

```
web    : ✖ el diálogo workflow ofrece una petición amplia y redimensionable   (tests 2 · pass 1 · fail 1)
         AssertionError: el HTML base rinde `<textarea … rows="4">`, sin clase
server : ✖ createSession aplica las opciones base de scroll e historial       (tests 20 · pass 16 · fail 4)
         AssertionError: '2000' !== '50000'   <- history_limit del pane INICIAL
         ✖ createDriverWindow deja sus cuatro panes con historial completo
         ✖ las opciones base en darwin emiten los dos bind-key con pbcopy
         ✖ las opciones base sin comando de portapapeles no emiten bind-key
```

**GREEN** con los cambios (`52e2c74`):

| Suite | Comando | tests | pass | fail | duración |
|---|---|---|---|---|---|
| web | `npm test -w web` | 60 | 60 | 0 | 502 ms |
| server | `npm test -w server` | 477 | 477 | 0 | 5 529 ms |
| desktop | `npm run test:desktop` | 105 | 105 | 0 | 1 997 ms |

La primera corrida de `test:desktop` marcó 104/105 por
`✖ el preload COMPILADO no requiere ningún archivo local` con `ENOENT desktop/dist/preload/index.js`:
artefacto de build ausente en el worktree, no una regresión. Tras `npm run build:desktop` queda
105/105. **Sin fallos nuevos.**

**Cobertura:** las suites de este repo son `node --test` sin instrumentación
(`--experimental-test-coverage` no está configurado y no hay `coverage.xml`). No se reporta
porcentaje porque sería inventado; lo que sí hay es el delta de casos (+1 test en web, +2 asserts de
panes en server, y 4 tests que pasaron de rojo a verde).

## Verificación en DEV por criterio

DEV aquí es la API Express del propio Ronin levantada desde el worktree de la rama con datos
aislados (este repo es una app de escritorio local: no hay `$DEV_URL` remoto ni `curl.env`):
`PORT=8899 COWORK_DATA_DIR=<scratch>/data COWORK_ALLOWED_ROOTS=<scratch> npm start -w server`,
con el repo `monorepo` remapeado a un git sandbox desechable para no tocar el monorepo real.
Comandos, request y response completos en `/tmp/cowork-cycle-cowork-ronin-fixes/evidence/curl.md`.

Antes de probar se restauró la línea base del servidor tmux (`set-option -g history-limit 2000` y
`unbind-key` de los 4 binds nuevos → 0 coincidencias), para que el veredicto no viniera de un
estado previo.

| # | Criterio | Comprobación | Veredicto |
|---|---|---|---|
| C1 | Terminal normal con 50 000 líneas | `POST /api/sessions {mode:"terminal",agent:"claude"}` → **HTTP 201**; `tmux list-panes` → `%205 history_limit=50000` (antes 2000) | **PASA** |
| C1b | Scrollback real | 5 000 líneas impresas en el pane → `history_size=4978`; `capture-pane -S -4000` recupera `linea 978` | **PASA** |
| C2 | Sin regresión en workflow | `POST /api/sessions {mode:"workflow"}` → **HTTP 201**; `%206 history_limit=50000` | **PASA** |
| C3 | Binds de escape en `root` | `tmux list-keys -T root` lista los 4: `M-/S-MouseDrag1Pane → copy-mode -M`, `M-/S-WheelUpPane → copy-mode -e` | **PASA** |
| C4 | Sin regresión del portapapeles | `list-keys -T copy-mode` y `-T copy-mode-vi` siguen con `copy-pipe-and-cancel pbcopy` | **PASA** |
| C5 | El server arranca | `GET /api/health` → **HTTP 200** `{"ok":true,"service":"ronin-api"}` | **PASA** |
| C6 | Captura grande | Render SSR: `<textarea class="ronin-request-input" … rows="12">`; CSS efectivo: modal `min(760px, 92vw)` + campo `min-height: 220px`; `npm test -w web` 60/60 | **PASA** |

## Limpieza pendiente en dev

- Sesiones tmux de verificación (`cowork-verif-terminal`, `cowork-verif-workflow`): **cerradas**
  vía `DELETE /api/sessions/:name` (HTTP 200 en las dos). Sus `/tmp/cowork-cycle-cowork-verif-*`
  borrados; worktree y rama efímeros del sandbox eliminados (`git worktree remove` + `git branch -D`),
  incluido el directorio padre huérfano. Servidor de pruebas del puerto 8899 detenido.
- **Efecto lateral asumido y permanente:** `applyServerDefaults()` sube el default **global** del
  servidor tmux a `history-limit 50000`. Es la única forma de que el pane inicial nazca con
  scrollback completo (`set-option -t <sesión>` llega tarde por construcción). Sólo afecta a panes
  creados después, y sigue el mismo criterio ya aceptado en el repo para las tablas de teclas, que
  también son globales. Hoy el servidor tmux del operador ya quedó en 50 000.
- Sin borrar: la ventana `cowork-ronin-fixes:codex-impl` con el log del implementador; se conserva
  como evidencia hasta que se cierre la sesión.

## Pendientes / PRs

- **Sin PR abierto.** Dos commits en `ronin/cowork-ronin-fixes`, **sin push** (así lo pedía el
  contrato del implementador). Falta decidir merge a `main` y reempaquetar el desktop
  (`npm run package:desktop`) para que el binario instalado tome los cambios: los binds y el
  `history-limit` los aplica el **server**, así que la app instalada seguirá creando sesiones con el
  comportamiento viejo hasta que se reempaquete.
- **Verificación manual que falta y no puedo hacer por mí mismo:** confirmar en la UI que
  Opción+arrastre (o Shift+arrastre) sobre un pane con `claude` corriendo selecciona y copia. La
  cadena está probada por sus dos extremos — tmux tiene los binds (C3) y el destino sigue siendo
  `pbcopy` (C4) —, pero el tramo de en medio depende de que xterm.js/ttyd reenvíe el modificador del
  ratón, y eso sólo se ve con un ratón real sobre la ventana.
- No se ingirió nada al backup-tester: no hay `$BACKUP_TESTER_URL`/`$BACKUP_TESTER_INGEST_TOKEN` en
  este entorno ni reporter JUnit en las suites; no había `junit.xml` que subir.
