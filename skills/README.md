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
El corazón operativo de Ronin. Un Claude **driver** orquesta a un Claude **worker** en un
pane tmux hermano: el worker escribe un plan, se revisa adversarialmente (codex o
subagentes en paralelo), el driver relaya hallazgos, el worker implementa (TDD), se revisa
el diff, y cierra con verificación. Es exactamente el loop que dispara el botón **▷ Lanzar**
del tablero.

- `SKILL.md` — flujo principal (pane discovery, sentinels, gates de revisión, self-throttle de límites).
- `worker_prompt_template.md` — el prompt de protocolo que recibe el worker.
- `watch.sh` — watcher de transiciones idle/sentinel del pane (Monitor).
- `references/` — install/setup, pane-discovery, session-handling, troubleshooting.

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
