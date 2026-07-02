import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "today.json");

interface TodayFile {
  date: string; // YYYY-MM-DD
  pins: string[]; // task ids pinned for "today"
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function load(): Set<string> {
  try {
    const t = JSON.parse(readFileSync(FILE, "utf8")) as TodayFile;
    return t.date === todayStr() ? new Set(t.pins) : new Set();
  } catch {
    return new Set();
  }
}

let pins = load();

export function currentPins(): string[] {
  return [...pins];
}

export function togglePin(id: string, on: boolean): string[] {
  if (on) pins.add(id);
  else pins.delete(id);
  try {
    writeFileSync(FILE, JSON.stringify({ date: todayStr(), pins: [...pins] } satisfies TodayFile));
  } catch {
    /* best-effort */
  }
  return [...pins];
}
