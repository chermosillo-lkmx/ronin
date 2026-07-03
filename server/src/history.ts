import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "history.jsonl");

export type EventType = "launch" | "complete" | "stop";

export interface HistoryEvent {
  ts: number; // ms epoch
  type: EventType;
  key: string;
  title: string;
  source: string;
  repo: string;
  body?: string;      // opcional: mensaje disparador completo (task.body), clave para ad-hoc/custom
  evidence?: string;  // opcional: snapshot compacto de la evidencia del worker al completar/parar
}

/** Recorta a n chars agregando "…[truncado]" para no inflar el JSONL/prompt. */
export function truncate(s: string, n = 4000): string {
  return s.length > n ? s.slice(0, n) + "\n…[truncado]" : s;
}

/** Append an event to the JSONL log (survives restarts). */
export function recordEvent(e: Omit<HistoryEvent, "ts">): void {
  const ev: HistoryEvent = { ts: Date.now(), ...e };
  try {
    appendFileSync(FILE, JSON.stringify(ev) + "\n");
  } catch {
    /* best-effort log */
  }
}

/** Read events within [from, to) ms. Newest first. */
export function readHistory(from = 0, to = Number.MAX_SAFE_INTEGER): HistoryEvent[] {
  let lines: string[] = [];
  try {
    lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
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
