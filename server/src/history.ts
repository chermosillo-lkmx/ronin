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
