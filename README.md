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
  tests) sobre el ticket, con toggles de etapas para esa corrida.
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
- **✍️ Prompts** — edita las 6 plantillas de prompt que reciben los workers (ad-hoc, ad-hoc complejo,
  lanzar flujo, investigar, PR, verificador), con placeholders y restaurar-default.
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

**Server (`server/src/`):** `index.ts` (rutas + SSE), `engine.ts` (lanzamiento de workers + poller
tmux), `tmux.ts` / `ttyd.ts` (control de sesiones), `tasks-source.ts` + `clickup.ts` / `jira.ts` /
`gitlab.ts` (fuentes), `settings.ts` (conectores runtime), `repos.ts` / `repo-config.ts` (repos +
workflows por repo), `workflow.ts` (workflow componible), `prompts.ts` (plantillas editables),
`templates.ts` (construcción de prompts), `curl-config.ts` (creds de curl por proyecto),
`clickup-chat.ts` / `classify.ts` (DMs), `reports.ts` + `report-git.ts` / `report-worker.ts` /
`report-schedule.ts` (reportes de resumen), `stages.ts` / `history.ts` / `today.ts` / `order.ts` (estado).

**Web (`web/src/`):** `App.tsx` (tablero + secciones de Configuración + modales), `api.ts`, `types.ts`,
`styles.css` (tokenizado por tema).

## Correr

```bash
npm install        # instala server + web (workspaces)

npm run dev        # MODO SIMULADO (seguro): server (:8787) + web (:5180)
npm run dev:live   # MODO LIVE: lanzar una tarea abre claude en tmux de verdad
```

Abre **http://localhost:5180**. Requiere Node, `tmux`, y `claude` (Claude Code) en el PATH.
`brew install ttyd` para la terminal interactiva embebida (opcional).

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

El flujo de Ronin se orquesta con skills de Claude Code vendorizadas en [`skills/`](skills/):
**`tmux-worker-loop`** (el loop driver↔worker detrás de ▷ Lanzar) y **`liebre-commit-workflow`**
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
