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
  redescubren las sesiones `cowork-*` vivas y se reconstruyen los workers (etapas + evidencia).
- **Monitor de etapas**: cada worker deja archivos centinela por etapa en su cycle dir; el poller los
  mapea al stepper. Aviso del navegador + resalte cuando un worker queda idle esperando input.

### Configuración desde la App (⚙)
- **🔌 Conectores** — token/URL/proyecto de ClickUp, Jira y GitLab, con **probar conexión**; tokens
  **enmascarados** y validación de `baseUrl` (anti-exfiltración). Aplica en runtime.
- **📁 Repos** — mapa `repo → carpeta` donde arranca cada worker.
- **⚙ Workflows** — editor de las etapas del loop (icono/label/instrucción, `verifyAfter`), global y
  **por repo** (override completo que hereda el default), + **variables por repo** (inyectadas en
  `curl.env`) y **comando de inicio** por repo.
- **✍️ Prompts** — edita las 6 plantillas de prompt que reciben los workers (ad-hoc, ad-hoc complejo,
  lanzar flujo, investigar, PR, verificador), con placeholders y restaurar-default.
- **Tema claro/oscuro** (default claro, estilo LKMX) con toggle persistido.

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
`clickup-chat.ts` / `classify.ts` (DMs), `stages.ts` / `history.ts` / `today.ts` / `order.ts` (estado).

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
| `COWORK_CLICKUP_TOKEN` / `COWORK_JIRA_*` / `COWORK_GITLAB_*` | — | credenciales de conectores |

## Estado

Uso interno de LKMX. Requiere una suscripción de Claude Code activa (los workers corren `claude`).

---

<p align="center"><sub>🤖 Orquestado con Claude Code + el skill <code>/tmux-worker-loop</code>.</sub></p>
