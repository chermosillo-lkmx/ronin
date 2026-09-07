/** Motor visible en el contenido capturado de un pane tmux. */
export interface PaneEngine {
  tool: "claude" | "codex" | "agy";
  model?: string;
}

/** Detects known TUIs only from their captured pane contents, never pane_current_command. */
/**
 * La línea de modelo de Claude arrastra el proveedor tras un " · " ("Opus 5 … · Claude API").
 * En la lista de panes esa cola sólo roba ancho a lo que de verdad identifica la sesión.
 */
function trimProvider(model: string): string {
  return model.split(" · ")[0]!.trim();
}

export function detectPaneEngine(pane: string): PaneEngine | null {
  const lines = pane.split("\n");
  const claudeIndex = lines.findIndex((line) => line.includes("Claude Code"));
  if (claudeIndex !== -1) {
    const model = nextModel(lines, claudeIndex, /^(?:Opus|Sonnet|Haiku)\b/i);
    return model ? { tool: "claude", model: trimProvider(model) } : { tool: "claude" };
  }
  const codexIndex = lines.findIndex((line) => line.includes("OpenAI Codex"));
  if (codexIndex !== -1) {
    const model = codexModel(lines.slice(codexIndex + 1));
    return model ? { tool: "codex", model } : { tool: "codex" };
  }
  const agyIndex = lines.findIndex((line) => line.includes("Antigravity CLI"));
  if (agyIndex !== -1) {
    const model = nextModel(lines, agyIndex, /^Gemini\b/i);
    return model ? { tool: "agy", model } : { tool: "agy" };
  }
  // Sin banner: el pane lleva rato trabajando y su cabecera ya salió del scroll. `capture-pane`
  // sólo devuelve lo VISIBLE, así que la segunda señal es el pie, que sí permanece.
  // Medido en vivo sobre sesiones reales: ningún pane en marcha se detectaba sólo por el banner.
  if (lines.some((line) => CLAUDE_FOOTER.test(line))) return { tool: "claude" };

  const codexFooter = lines.map((line) => line.match(CODEX_FOOTER)).find(Boolean);
  // El pie de codex empieza por el modelo: "gpt-5.6-terra high · <ruta> · Context 73% left".
  if (codexFooter) return { tool: "codex", model: codexFooter[1]!.trim() };

  return null;
}

/** `⏵⏵ bypass permissions on (shift+tab to cycle)` / `⏵⏵ auto mode on (…)` — el pie de Claude Code. */
const CLAUDE_FOOTER = /⏵⏵\s+\S.*\(shift\+tab to cycle\)/;
/** El pie de Codex: modelo, ruta y el medidor de contexto separados por " · ". */
const CODEX_FOOTER = /^\s*(\S[^·]*?)\s+·\s+\S+\s+·\s+Context\s+\d+%\s+left/;

function nextModel(lines: string[], markerIndex: number, knownModel: RegExp): string | undefined {
  for (const line of lines.slice(markerIndex + 1)) {
    const candidate = stripPaneChrome(line);
    if (!candidate) continue;
    return knownModel.test(candidate) ? candidate : undefined;
  }
  return undefined;
}

function codexModel(lines: string[]): string | undefined {
  for (const line of lines) {
    const candidate = stripPaneChrome(line);
    const configured = candidate.match(/^model:\s*(.+?)(?:\s+\/model\b|$)/i)?.[1]?.trim();
    if (configured?.startsWith("gpt-")) return configured;
    const status = candidate.match(/^(gpt-[^·]+?)\s+·\s+\//)?.[1]?.trim();
    if (status) return status;
  }
  return undefined;
}

function stripPaneChrome(line: string): string {
  return line.trim().replace(/^[│╭─▀▄\s]+|[│╭─▀▄\s]+$/g, "").trim();
}
