import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../data-dir.js";

/**
 * Diario de performance de ciclos: append-only, un archivo por mes en el data dir
 * (`cycle-metrics-YYYY-MM.jsonl`). Sobrevive al cierre de la sesión y al borrado de
 * `/tmp/cowork-cycle-*`, que es donde vivía todo lo demás (y sólo la última corrida).
 */
export interface LaunchEvent { t: number; type: "launch"; session: string; repo: string; workflowId?: string; workflowName?: string; createdAt: number }
/** Un sentinela tocado (o re-tocado): el inicio de una visita a esa etapa. */
export interface StageEvent { t: number; type: "stage"; session: string; stage: string; at: number }
/** Un desenlace de gate. `ran` = se corrió el comando (no caché/sucio/sin HEADs). */
export interface GateEvent {
  t: number;
  type: "gate";
  session: string;
  stage: string;
  status: string;
  attempts: number;
  ran: boolean;
  startedAt?: number;
  endedAt: number;
  /** Cuándo se tocó el sentinela de la etapa: `startedAt - armedAt` es la espera en cola. */
  armedAt?: number;
  reason?: string;
}
export interface SessionSample { cpu: number; rssMb: number }
export interface SampleEvent {
  t: number;
  type: "sample";
  load1: number;
  cores: number;
  freeMemMb: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  sessions: Record<string, SessionSample>;
}
export interface CloseEvent { t: number; type: "close"; session: string; at: number }
export type PerfEvent = LaunchEvent | StageEvent | GateEvent | SampleEvent | CloseEvent;

/** Distribuye `Omit` sobre la unión (Omit directo sobre una unión pierde los campos propios). */
export type NewPerfEvent = PerfEvent extends infer E ? (E extends PerfEvent ? Omit<E, "t"> & { t?: number } : never) : never;

const monthKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const journalFile = (ms: number, dir = DATA_DIR): string => join(dir, `cycle-metrics-${monthKey(ms)}.jsonl`);

export interface PerfJournal {
  append(e: NewPerfEvent): void;
  /** Eventos con `t` en [from, to), en orden de escritura. */
  read(from: number, to?: number): PerfEvent[];
}

export function createJournal(dir = DATA_DIR, now: () => number = Date.now): PerfJournal {
  return {
    append(e) {
      const ev = { ...e, t: e.t ?? now() } as PerfEvent;
      try {
        appendFileSync(journalFile(ev.t, dir), JSON.stringify(ev) + "\n");
      } catch {
        /* best-effort: medir nunca rompe un ciclo */
      }
    },
    read(from, to = Number.MAX_SAFE_INTEGER) {
      const out: PerfEvent[] = [];
      const end = Math.min(to, now() + 1);
      // Un archivo por mes entre `from` y `end`.
      const cursor = new Date(from);
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      while (cursor.getTime() < end) {
        let lines: string[] = [];
        try {
          lines = readFileSync(journalFile(cursor.getTime(), dir), "utf8").split("\n");
        } catch {
          /* mes sin archivo */
        }
        for (const line of lines) {
          if (!line) continue;
          try {
            const ev = JSON.parse(line) as PerfEvent;
            if (typeof ev?.t === "number" && ev.t >= from && ev.t < to) out.push(ev);
          } catch {
            /* línea corrupta (p.ej. escritura cortada): se salta */
          }
        }
        cursor.setMonth(cursor.getMonth() + 1);
      }
      return out;
    },
  };
}
