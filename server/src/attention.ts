import { claudeAlive, isBusy } from "./tmux.js";
import type { AttentionLevel, SessionAttention } from "./types.js";

export interface Decision {
  question: string;
  options: string[];
}

const RECENT_LINES = 25;
const NUMBERED_CURSOR = /^\s*❯\s*\d+\.\s+(\S.*)$/;
const NUMBERED_OPTION = /^\s*(?:❯\s*)?\d+\.\s+(\S.*)$/;
const GENERIC_CONFIRM = /(?:\[y\/n\]|\(y\/n\)|\(y\/N\)|¿continuar\?)/i;

/**
 * tmux puede capturar el borde de una caja TUI junto al texto útil. Sólo cortamos una caja vecina
 * tras dos o más espacios: un carácter de caja suelto podría formar parte de una opción legítima,
 * mientras que esa separación es la columna que deja la TUI entre el menú y su caja contigua.
 */
function cleanDecisionText(text: string): string {
  const withoutNeighborBox = text.replace(/^(.+?\S)\s{2,}[\u2500-\u257f].*$/u, "$1");
  return withoutNeighborBox
    .trim()
    .replace(/^[\u2500-\u257f]+\s*/u, "")
    .replace(/\s*[\u2500-\u257f]+$/u, "")
    .trim();
}

/**
 * Detecta sólo menús que pueden parar al operador. El cursor por sí mismo NO basta: Claude usa
 * `❯ ` en su caja de texto y llamarlo decisión convertiría cualquier prompt a medio escribir en
 * una alerta. El picker /model sin numerar queda fuera a propósito por la misma razón.
 */
export function detectDecision(pane: string): Decision | null {
  const capturedLines = (pane ?? "").split("\n");
  // El diálogo real de Claude Code vive pegado a la caja de input, abajo. Si el pane tiene más
  // filas que contenido, tmux devuelve su pantalla completa y deja una cola vacía: se descarta
  // antes de aplicar la ventana reciente para no perder el diálogo que quedó arriba.
  while (capturedLines.length && !capturedLines.at(-1)?.trim()) capturedLines.pop();
  const lines = capturedLines.slice(-RECENT_LINES);
  const cursor = lines.findIndex((line) => NUMBERED_CURSOR.test(line));
  const generic = lines.findIndex((line) => GENERIC_CONFIRM.test(line));
  if (cursor < 0 && generic < 0) return null;

  const pivot = cursor >= 0 ? cursor : generic;
  const questionIndex = generic >= 0
    ? generic
    : lines.findLastIndex((line, index) => index < pivot && /(?:\?|¿.*\?)\s*$/.test(line.trim()));
  const questionLine = questionIndex >= 0 ? lines[questionIndex] : undefined;
  // `capture-pane -J` une las filas que tmux envolvió. No reensamblamos capturas antiguas sin
  // esa opción: si una continuación sigue inmediatamente a una fila de caja, anunciarla sola
  // produciría una pregunta truncada; es preferible no anunciar decisión alguna.
  if (questionIndex > 0 && lines[questionIndex - 1]?.includes("│") && !lines[questionIndex - 1]?.trim().endsWith("?")) return null;
  const question = questionLine && cleanDecisionText(questionLine);
  if (!question) return null;
  const options = cursor < 0 ? [] : lines.slice(cursor)
    .map((line) => line.match(NUMBERED_OPTION)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(cleanDecisionText);
  return { question, options };
}

export function paneAttention(pane: string | null): Pick<SessionAttention, "level" | "question"> {
  if (pane === null) return { level: "gone" };
  const decision = detectDecision(pane);
  if (decision) return { level: "decision", question: decision.question };
  if (isBusy(pane)) return { level: "working" };
  if (claudeAlive(pane)) return { level: "idle" };
  return { level: "shell" };
}

const PRIORITY: Record<AttentionLevel, number> = { decision: 4, working: 3, idle: 2, shell: 1, gone: 0 };

/** Rollup estable: a igualdad de nivel conserva el primer pane del inventario de tmux. */
export function rollupAttention(panes: Map<string, string | null>): SessionAttention {
  let winner: SessionAttention = { level: "gone" };
  for (const [paneId, pane] of panes) {
    const next = paneAttention(pane);
    if (PRIORITY[next.level] > PRIORITY[winner.level]) winner = { ...next, paneId };
  }
  return winner;
}
