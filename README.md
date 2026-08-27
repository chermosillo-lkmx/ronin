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
- Workflows versionados, overrides por repositorio, Skills y propuestas asistidas por Claude.
- Terminales ttyd y xterm, captura por pane, foco y Attach a Terminal.app.

### Nueva sesión con petición

Elige un workflow y un repositorio, escribe una petición y Claude arranca el flujo por sí solo dentro de una nueva sesión tmux. Las sesiones ajenas se pueden adoptar sólo desde raíces de confianza configuradas.

### Sesiones, Driver y tmux

Las sesiones tmux son la fuente de verdad. La vista **⌘** lista sesiones gestionadas y externas, permite seleccionar panes, usar ttyd cuando está disponible y muestra un respaldo de sólo lectura por `capture-pane` mientras se resuelve la terminal.

Un workflow puede abrir una ventana Driver de cuatro panes (`driver | worker` arriba y `review | verify` abajo). El driver recibe el prompt inicial y coordina los demás panes mediante el skill; Ronin conserva la geometría, los IDs `%N` y los roles de tmux. El zoom de tmux es compartido por ventana.

### Reportes (📊)

Los reportes diario/semanal se construyen a partir de sesiones, evidencia y commits locales.

### Pruebas (⚗ test harness)
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
  ```

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


## Arquitectura

```
server/   Express + TypeScript  → API local, sesiones tmux, workflows y servicios locales
web/      Vite + React + TS     → interfaz de sesiones, workflows, Skills y pruebas
```

**Server (`server/src/`):** `index.ts`, `engine.ts` (adopción), `tmux.ts` / `ttyd.ts`, `sessions.ts`, `session-launch.ts`, `workflow.ts`, `workflow-catalog.ts`, `workflow-insights/`, `repos.ts`, `repo-config.ts`, `repo-roots.ts`, `skills.ts`, `reports.ts`, `history.ts`, `preflight.ts` y `test-harness/`.

**Web (`web/src/`):** `App.tsx`, `screens/SessionsScreen.tsx`, `components/sessions/`, `components/PaneViewer.tsx`, `components/pane-terminal.ts` y las pantallas de workflows, Skills y pruebas.

## Correr

```bash
npm install
npm run dev        # server (:8787) + web (:5180)
```

Abre **http://localhost:5180**. Requiere Node, `tmux` y `claude` en el PATH. `brew install ttyd` habilita la terminal interactiva embebida; sin ttyd, Ronin usa el visor de sólo lectura por pane.

### Desktop Electron

```bash
npm run dev:electron  # Vite + Electron; espera Vite hasta 30 s antes de navegar
npm run test:electron # build web/server/desktop y smoke de producción local
npm run package:desktop:dir # paquete sin instalador, útil para validar recursos/nativos
npm run package:desktop # DMG/ZIP en macOS; NSIS/portable en Windows; AppImage/deb en Linux
```

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
