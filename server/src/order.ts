import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "order.json");

/** User's manual ordering of tasks (a sequence of task ids). Persisted. */
let order: string[] = load();

function load(): string[] {
  try {
    const o = JSON.parse(readFileSync(FILE, "utf8")).order;
    return Array.isArray(o) ? o : [];
  } catch {
    return [];
  }
}

export function currentOrder(): string[] {
  return order;
}

export function setOrder(ids: string[]): void {
  order = ids;
  try {
    writeFileSync(FILE, JSON.stringify({ order }));
  } catch {
    /* best-effort */
  }
}
