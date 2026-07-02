# Skills

Skills de Claude Code que **Ronin** usa para orquestar su flujo de trabajo. Copia las
vendorizadas a `~/.claude/skills/` (o simlinkéalas) para tenerlas disponibles en tus
sesiones de Claude Code.

```bash
# instalar la skill vendorizada
cp -R skills/tmux-worker-loop ~/.claude/skills/
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

## Externas (plugins — instalar por separado)

Ronin se diseñó/construyó con el plugin oficial **[superpowers](https://github.com/anthropics/claude-code)**
(`brainstorming` → `writing-plans` → ejecución). No se vendorizan aquí (son de terceros y se
actualizan por su cuenta); instálalos con el plugin manager de Claude Code:

- **`superpowers:brainstorming`** — convierte una idea en un spec aprobado antes de codear.
- **`superpowers:writing-plans`** — convierte el spec en un plan de implementación por tareas.

Los specs y planes generados viven en [`../docs/superpowers/`](../docs/superpowers/).
