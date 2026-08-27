import { appendFileSync, readFileSync } from "node:fs";
import { dataPath } from "./data-dir.js";

const FILE = dataPath("history.jsonl");

export type EventType = "launch" | "close" | "adopt";

export interface HistoryEvent {
  ts: number; // ms epoch
  type: EventType;
  key: string;
  title: string;
  source: "session";
  repo: string;
  request?: string;
  evidence?: string;
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
