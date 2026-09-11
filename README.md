<p align="center">
  <img src="web/public/lkmx/lkmx-mark.svg" width="56" alt="LKMX" />
</p>

<h1 align="center">Ronin</h1>

<p align="center">Orquestador local de sesiones <b>tmux</b> con workflows para trabajo asistido por Claude.<br/><i>Por LKMX.</i></p>

---

## Qué es

**Ronin** es una aplicación local para crear, observar y operar sesiones tmux de agentes. Cada sesión congela un workflow y trabaja sobre el repositorio configurado; no depende de un tablero ni de tickets externos.

## Características

- Inventario de sesiones tmux gestionadas y externas, con adopción y liberación seguras.
- Workflows versionados con **ejecutor y modelo por etapa**, overrides por repositorio, Skills y
  propuestas asistidas por Claude.
- Terminales ttyd y xterm, captura por pane, foco y Attach a Terminal.app.
- **Servidor MCP propio**: el agente reporta sus pruebas a Ronin en vez de que Ronin las ejecute.
- Aplicación de escritorio (Electron) empaquetable para macOS, Windows y Linux.

### Nueva sesión con petición

Elige un workflow y un repositorio, escribe una petición y Claude arranca el flujo por sí solo dentro de una nueva sesión tmux. Las sesiones ajenas se pueden adoptar sólo desde raíces de confianza configuradas.

### Sesiones, Driver y tmux

Las sesiones tmux son la fuente de verdad. La vista **⌘** lista sesiones gestionadas y externas, permite seleccionar panes, usar ttyd cuando está disponible y muestra un respaldo de sólo lectura por `capture-pane` mientras se resuelve la terminal.

Un workflow puede abrir una ventana Driver de cuatro panes (`driver | worker` arriba y `review | verify` abajo). El driver recibe el prompt inicial y coordina los demás panes mediante el skill; Ronin conserva la geometría, los IDs `%N` y los roles de tmux. El zoom de tmux es compartido por ventana.

### Reportes (📊)

Los reportes diario/semanal se construyen a partir de sesiones, evidencia y commits locales.

### Pruebas (⚗ test harness)
- **Calendario de actividad por repositorio**, al estilo del grafo de contribuciones: una fila por
  repo y una celda por día de los últimos 90. El tono de la celda es el peor resultado del día
  (pasó / falló / error) y la intensidad, el número de corridas. Un día se decide por la fecha
  **local**, no UTC. Los estados `blocked`, `cancelled`, `queued` y `running` no son veredicto: no
  pintan la celda ni cuentan.
- **Procedencia**: cada corrida guarda si la midió Ronin (`harness`) o la reportó el agente
  (`agent`), y la UI lo distingue. Una corrida auto-declarada no se mezcla en silencio con una
  medida — la matriz la marca con `· agente` y el detalle lo dice con todas sus letras.
- Matriz **repo × suite** (`Unit · E2E · API/OpenAPI · Browser`) con una fila por repo de `repos.json`.
  Una celda sin configurar dice *sin configurar*; nunca cuenta como verde. La cobertura sólo se
  muestra si se leyó un **Cobertura XML** o **LCOV** real; si no, *no reportada* (jamás un 0%).
- Cada corrida persiste conteos JUnit, cobertura, fallos, salida acotada y **copias** de los
  artefactos en `server/data/test-artifacts/<runId>/`, así el historial no cambia si el repo se
  vuelve a correr. Estados: `queued · running · passed · failed · error · timeout · cancelled · blocked`.
- Los comandos son `program + args` — **sin shell** — en la carpeta del repo (o `cwd` relativa
  para monorepos), con un entorno mínimo (`PATH`, `HOME`, locale) más las **variables del
  perfil**. Los valores del perfil nunca vuelven a la UI ni al journal (se redactan antes de
  persistir). Este corte ejecuta `unit`/`e2e`/`browser`; `api` (OpenAPI/curl) queda para después.
- Desde terminal o CI, sin agente ni server HTTP (construye el server si hace falta):

  ```bash
  npm run tests:all -- --profile dev
  npm run tests:repo -- ant-liebre-api --profile dev
  npm run tests:suite -- ant-liebre-api unit --profile dev
  npm run tests:failed -- --profile dev          # reintenta sólo lo que falló con ese perfil
  npm run tests:all -- --profile dev --json      # resumen JSON (sin stdout/stderr)
  npm run tests:suite -- ant-liebre-api unit --profile dev --root "$PWD"   # otra raíz
  ```

  `--root <ruta>` corre la suite contra otra copia del repo (por ejemplo el worktree de una
  sesión) en vez de la que mapea `repos.json`. La ruta se valida contra las raíces de confianza;
  fuera de ellas la corrida queda `blocked` con su motivo en vez de ejecutarse. **Sólo existe en
  el CLI**: la API HTTP nunca acepta rutas, porque el renderer manda identificadores.

  Espera a que todas las corridas terminen y sale con `0` (todo ok), `1` (failed/error/timeout/
  cancelled), `2` (bloqueada: perfil o suite sin configurar) o `64` (argumentos inválidos).
  `RONIN_SKIP_BUILD=1` reutiliza `server/dist` sin recompilar.
- Configuración en `server/data/test-harness.json` (local, **gitignored**, se edita desde la
  pantalla ⚗ o a mano), indexada por la clave del repo en `repos.json`:

  ```json
  {
    "ant-liebre-api": {
      "profiles": [{ "name": "dev", "variables": { "PATH": "/usr/local/bin:/usr/bin:/bin", "DATABASE_URL": "…" } }],
      "suites": {
        "unit": {
          "command": { "program": ".venv/bin/pytest", "args": ["-q", "--junitxml=reports/junit.xml", "--cov=src", "--cov-report=xml:reports/coverage.xml"] },
          "cwd": "ant-liebre-api",
          "timeoutMs": 900000,
          "junitPath": "reports/junit.xml",
          "coberturaPath": "reports/coverage.xml"
        }
      }
    }
  }
  ```

  `program` relativo se resuelve contra `cwd`; `junitPath`/`coberturaPath`/`lcovPath` deben quedar
  dentro del repo (se rechazan `..`, absolutas y symlinks que escapen). Para vitest:
  `npx vitest run --reporter=junit --outputFile=reports/junit.xml` (+ `--coverage.reporter=lcov`
  con `@vitest/coverage-v8` instalado). Al reenviar la config desde la UI, una variable con valor
  `null` conserva el valor ya guardado.

### Workflows: crear y proponer con Claude (✦)
- **＋ Nuevo** — crea un workflow desde una plantilla mínima de 3 etapas (**Plan → Impl → Tests**) y
  lo abre directo en el editor (Grafo / Stepper / JSON), listo para nombrarlo y ajustarlo.
- **✦ Analizar flujo reciente** — corre un análisis en segundo plano sobre un rango de fechas
  (default **últimos 14 días**) y propone workflows nuevos a partir de patrones reales de trabajo:
  - **Señales**: eventos de `history.jsonl` (lanzamientos/paradas/completados por tarea), `git log`
    de cada repo configurado, y archivos de evidencia (`EVIDENCIA-*.md` / `research.md`) tocados en
    el rango — acotado a **80 tareas / 60 commits por repo / 15 archivos de evidencia × 3 KB** cada
    uno para que el prompt no crezca sin límite.
  - Las señales arman un prompt que se manda a **`claude -p` headless** (timeout de **5 minutos**);
    la salida se parsea como JSON y cada propuesta se valida una por una.
  - Las propuestas se guardan como **borradores** en `server/data/workflow-proposals.json`
    (**gitignored**, nunca se commitean) y **no entran al catálogo** de workflows hasta que el
    operador las revisa y pulsa **Aceptar** en el panel de Propuestas; **Descartar** las cierra sin
    tocar nada más.
  - Una propuesta que trae `verifyCmd` (shell arbitrario, sólo permitido en overrides por-repo) o que
    choca de nombre con un workflow ya existente se **descarta automáticamente con un motivo legible**
    en vez de tumbar el análisis completo; el resto del lote se sigue procesando igual.
  - El prompt sólo lleva texto de historia/commits/evidencia del propio repo — **nunca tokens ni
    variables de entorno** — y toda la salida del modelo se trata como **no confiable** hasta pasar
    la validación de `validateStages`.

### Pruebas reportadas por el agente (MCP)

Ronin expone un **servidor MCP** propio en `POST /mcp` (JSON-RPC 2.0 sobre HTTP) con dos
herramientas para el worker:

- `reportar_pruebas(repo, suite, junitPath, coberturaPath?, profile?)`
- `estado_pruebas(repo?)`

La idea es invertir la dirección: el agente ya corre la suite en un checkout que tiene su entorno
montado, así que **Ronin deja de ejecutar pruebas y pasa a ser libro de registro**. Dos reglas lo
sostienen:

- **Los números salen del artefacto, no del resumen.** La herramienta recibe la *ruta* del
  `junit.xml` y es Ronin quien lo parsea. Si el artefacto no se puede leer, la corrida **no se
  registra**: antes un hueco en el calendario que un número inventado.
- **Las rutas se validan** contra las raíces de confianza, deben ser absolutas y apuntar a un
  archivo regular por debajo de un tope de tamaño.

El worker lo recibe cableado sin tocar su repo: Ronin escribe `agent-mcp.json` en su data dir
(permisos `0600`, lleva el token de capability) y lanza cada sesión con `--mcp-config <ruta>`. Eso
acota el servidor **a las sesiones que Ronin crea** — no toca la configuración global de Claude
Code ni deja un `.mcp.json` en el worktree que el agente pudiera commitear. La bandera es aditiva:
los demás servidores MCP del operador siguen disponibles.

El endpoint pasa por la misma puerta de capability y de origen local que el resto de la API; el
token viaja en la cabecera que Ronin escribe en esa configuración.

### Ejecutor y modelo por etapa

Cada etapa declara **quién la ejecuta** y **con qué modelo**, y el prompt se genera desde ahí:

```json
{ "key": "implementing", "label": "Impl", "executor": "codex", "model": "gpt-5.3-codex" }
```

- `executor` es `claude`, `codex` o `agy`. **Ausente = hereda del flujo**, y esa herencia se ve
  escrita en el nodo: nunca queda en blanco.
- El grafo, el stepper y el modal muestran la herramienta con una chapa de monograma, y la chapa
  **no** usa colores de estado: el ejecutor de una etapa no dice nada sobre cómo fue.
- El verde tiene dos significados en la app, y los dos son «esto está comprobado»: en Pruebas,
  que una corrida pasó; en la vista **Harness**, que la etapa lleva un **sensor determinista**
  (`verifyCmd`) y no depende de que el agente diga que terminó. El ámbar y el rojo del medidor de
  cobertura son el mismo eje: cuánta evidencia verificable deja el loop. Lo que sigue prohibido es
  pintar de verde una etapa por su ejecutor o por su avance: eso hablaría del estado del flujo.
- Cada herramienta recibe el modelo a su manera: Claude lo cambia dentro de la sesión con
  `/model`, Codex lo toma con `--model`. **La bandera de modelo de `agy` es un hueco conocido**:
  hasta que su CLI documente una, el comando sale sin bandera y el modelo se menciona en prosa.
- Esto sustituye a escribir el ejecutor a mano en la instrucción. Las instrucciones dicen ahora
  **qué** hacer; **quién** lo hace lo redacta Ronin.

### Vista Harness del editor

La cuarta vista del editor lee cada etapa como un pequeño arnés: separa lo que guía al agente de
lo que observa o bloquea su avance. En el shell de escritorio (Ronin) vive en `Workflows` → segmento
`Grafo/Stepper/JSON/Harness`, sobre el catálogo de workflows; ahí `verifyCmd` sale deshabilitado porque el
catálogo es git-tracked y el servidor lo rechaza (`VERIFY_CMD_NOT_ALLOWED`) — sólo se arma desde el override
por-repo del dashboard web (⚙ Workflow). Hay cuatro controles con interruptor:

- **Instrucción** edita `instruction`.
- **Ejecutor/modelo** edita `executor` y `model` como una unidad.
- **Verificador inferencial** elige la etapa de `verifyAfter`.
- **Gate de avance** edita `verifyCmd`; `maxRetries` es un parámetro del comando, no un quinto
  interruptor.

Los chips derivados de la instrucción —por ejemplo `junit.xml`, cobertura o ingesta— describen
intención, pero no prueban que el artefacto exista.

El medidor muestra `etapas con verifyCmd / etapas totales`: cuenta gates deterministas declarados,
no controles encendidos, texto abundante ni verificaciones ya ejecutadas. Por eso puede marcar
`0 / N` aunque el riel y las etapas se vean llenos de guías, sensores inferenciales y chips de
prosa. En un workflow global siempre queda en cero: `verifyCmd` y `maxRetries` sólo se conservan en
el override por-repo. Incluso allí, el servidor sólo honra `verifyCmd` con el gate encendido (lo
está por defecto; `COWORK_VERIFY_GATE=0` lo apaga); apagado, el medidor sigue describiendo
configuración declarada, no comprobaciones realizadas.

### Gate de etapa por `verifyCmd` (opcional)

Una etapa del override por-repo puede declarar `verifyCmd` y `maxRetries`: cuando el worker marca
esa etapa, un bucle en el servidor lo ejecuta en su worktree mientras el worker está ocioso, con
reintentos y sin falsos verdes (agotados los intentos, el gate queda `failed` para siempre). Está
**encendido por defecto** (a diferencia del planificador de reportes, que sigue siendo opt-in) y se
apaga con `COWORK_VERIFY_GATE=0`. Ojo: ejecuta shell dentro del worktree de las sesiones vivas del
repo, así que sólo el override por-repo (gitignored) puede declarar `verifyCmd`; el workflow global y
el catálogo lo rechazan.

Si el repo declara `setupCommand`, Ronin lo corre en segundo plano al crear el worktree para armar
su entorno (`.venv`, `node_modules`), y el gate espera a que termine; si la provisión falla, se
salta **sin tocar el estado del gate** — un entorno roto no es un veredicto sobre el código.

> **Límite conocido:** esto sólo sirve en repos de una pieza. Un worktree de un repo paraguas que
> contiene otros repos independientes (ignorados por él) no trae el código de los sub-repos, así
> que no hay nada que probar ahí. Para esos casos, el camino es el MCP: que reporte el agente.

### Pendiente conocido: instrucción vacía

`server/src/templates.ts:44` intenta dar una instrucción por defecto así:

```ts
const instruction = fill(s.instruction ?? `etapa ${s.label}.`);
```

El operador `??` no atrapa la cadena vacía que produce la normalización del workflow. Al apagar
`instruction`, el prompt puede contener un paso numerado sin texto después del guion. El arreglo de
una línea pendiente es:

```ts
const instruction = fill(s.instruction?.trim() || `etapa ${s.label}.`);
```

No se aplica en este cambio porque altera el comportamiento del runner, que queda fuera de este
alcance.

## Arquitectura

```
server/   Express + TypeScript  → API local, sesiones tmux, workflows y servicios locales
web/      Vite + React + TS     → interfaz de sesiones, workflows, Skills y pruebas
```

**Server (`server/src/`):** `index.ts`, `engine.ts` (adopción), `tmux.ts` / `ttyd.ts`, `sessions.ts`, `session-launch.ts`, `workflow.ts`, `workflow-catalog.ts`, `workflow-insights/`, `repos.ts`, `repo-config.ts`, `repo-roots.ts`, `skills.ts`, `reports.ts`, `history.ts`, `preflight.ts`, `mcp.ts` + `agent-mcp.ts` (servidor MCP y su configuración para el worker), `verify.ts` + `verify-driver.ts` (gate de etapa), `provision.ts` (entorno del worktree) y `test-harness/`.

**Web (`web/src/`):** `App.tsx` y `DesktopApp.tsx` (el shell de escritorio), `screens/SessionsScreen.tsx`, `components/sessions/`, `components/PaneViewer.tsx`, `components/pane-terminal.ts`, `components/tests/` (calendario de actividad) y las pantallas de workflows, Skills y pruebas.

## Correr

```bash
npm install
npm run dev        # server (:8787) + web (:5180)
```

Abre **http://localhost:5180**. Requiere Node, `tmux` y `claude` en el PATH. `brew install ttyd` habilita la terminal interactiva embebida; sin ttyd, Ronin usa el visor de sólo lectura por pane.

### Desktop Electron

Ronin se usa normalmente como **aplicación de escritorio**: la misma interfaz web dentro de una
ventana Electron que además levanta el backend por su cuenta, así que no hay que arrancar nada a
mano ni dejar una pestaña abierta.

```bash
npm run dev:electron  # Vite + Electron; espera Vite hasta 30 s antes de navegar
npm run test:electron # build web/server/desktop y smoke de producción local
npm run package:desktop:dir # paquete sin instalador, útil para validar recursos/nativos
npm run package:desktop # DMG/ZIP en macOS; NSIS/portable en Windows; AppImage/deb en Linux
```

**Uso día a día.** `npm run package:desktop` deja el instalador y la app en `release/`
(`release/mac-arm64/Ronin.app` en macOS). Se abre como cualquier aplicación; el backend arranca
con ella y muere con ella. Al cerrarla **no se pierde nada**: las sesiones viven en tmux y siguen
corriendo, y al reabrir la app vuelven a aparecer en el inventario.

Los datos editables (workflows, overrides por repo, ajustes, journal de pruebas y artefactos) no
viven en el repo sino bajo `userData` — en macOS,
`~/Library/Application Support/claude-cowork/data`. Sólo los defaults no sensibles se empaquetan.

**Variables de entorno.** Una app abierta desde el Finder no hereda tu shell, así que las
variables opcionales hay que pasarlas lanzando el binario:

```bash
COWORK_REPORT_SCHEDULE=1 release/mac-arm64/Ronin.app/Contents/MacOS/Ronin   # p.ej. encender los reportes
COWORK_VERIFY_GATE=0 release/mac-arm64/Ronin.app/Contents/MacOS/Ronin       # o apagar el gate de verifyCmd
```

Sin firma ni notarización todavía: la primera vez, macOS pide abrirla con clic derecho → Abrir.

El Main sirve el renderer desde `app://ronin` con CSP estricta, `contextIsolation`,
`nodeIntegration:false` y un bridge allowlisted `window.roninDesktop.terminal`. La pantalla de
Sesiones usa `xterm.js` + `node-pty` para adjuntar a tmux en modo lectura; los destinos son IDs
`%N`, el PTY se cierra sin matar la sesión tmux y cualquier intento de escritura se rechaza hasta
que exista adopción/autorización explícita. En desarrollo, una barrera reintenta Vite y la
navegación dentro de un límite global de 30 s; si se agota, muestra recuperación para reintentar o
cerrar en vez de dejar una ventana vacía. El backend es un hijo local supervisado: `PORT` debe ser
un entero entre 1024 y 65535 (por defecto 8787), el hijo publica su puerto validado y el Main
espera health tokenizado antes de crear la ventana. Al cerrar, se destruyen PTYs/ventana y se
espera el cierre del hijo.

Los paquetes reconstruyen `node-pty` para la ABI de Electron, lo mantienen fuera del asar y
resuelven los datos editables bajo `userData`; sólo defaults no sensibles entran al paquete.

El smoke exige una sesión gráfica local compatible y sólo es válido si produce una única línea
`RONIN_SMOKE:PASS`. En el host de esta implementación queda
`BLOCKED_ENVIRONMENT_GUI_BEFORE_APP_CODE`: Electron aborta con `SIGABRT` en
LaunchServices/`NSApplication` antes de ejecutar código de la app. No es un PASS ni un fallo
atribuido a la aplicación. La firma/notarización sigue diferida; workflows, pruebas, skills,
preflight y la autorización de escritura quedan como siguientes bloques del producto.


## Skills

Los workflows usan Skills de Claude Code vendorizadas en [`skills/`](skills/), incluido `tmux-worker-loop` para coordinar panes tmux.

## Estado

Uso interno de LKMX. Requiere una suscripción de Claude Code activa.

---

<p align="center"><sub>🤖 Orquestado con Claude Code + el skill <code>/tmux-worker-loop</code>.</sub></p>
