/** Captura medida: Claude arriba en un pane alto y 68 filas vacías que tmux conserva abajo. */
export const TALL_CLAUDE_PANE = [
  "Claude Code",
  "╭──────────────────────────────────────────────────────╮",
  "│ >                                                    │",
  "╰──────────────────────────────────────────────────────╯",
  "Resumen útil de la sesión de workflow",
  "⎿ Read 40 lines",
  "",
  "Context status: healthy",
  "Context low · Run /clear to save 45k tokens",
  "──────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents",
  ...Array<string>(68).fill(""),
].join("\n");
