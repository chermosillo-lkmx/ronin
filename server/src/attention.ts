import { claudeAlive, isBusy, recentLines } from "./tmux.js";
import type { AttentionLevel, SessionAttention } from "./types.js";

export interface Decision {
  question: string;
  options: string[];
  /** Descripción bajo cada opción (misma posición que `options`; "" si no trae). Sólo si alguna trae texto. */
  details?: string[];
}

const RECENT_LINES = 25;
const NUMBERED_CURSOR = /^\s*❯\s*\d+\.\s+(\S.*)$/;
const NUMBERED_OPTION = /^\s*(?:❯\s*)?\d+\.\s+(\S.*)$/;
const GENERIC_CONFIRM = /(?:\[y\/n\]|\(y\/n\)|\(y\/N\)|¿continuar\?)/i;
const HORIZONTAL_RULE = /^\s*[\u2500\u2501\u2504\u2505\u2508\u2509\u254c\u254d]{3,}\s*$/u;
const MENU_FOOTER = /^\s*Enter to select\b/i;
/** Un párrafo de AskUserQuestion puede empezar más arriba que la ventana donde se busca el menú. */
const PARAGRAPH_EXTRA_LINES = 20;
const MAX_PARAGRAPH_LINES = 15;

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

function isInputDraftCursor(lines: string[], cursor: number): boolean {
  for (let index = cursor - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (line.trim()) {
      // La caja de entrada de Claude está cerrada por una regla horizontal justo antes del texto.
      // Exigimos una regla inequívoca y completa: ante cualquier forma dudosa preferimos alertar,
      // porque perder una decisión real cuesta más que reportar una decisión de más.
      return HORIZONTAL_RULE.test(line);
    }
  }
  return false;
}

/**
 * Detecta sólo menús que pueden parar al operador. El cursor por sí mismo NO basta: Claude usa
 * `❯ ` en su caja de texto y llamarlo decisión convertiría cualquier prompt a medio escribir en
 * una alerta. El picker /model sin numerar queda fuera a propósito por la misma razón.
 */
export function detectDecision(pane: string): Decision | null {
  const lines = recentLines(pane, RECENT_LINES);
  const cursor = lines.findIndex((line, index) => NUMBERED_CURSOR.test(line) && !isInputDraftCursor(lines, index));
  const generic = lines.findIndex((line) => GENERIC_CONFIRM.test(line));
  if (cursor < 0 && generic < 0) return null;

  const pivot = cursor >= 0 ? cursor : generic;
  let questionIndex = generic >= 0 ? generic : -1;
  for (let index = pivot - 1; questionIndex < 0 && index >= 0; index -= 1) {
    const line = lines[index]!;
    if (/(?:\?|¿.*\?)\s*$/.test(line.trim())) questionIndex = index;
  }
  if (questionIndex < 0) return null;
  const question = cursor >= 0 && questionIndex !== generic
    ? questionParagraph(pane, lines.length, questionIndex)
    : cleanDecisionText(lines[questionIndex]!);
  if (!question) return null;
  if (cursor < 0) return { question, options: [] };
  const options: string[] = [];
  const details: string[] = [];
  for (const line of lines.slice(cursor)) {
    const option = line.match(NUMBERED_OPTION)?.[1];
    if (option) {
      options.push(cleanDecisionText(option));
      details.push("");
    } else if (options.length && /^\s+\S/.test(line) && !HORIZONTAL_RULE.test(line) && !MENU_FOOTER.test(line)) {
      const text = cleanDecisionText(line);
      if (text) details[details.length - 1] = details[details.length - 1] ? `${details[details.length - 1]} ${text}` : text;
    }
  }
  return details.some(Boolean) ? { question, options, details } : { question, options };
}

/**
 * La pregunta de un menú es el párrafo que termina en la línea con «?»: Claude envuelve las
 * preguntas largas y quedarse con la última línea dejaba sólo «proceed?». Sube por líneas
 * contiguas hasta una vacía, una regla u otra opción, con tope para no arrastrar salida vieja.
 */
function questionParagraph(pane: string, windowLength: number, questionIndex: number): string {
  const wide = recentLines(pane, RECENT_LINES + PARAGRAPH_EXTRA_LINES);
  const end = questionIndex + (wide.length - windowLength);
  let start = end;
  while (start > 0 && end - start + 1 < MAX_PARAGRAPH_LINES) {
    const previous = wide[start - 1]!;
    if (!previous.trim() || HORIZONTAL_RULE.test(previous) || NUMBERED_OPTION.test(previous)) break;
    start -= 1;
  }
  return wide.slice(start, end + 1).map(cleanDecisionText).filter(Boolean).join(" ");
}

/**
 * ¿La última línea con texto del pane es una opción del menú numerado? Un menú de permisos de
 * Claude vivo termina en sus opciones (sin footer reconocible por claudeAlive); si Claude salió,
 * el shell escribe su prompt DEBAJO del frame rancio y esto deja de cumplirse.
 */
export function menuIsLastLine(pane: string): boolean {
  const decision = detectDecision(pane);
  const last = recentLines(pane, RECENT_LINES).at(-1);
  return Boolean(decision?.options.length && last !== undefined && NUMBERED_OPTION.test(last));
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
