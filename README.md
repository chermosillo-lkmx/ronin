<p align="center">
  <img src="web/public/lkmx/lkmx-mark.svg" width="56" alt="LKMX" />
</p>

<h1 align="center">Ronin</h1>

<p align="center">
  Dashboard local que orquesta <b>workers Claude</b> en paneles tmux para atacar tu backlog de
  ClickUp / Jira / GitLab — lanzar, investigar y revisar tickets desde una sola vista.
  <br/><i>Por LKMX.</i>
</p>

---

## Qué es

**Ronin** es un tablero web local (React + Vite) con un backend Express (TypeScript) que:

- Reúne tus tareas de **ClickUp**, **Jira** y **GitLab** en un tablero unificado.
- **Lanza workers Claude** en sesiones **tmux** reales (`claude` corriendo en tu repo) para
  implementar, investigar o revisar cada ticket, orquestados por el skill `/tmux-worker-loop`.
  Dos modos: **rápido** (el driver del loop es el propio server, que hace poll de sentinels) y
  **Driver** (un Claude driver **real** orquesta worker/review/verify en una ventana de 4 panes).
- Sigue el ciclo del worker en vivo (stepper de etapas + terminal embebida) y recoge **evidencia**
  (resumen, curl, screenshots) lista para pegar en el ticket.
- Genera **reportes de resumen** diario/semanal de lo trabajado (síntesis + detalle por tarea),
  construidos con `claude -p` a partir de los commits reales, el disparador y la evidencia del worker.
- Es totalmente **configurable desde la App**: conectores, repos, workflows por repo y las plantillas
  de prompt que reciben los workers.

Todo corre en tu máquina; no hay servidor remoto. Los secretos viven en archivos locales gitignored.

## Características

### Tablero de tareas
- Fuentes **ClickUp / Jira / GitLab** fusionadas, con badge de origen (`CU` / `JIRA` / `GL`) por tarjeta.
- Pestañas **ClickUp · Jira · GitLab · ⚑ Prioridad · 📅 Hoy** con conteo. Prioridad ordena todo por
  urgencia (P1→P4); Hoy muestra lo trabajado + pendientes del día y un plan fijable (★).
- Búsqueda, orden manual (▲▼) dentro de una prioridad, refresh manual + auto (cada 5 min).
- **Modos**: `simulado` (seguro, anima el loop con datos seed/mock) y `live` (tmux + `claude` reales).

### Acciones sobre una tarea
- **▷ Lanzar** — abre un worker que orquesta el loop completo (plan → codex → impl → codex → KB →
  tests) sobre el ticket, con toggles de etapas para esa corrida. El modal ofrece
  `○ Lanzar (rápido)` / `● Lanzar (Driver)`; en Driver se elige la **herramienta de review**
  (Codex / Agent) y se avisa que consume tokens durante todo el ciclo, no sólo los del worker.
- **🔍 Investigar** — worker **read-only** que analiza el ticket y deja un **plan de implementación
  propuesto** (`research.md`) sin tocar código.
- **✦ Ad-hoc / ✎ Petición / ⎇ PR** — texto libre (DM/mención), petición personal con workflow
  confirmable, o revisión de un PR.
- **Preview** — click en cualquier tarjeta abre un modal con la **descripción completa** (ClickUp /
  Jira ADF / GitLab) + botones Lanzar e Investigar.

### Ejecución en vivo
- Panel **▸ EN EJECUCIÓN**: las tareas con worker activo, con su etapa actual; para ad-hoc/custom
  muestra el mensaje que disparó la ejecución.
- **Ventana flotante de detalle** (2 panes): izquierda = fuente/repo/prioridad/descripción + stepper
  del loop + evidencia; derecha = **terminal en vivo** (`capture-pane`, polling), responder al worker
  (`tmux send-keys`) y terminal interactiva embebida (ttyd, opcional).
- **Persistencia de terminales**: las sesiones tmux son la fuente de verdad; al reiniciar el server se
  redescubren las sesiones `cowork-*` vivas y se reconstruyen los workers (etapas + evidencia + el
  **worktree** de cada uno).
- **Aislamiento por worktree (live)**: cada worker de tarea corre en un **git worktree efímero**
  (rama `cowork/<session>` bajo `~/.cowork/worktrees/…`), así dos workers sobre el mismo repo no
  colisionan. Se limpia al completar/parar, pero **nunca** se borra un worktree con cambios sin
  commitear o commits propios (se conserva y se registra). Si el repo no es git o falla la creación,
  cae a la raíz del repo con una nota visible. El path es determinístico por sesión → se reconstruye
  al reiniciar. `research` (read-only) y el modo simulado no tocan git.
- **Monitor de etapas**: cada worker deja archivos centinela por etapa en su cycle dir; el poller los
  mapea al stepper. Aviso del navegador + resalte cuando un worker queda idle esperando input.
- **Presión de contexto**: el poller detecta en el pane del worker señales de contexto alto /
  auto-compact (aviso de `/clear`, "Compacting conversation", % de contexto bajo) y las expone como
  un badge no intrusivo (🧠 contexto) en el panel ▸ EN EJECUCIÓN y en la ventana de detalle, para que
  decidas hacer `/clear` o compactar antes de que el worker se degrade. Es informativo (no dispara
  `/clear` solo).

### Modo Driver (4 panes) y vista ⌘ Sessions

En modo Driver el dashboard **no** orquesta el loop: crea la geometría y deja que un **Claude driver
real** haga de driver, igual que un humano manejando el skill a mano. Es el mismo principio que ya
rige el resto de Ronin — *el dashboard no reimplementa la lógica de los skills: lanza un Claude real
y le inyecta un prompt que invoca el skill correcto, y luego observa archivos sentinel*.

- **Una sesión tmux con UNA ventana de 4 panes**: `driver | worker` arriba, `review | verify` abajo,
  con `mouse on` (click para enfocar, arrastrar bordes para redimensionar, rueda para scrollear).
  Sólo el pane driver recibe prompt; los otros tres los arranca el driver cuando los necesita.
- **Un solo ttyd** por sesión renderiza los 4 panes (`tmux attach`), así que **`ttyd` deja de ser
  opcional** en este modo. Stop mata la sesión entera → los 4 panes de una.
- Los targets son **pane ids `%N`**, no índices: tmux renumera los índices cuando un pane muere, y
  el driver acabaría relayeando al pane equivocado sin ningún error visible.
- El engine se aparta explícitamente: en modo Driver **no** hace el switch de modelo plan→impl
  (mandaría `/model` al pane *activo*), **no** lanza el verificador en sesión aparte (el verify es un
  pane), **no** corre los gates `verifyCmd`, y **no** recicla el worktree al llegar a `done` (los 4
  panes siguen vivos dentro de él).
- **Persistencia**: `reviewTool` vive en la opción de sesión de tmux `@cowork-review-tool` (camino
  primario al redescubrir) con una copia en el cycle dir como artefacto de auditoría; los roles de
  cada pane viven en `@cowork-role` y se **re-consultan a tmux** al reiniciar, porque tmux es la
  fuente de verdad. El modo se reconoce por el sufijo `-driver` del nombre de sesión.
- **Foco en un pane**: los 4 panes se listan con su estado y se puede ver **uno solo** a tamaño
  legible (ver ⌘ Sessions, abajo). El estado por pane se deriva **en el server** reusando las mismas
  heurísticas del pane (`paneStatus` sobre `isBusy`/`claudeAlive`): el dashboard no reimplementa la
  lógica, sólo pinta lo que el server calculó. Un pane sin claude es `○ sin arrancar`, **no**
  "caído": review y verify nacen como shells y el driver los arranca cuando los necesita.
  Zoomear con `resize-pane -Z` **no** es crear/matar panes ni `select-layout` (lo que
  `provisioned-panes.md` prohíbe **al agente driver**, no al dashboard: el layout 2×2 es de Ronin);
  es reversible y restaura el 2×2 exacto.

**Salud del driver.** Tres estados que el tablero distingue, porque piden acciones opuestas:

| Badge | Qué pasó | Qué hacer |
|---|---|---|
| `✖ driver caído` | el `claude` del pane driver murió; los otros panes **siguen vivos** | entrar a la terminal a rescatar el trabajo, o parar el worker |
| `⏸ parqueado` | el worker se auto-parqueó por límite de uso (`===WORKER-PARKED-LIMIT===`) | esperar al reset y mandarle `RESUME` |
| `⏳ sin avance` | ni etapa nueva ni actividad en 15 min (señal blanda) | quizá el driver olvidó un `touch`: la etapa mostrada puede estar rancia |

**Entrega del prompt inicial (aplica a los dos modos).** Todo prompt inicial —rápido, Driver,
Investigar, acciones y verificador— se entrega con `tmux load-buffer` + `paste-buffer -p -d` + una
pausa antes del `Enter` (el mecanismo que documenta el propio skill), y después se **verifica** que
salió, reintentando el `Enter` de forma acotada.

Con el `send-keys -l` + `Enter` inmediato que se usaba antes, el `Enter` llega mientras la caja de
input de Claude Code todavía está componiendo los trozos pegados y **se lo traga**: el prompt queda
escrito pero sin enviar, indefinidamente, y el fallo es **silencioso** (el worker simplemente nunca
arranca). Depende del tamaño, no del modo: medido, falla de forma reproducible a ~13KB. Un ticket
con descripción larga produce un prompt del modo rápido igual de grande, por eso el arreglo cubre
ambos caminos. Verificado en vivo con las tres formas reales: 444 B, 2.2 KB y 13 KB.

`sendText` (slash commands como `/model`, el `Enter` de los diálogos de arranque y las respuestas
cortas al worker) **no** cambia: un slash command entregado por bracketed paste podría no abrir el
menú de comandos.

Los tres se **derivan en cada poll** (no se persisten: son un cálculo barato y guardarlos sólo
arriesgaría mostrarlos rancios). El de parqueo se lee de **`sentinels.log`**, no del pane: es el
mismo motivo por el que el skill creó ese archivo — un sentinel largo se parte al envolverse en un
pane angosto, y el layout 2×2 son justamente panes angostos. "Driver caído" se detecta por *ausencia*
de la TUI de claude en el pane driver, con un latch de arranque (no se puede morir algo que nunca se
vio arrancar) e histéresis de 3 polls, para no confundir un repintado con una caída. La comprobación
es **posicional**: claude mantiene su caja de input clavada como lo último de la pantalla, así que si
hay contenido *debajo* del último chrome (un prompt de shell), claude ya no maneja el pane — mirar si
el chrome aparece "en algún lado" daba vivo para siempre, porque un proceso que muere deja su último
frame pintado.

**Limitaciones conocidas.** Dos ciclos Driver sobre el **mismo repo** a la vez pueden chocar a nivel
git (comparten `.git`: `index.lock`); el modo rápido tiene idéntica exposición, así que la regla es
no lanzar dos ciclos sobre un mismo repo. Y si muere tmux por completo (reinicio, `kill-server`), un
ciclo Driver **se relanza desde cero, no se reanuda**: los sentinels sobreviven, pero la conversación
del driver no es reconstruible. Ojo con lo segundo: tras un `kill-server` los `pane_id` **se
reinician en `%0`**, así que un `%N` viejo puede apuntar a otro pane — por eso los roles se
re-consultan a tmux al redescubrir en vez de confiar en lo guardado.

**Zoom compartido.** Como se explica en ⌘ Sessions, el zoom de tmux es de la **ventana**: no existe
zoom por cliente. Si dos personas (o dos pestañas) miran la misma sesión, el zoom de una lo ven
todas. Está avisado en la UI y mitigado con la vista de texto por defecto, pero no tiene arreglo del
lado de tmux.

**CSRF desde localhost (cerrado).** El server hace bind a `127.0.0.1` y además restringe
`cors()` a orígenes loopback (`security.ts`), con un `requireLocalOrigin` montado sobre
**todo** `/api` y antes de `express.json()`. Una pestaña maliciosa en el navegador del
operador ya no puede llegar a `/api/workers/:id/input` (que teclea en un claude con
bypass-permissions) ni a `/api/repo-config/:repo` (que persiste un `verifyCmd` que después
corre como shell). Ojo con la asimetría: el que bloquea es el **middleware** — `cors()` con un
origen rechazado no corta la petición, sólo impide que el atacante lea la respuesta. Una
petición sin `Origin` (curl, `<img>`, EventSource same-origin) sigue pasando, así que
`POST /api/webhook/dm` **sigue abierto a propósito** para el forwarder de DMs: eso no lo cierra
este guard. Y un `Origin: null` recibe 403: es el `Origin` de un iframe `sandbox`, o sea de
contenido que un atacante controla, y aceptarlo haría el guard evadible con tres atributos de
HTML. **Eso fija una restricción de diseño para F6:** el renderer de Electron se sirve con un
esquema propio (`app://`, vía `protocol.handle()`) — lo que además pide un CSP estricto — y ese
esquema se añade al allowlist. Desde `file://` **todas** sus peticiones, GET incluidos, irían
con `Origin: null` y se rechazarían.

### ⌘ Sessions

> Convive con **⌘+ Sesiones** (F1), que lista **todas** las sesiones tmux —también las ajenas a
> Ronin— en sólo lectura. Esta vista (⌘) sigue siendo la de los tickets en modo Driver y se
> retira en F2, cuando la nueva absorba el stepper y la terminal.

Pestaña de nivel superior junto a 📊 Reportes. Sidebar con los tickets en modo Driver (badge de
fuente + título + etapa + estado de salud). El header lleva el link del ticket, el badge de
`reviewTool`, un botón de stop y un fallback **▷ Lanzar (rápido)** (que para el driver y relanza en
modo scripteado, porque un ticket no puede tener dos workers a la vez).

**Tira de panes.** Bajo el header, los 4 panes de la sesión (`driver`/`worker`/`review`/`verify`)
con su estado y su última línea significativa:

| Badge | Significa |
|---|---|
| `● trabajando` | claude está en un turno (footer de interrupción) |
| `◐ idle` | la TUI de claude está, esperando |
| `○ sin arrancar` | shell desnudo — **normal** en review/verify hasta que el driver los arranca |
| `✖ no disponible` | el `capture-pane` falló: ese pane ya no existe |

**Dos vistas del área principal**, y la diferencia importa:

- **Sin pane seleccionado** — el `<iframe>` de ttyd con los **4 panes reales**: es la vista
  **interactiva** (mouse on: click para enfocar, teclear va al pane clickeado).
- **Con un pane seleccionado** — sólo ese pane, como **texto de sólo lectura** polleado
  (`capture-pane` sobre su `%N`), a un tamaño de letra que pone el CSS del dashboard. Ésta es la
  respuesta real a "el texto se ve chiquito": el `fontSize` de ttyd se fija al arrancar el proceso
  y el navegador no puede cambiarlo desde el iframe. No se escribe desde aquí; para interactuar
  están los dos botones de escalada. `↩ ver los 4 panes` vuelve.

**Escalada a interactivo** (desde la tira, sobre el pane seleccionado):

- `⤢ zoom en el iframe` — `tmux resize-pane -Z` sobre ese `%N`: el pane ocupa la ventana entera y
  el iframe existente se repinta solo (es el mismo cliente tmux; no se crea un segundo ttyd).
- `🖥 abrir Terminal (este pane)` — zoomea y **después** abre Terminal.app. Si el zoom no se pudo
  confirmar, **no abre nada**: una terminal que muestra los 4 panes comprimidos cuando pediste uno
  parecería que funcionó.

⚠️ **El zoom es estado de la VENTANA tmux, no del cliente.** tmux no tiene forma de que un cliente
vea un solo pane sin afectar a los demás: al zoomear, lo ven **todos** los clientes attachados
(otras pestañas, el iframe de la ventana de detalle y cualquier Terminal.app). Por eso la vista por
defecto al seleccionar un pane es el **texto polleado**, que no toca la sesión de nadie, y el zoom
es una acción explícita con aviso en pantalla. Volver a los 4 panes **no** manda ningún comando si
no había zoom que deshacer, para no moverle el pane activo a quien esté mirando lo mismo.

Los workers Driver **siguen siendo tarjetas normales del Board**: Sessions es una vista filtrada
sobre los mismos registros, no una fuente de datos paralela.

### Configuración desde la App (⚙)
- **🔌 Conectores** — token/URL/proyecto de ClickUp, Jira y GitLab, con **probar conexión**; tokens
  **enmascarados** y validación de `baseUrl` (anti-exfiltración). Aplica en runtime.
- **📁 Repos** — mapa `repo → carpeta` donde arranca cada worker.
- **⚙ Workflows** — editor de las etapas del loop (icono/label/instrucción, `verifyAfter`), global y
  **por repo** (override completo que hereda el default), + **variables por repo** (inyectadas en
  `curl.env`), **comando de inicio** y **modelos Planner/Worker** por repo. El pane arranca en el
  **Planner** (`opus`) y cambia al **Worker** (`sonnet`) en la frontera plan→impl; también hay
  override por lanzamiento en el modal de Lanzar. Nota: en el Claude actual, `/model <worker>` setea
  directo y **también repunta el default global** del operador ("saved as your default for new
  sessions"); es inocuo para Ronin porque cada worker arranca con `--model <planner>` explícito, pero
  tenlo presente. El engine verifica el cambio por la línea de confirmación (`Set model to <worker>`),
  no por un banner persistente.
  - **`verifyCmd` / `maxRetries` por etapa** (gate cuantitativo): una etapa puede declarar un comando
    shell (exit 0 = pass) que corre en el `cwd` del worker al completarla; si falla, se reintenta hasta
    `maxRetries` (default 2) y, agotados, la etapa se marca **fallida** en el stepper sin avanzar a
    `done` (nada de falso verde). ⚠️ **Ejecuta shell arbitrario** → sólo se honra desde el override
    **por-repo** (gitignored, mismo trust boundary que `startCommand`/`vars`); en el workflow global
    (git-tracked) se ignora, y nunca se acepta de fuentes remotas (webhook/DM).
- **✍️ Prompts** — edita las 7 plantillas de prompt que reciben los workers (ad-hoc, ad-hoc complejo,
  lanzar flujo, investigar, PR, verificador, driver), con placeholders y restaurar-default.
- **Tema claro/oscuro** (default claro, estilo LKMX) con toggle persistido.

### Reportes (📊)
- Vista **📊 Reportes** que genera resúmenes **diario** / **semanal** de las tareas trabajadas en el
  periodo, on-demand o vía **scheduler opt-in** (`COWORK_REPORT_SCHEDULE=1`).
- Por tarea: una línea de **síntesis** ("lo que se hizo") + **detalle expandible**, redactados con
  `claude -p` a partir de los **commits reales** del repo, el **mensaje disparador** (`task.body`) y la
  **evidencia** del worker (summary/verdict/research/curl) que se persiste al completar cada ciclo.
- Visor de markdown con **toggle compacto/completo** y copiar; los reportes se guardan en
  `server/data/reports` (gitignored). Nombres tipo `daily-YYYY-MM-DD` / `weekly-YYYY-Www`.

### DMs (opcional)
- **Webhook** `POST /api/webhook/dm {text}` — clasifica el mensaje con `claude -p` y auto-lanza un
  worker si es una tarea. Source-agnostic (Slack / ClickUp / un forwarder).
- **Poller de DMs de ClickUp** (`COWORK_DM_POLL=1`) — sondea tus DMs y auto-lanza los que son tarea.

## Arquitectura

```
server/   Express + TS (tsx)   → estado en memoria + SSE (/api/stream) + control tmux + ClickUp/Jira/GitLab
web/      Vite + React + TS    → dashboard, consume /api/stream
```

El front usa proxy de Vite: todo `/api/*` va a `http://localhost:8787`.

**Server (`server/src/`):** `index.ts` (rutas + SSE), `engine.ts` (lanzamiento de workers —
incluido `launchDriverLive` del modo Driver— + poller tmux), `tmux.ts` / `ttyd.ts` (control de
sesiones; `createDriverWindow` arma la ventana de 4 panes), `tasks-source.ts` + `clickup.ts` / `jira.ts` /
`gitlab.ts` (fuentes), `settings.ts` (conectores runtime), `repos.ts` / `repo-config.ts` (repos +
workflows por repo), `workflow.ts` (workflow componible), `prompts.ts` (plantillas editables),
`templates.ts` (construcción de prompts), `curl-config.ts` (creds de curl por proyecto),
`clickup-chat.ts` / `classify.ts` (DMs), `reports.ts` + `report-git.ts` / `report-worker.ts` /
`report-schedule.ts` (reportes de resumen), `stages.ts` / `history.ts` / `today.ts` / `order.ts` (estado),
`security.ts` (guard de origen loopback sobre todo /api), `sessions.ts` (inventario tmux
completo: gestionadas + ajenas), `preflight.ts` (comprobaciones de entorno).

**Web (`web/src/`):** `App.tsx` (tablero + vista ⌘ Sessions + secciones de Configuración + modales), `api.ts`, `types.ts`,
`styles.css` (tokenizado por tema), `screens/` y `components/` (pantallas nuevas bajo Nocturne),
`nocturne.css` / `theme-bridge.css` / `screens.css`.

## Correr

```bash
npm install        # instala server + web (workspaces)

npm run dev        # MODO SIMULADO (seguro): server (:8787) + web (:5180)
npm run dev:live   # MODO LIVE: lanzar una tarea abre claude en tmux de verdad
```

Abre **http://localhost:5180**. Requiere Node, `tmux`, y `claude` (Claude Code) en el PATH.
`brew install ttyd` para la terminal interactiva embebida (opcional en modo rápido, **necesario**
para el modo Driver, que se ve entero por el iframe).

La pestaña **⚙✓ Preflight** comprueba desde la app que `tmux`, `claude`, `codex` y `ttyd` estén
en el PATH que heredó el server, y muestra qué falta y cómo instalarlo.

### Configuración

Sin credenciales, el tablero usa snapshots seed reales (`server/data/*-seed.json`). Configura los
conectores desde **⚙ → Conectores** (o por env vars `COWORK_*`). Archivos locales **gitignored** con
secretos: `.env`, `settings.json`, `curl-env.json`, `repo-config.json`.

| Variable | Default | Qué hace |
|----------|---------|----------|
| `COWORK_MODE` | `simulated` | `live` activa tmux real |
| `COWORK_LIEBRE_ROOT` | `.../code/lkmx/liebre` | raíz de los repos |
| `COWORK_CLAUDE_CMD` | `claude --permission-mode bypassPermissions` | comando del worker |
| `COWORK_PLANNER_MODEL` | `opus` | modelo con el que **arranca** el pane (Planner/advisor; `--model`) |
| `COWORK_WORKER_MODEL` | `sonnet` | modelo al que se cambia en la fase de impl (Worker; `/model` tras "PLAN APPROVED") |
| `COWORK_WORKTREE_HOME` | `~/.cowork/worktrees` | base de los git worktrees efímeros por worker (P1) |
| `COWORK_CLICKUP_TOKEN` / `COWORK_JIRA_*` / `COWORK_GITLAB_*` | — | credenciales de conectores |
| `COWORK_REPORT_SCHEDULE` | `0` | `1` activa el scheduler de reportes diario/semanal |
| `COWORK_REPORT_DAILY_AT` / `COWORK_REPORT_WEEKLY_DAY` | `19:00` / `5` | hora del diario y día del semanal (0=Dom…6=Sáb) |

## Skills

**Principio rector:** el dashboard **no reimplementa** la lógica de los skills — lanza un Claude real
en tmux, le inyecta un prompt que invoca el skill correcto y luego observa archivos sentinel para
saber en qué etapa va. El modo Driver es ese principio llevado al límite: el server sólo aporta la
geometría de los panes, el ttyd y el prompt inicial; el relay y los gates viven en el skill.

El flujo de Ronin se orquesta con skills de Claude Code vendorizadas en [`skills/`](skills/):
**`tmux-worker-loop`** (el loop driver↔worker detrás de ▷ Lanzar, con su variante
**provisioned-panes** para el modo Driver: los 4 panes ya existen y se le pasan por `pane_id`) y **`liebre-commit-workflow`**
(Conventional Commits + versionado AgileFlow al cerrar un ticket). Instálalas para modo live:

```bash
cp -R skills/tmux-worker-loop skills/liebre-commit-workflow ~/.claude/skills/
```

La **revisión adversarial** de cada fase se apoya en plugins externos —
[`codex:codex-rescue`](https://github.com/openai/codex) (gate por defecto) y el `code-review`
oficial (*ultrareview*)— igual que el diseño usa [superpowers](docs/superpowers/)
(`brainstorming`, `writing-plans`). Detalles en [`skills/README.md`](skills/README.md).

## Estado

Uso interno de LKMX. Requiere una suscripción de Claude Code activa (los workers corren `claude`).

---

<p align="center"><sub>🤖 Orquestado con Claude Code + el skill <code>/tmux-worker-loop</code>.</sub></p>
