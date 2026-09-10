# Skills

Skills de Claude Code que **Ronin** usa para orquestar su flujo de trabajo. Copia las
vendorizadas a `~/.claude/skills/` (o simlinkéalas) para tenerlas disponibles en tus
sesiones de Claude Code.

```bash
# instalar las skills vendorizadas
cp -R skills/tmux-worker-loop skills/liebre-commit-workflow ~/.claude/skills/
```

## Vendorizadas (en este folder)

### `tmux-worker-loop`
El corazón operativo de Ronin. **Cuatro roles en cuatro panes**, cada uno con su propio contexto
y su propio modelo: **Main** orquesta, **Brain** (opus) escribe el plan, **Reviewer** (opus o codex)
ataca plan y diff, **Implementer** (sonnet) ejecuta en ciclos RED→GREEN→REFACTOR. El plan lo revisa
quien no lo escribió, y los refactors los audita quien no los hizo — un implementador no puede ver
cuándo su propia "limpieza" cambió comportamiento.

Es el loop que dispara el botón **▷ Lanzar** del tablero, en sus dos modos: **rápido** (el driver es
`engine.ts`, que hace poll de sentinels y manda `send-keys`) y **Driver** (el driver es un Claude
real en la ventana de 4 panes que Ronin crea de antemano y le entrega por `pane_id`).

En modo Driver los slots de Ronin **no** coinciden con los roles del skill — el mapeo vive en
`references/provisioned-panes.md` y se materializa en `<CYCLE_DIR>/panes.env`:

| slot Ronin | rol | modelo |
|---|---|---|
| driver | Main | del operador |
| verify | Brain | opus |
| review | Reviewer | opus / codex |
| worker | Implementer | sonnet |

- `SKILL.md` — flujo principal (layout, sentinels, RGR, gates de revisión, self-throttle).
- `brain_prompt_template.md` · `reviewer_prompt_template.md` · `implementer_prompt_template.md` — un prompt por rol.
- `relay.sh` — mensajería entre panes: resuelve rol→`%id`, no pega en un pane ocupado, registra `relay.log`.
- `watch-multi.sh` — watcher único para los 3 panes worker (sentinels + idle + alertas de límite).
- `references/` — install/setup, pane-discovery, **provisioned-panes** (modo Driver), session-handling, troubleshooting.
- **Archivos instalables de `harness/`:**
  - `rgr.sh` — ejecutable que corre las fases, ancla su evidencia y es el único escritor de `rgr.log`.
  - `verify-rgr.sh` — ejecutable que valida los ciclos y produce el gate mecánico de Main.
  - `probe-repo.sh` — ejecutable que detecta el stack y escribe el contrato de cada slot.
  - `fitness.sh` — ejecutable que aplica las reglas estructurales específicas del repositorio.
  - `gate-layout.sh` — ejecutable que exige cuatro panes y cuatro identificadores únicos.
  - `rgr-log.sh` — biblioteca sourceada, no un comando; es la única dueña del constructor y parser del log.
  - `fixture-runner.mjs` — infraestructura de test sin aserciones; limpia el entorno y lanza procesos fixture.
  - `harness.test.mjs` — suite que prueba los scripts y los contratos markdown operativos.
- **Artefactos efímeros de cada ciclo:** no se instalan ni viven en el repo; nacen bajo `CYCLE_DIR` y se eliminan con el ciclo.
  - `harness.<slot>.env` — contrato ejecutable detectado para un worktree declarado.
  - `worktrees.env` — mapa de slots a rutas físicas de worktree.
  - `.rgr-index` — índice temporal usado para construir snapshots sin tocar el índice del usuario.
  - `harness.provenance` — identidad y hash de la copia del harness realmente ejecutada.
- `watch.sh`, `worker_prompt_template.md` — **legacy** del modo single-worker; se conservan para leer cycle dirs viejos.

La tesis del harness es breve: **nada en `rgr.log` se cree**. Cada campo de evidencia es un SHA que
existe en la base de objetos Git o un escalar que `verify-rgr.sh` vuelve a derivar de uno de esos
SHA. El reporte del gate hace explícito el límite de esa afirmación: enumera `covered=`,
`not-covered=`, las fronteras históricas de evidencia y todas las excepciones/deudas declaradas por
Main. Un `RESULT: PASS` certifica sólo `covered=`; el Reviewer verifica por su cuenta cada dimensión
`not-covered=` y trata fronteras, avisos y excepciones como entradas de revisión, no como hechos
perdonados en silencio.

### `liebre-commit-workflow`
Guía los commits/push/PRs: Conventional Commits, el bump de versión de AgileFlow al pushear a
`main`, la estructura multi-repo de Liebre y el branch target por servicio. Es la convención que
siguen los workers cuando el ticket termina en un commit.

## Externas (plugins — instalar por separado)

### Review — gates adversariales
El loop de `tmux-worker-loop` cierra cada fase (plan / diff) con una **revisión adversarial**. Se
apoya en dos plugins de terceros (no se vendorizan; instálalos con el plugin manager de Claude Code):

- **`codex:codex-rescue`** ([openai-codex](https://github.com/openai/codex)) — segundo par de ojos
  que busca huecos de spec, contradicciones y bugs en el plan y en el diff. Es el gate por defecto
  del loop; cuando codex no está disponible se sustituye por subagentes Claude en paralelo.
- **`code-review`** (plugin oficial, el comando `/code-review` / *ultrareview*) — revisión de PRs con
  varios agentes en paralelo y scoring por confianza para filtrar falsos positivos.

### Diseño

Ronin se diseñó/construyó con el plugin oficial **[superpowers](https://github.com/anthropics/claude-code)**
(`brainstorming` → `writing-plans` → ejecución). No se vendorizan aquí (son de terceros y se
actualizan por su cuenta); instálalos con el plugin manager de Claude Code:

- **`superpowers:brainstorming`** — convierte una idea en un spec aprobado antes de codear.
- **`superpowers:writing-plans`** — convierte el spec en un plan de implementación por tareas.

Los specs y planes generados viven en [`../docs/superpowers/`](../docs/superpowers/).
