import { appendFileSync, readFileSync } from "node:fs";
import { dataPath } from "./data-dir.js";

const FILE = dataPath("history.jsonl");

export type EventType = "launch" | "close" | "adopt" | "reply";

export interface HistoryEvent {
  ts: number; // ms epoch
  type: EventType;
  key: string;
  title: string;
  source: "session";
  repo: string;
  request?: string;
  evidence?: string;
  /** Sólo en `reply`: el texto que el usuario le dio a la sesión (recortado a 2000 caracteres). */
  text?: string;
}

/** Tope de una respuesta registrada: es entrada de la destilación de memoria, no un transcript. */
export const REPLY_MAX_CHARS = 2000;

/** Recorta a n chars agregando "…[truncado]" para no inflar el JSONL/prompt. */
export function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + "\n…[truncado]" : s;
}

/** Append an event to the JSONL log (survives restarts). `file` sólo lo cambian las pruebas. */
export function recordEvent(e: Omit<HistoryEvent, "ts">, file = FILE): void {
  const ev: HistoryEvent = { ts: Date.now(), ...e };
  try {
    appendFileSync(file, JSON.stringify(ev) + "\n");
  } catch {
    /* best-effort log */
  }
}

/** Read events within [from, to) ms. Newest first. */
export function readHistory(from = 0, to = Number.MAX_SAFE_INTEGER, file = FILE): HistoryEvent[] {
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: HistoryEvent[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as HistoryEvent;
      if (ev.ts >= from && ev.ts < to) out.push(ev);
    } catch {
      /* skip malformed */
    }
  }
  return out.reverse();
}

/**
 * ¿Este envío es una respuesta del usuario? Sólo texto que se envía con Enter. Una tecla suelta
 * (submit=false) o un número de 1-2 dígitos (la forma de elegir una opción de menú) no lo es.
 */
export function isReplyText(text: string, submit: boolean): boolean {
  if (!submit) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && !/^\d{1,2}$/.test(trimmed);
}

/**
 * Registra lo que el usuario le respondió a una sesión. Se asume que no es secreto porque es texto
 * dirigido al agente (spec §5); la documentación lo advierte.
 */
export function recordReply(session: string, text: string, repo = "", file = FILE): void {
  recordEvent({ type: "reply", key: session, title: session, repo, source: "session", text: truncate(text, REPLY_MAX_CHARS) }, file);
}

/** Respuestas de una sesión, de la más antigua a la más reciente. */
export function readReplies(session: string, file = FILE): string[] {
  return readHistory(0, Number.MAX_SAFE_INTEGER, file)
    .filter((event) => event.type === "reply" && event.key === session && typeof event.text === "string")
    .reverse()
    .map((event) => event.text as string);
}
