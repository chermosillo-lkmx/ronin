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
 * Detecta sólo menús que pueden parar al operador. El cursor por sí mismo NO basta: Claude usa
 * `❯ ` en su caja de texto y llamarlo decisión convertiría cualquier prompt a medio escribir en
 * una alerta. El picker /model sin numerar queda fuera a propósito por la misma razón.
 */
export function detectDecision(pane: string): Decision | null {
  const lines = (pane ?? "").split("\n").slice(-RECENT_LINES);
  const cursor = lines.findIndex((line) => NUMBERED_CURSOR.test(line));
  const generic = lines.findIndex((line) => GENERIC_CONFIRM.test(line));
  if (cursor < 0 && generic < 0) return null;

  const pivot = cursor >= 0 ? cursor : generic;
  const question = [...lines.slice(0, pivot)].reverse().find((line) => /(?:\?|¿.*\?)\s*$/.test(line.trim()))?.trim();
  if (!question) return null;
  const options = cursor < 0 ? [] : lines.slice(cursor).map((line) => line.match(NUMBERED_OPTION)?.[1]).filter((value): value is string => Boolean(value));
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
