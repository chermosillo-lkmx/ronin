import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPORT_DAILY_AT, REPORT_WEEKLY_DAY } from "./config.js";
import { generateReport, reportName, windowFor, REPORTS_DIR } from "./reports.js";

const STATE = join(REPORTS_DIR, ".state.json");
const TICK_MS = 15 * 60 * 1000;
type State = { daily?: string; weekly?: string };

const readState = (): State => { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } };
function writeState(s: State): void {
  try { mkdirSync(REPORTS_DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch { /* best-effort */ }
}
function parseHHMM(s: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return [19, 0];
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return [19, 0]; // rechaza 25:00 / 19:99 → el diario no dispararía nunca
  return [hh, mm];
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;                               // reentrancy guard (tick puede tardar > TICK)
  running = true;
  try {
    const now = new Date();
    const [hh, mm] = parseHHMM(REPORT_DAILY_AT);
    const past = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm);
    if (!past) return;
    const st = readState();

    const [dFrom] = windowFor("daily");
    const dName = reportName("daily", dFrom);
    if (st.daily !== dName && !existsSync(join(REPORTS_DIR, `${dName}.md`))) {
      try { await generateReport("daily"); st.daily = dName; writeState(st); console.log(`[claude-cowork] reporte diario generado: ${dName}`); }
      catch (e) { console.warn(`[claude-cowork] reporte diario falló: ${(e as Error).message}`); }
    }
    if (now.getDay() === REPORT_WEEKLY_DAY) {
      const [wFrom] = windowFor("weekly");
      const wName = reportName("weekly", wFrom);
      if (st.weekly !== wName && !existsSync(join(REPORTS_DIR, `${wName}.md`))) {
        try { await generateReport("weekly"); st.weekly = wName; writeState(st); console.log(`[claude-cowork] reporte semanal generado: ${wName}`); }
        catch (e) { console.warn(`[claude-cowork] reporte semanal falló: ${(e as Error).message}`); }
      }
    }
  } finally {
    running = false;
  }
}

/** Arranca el scheduler de reportes (gated por COWORK_REPORT_SCHEDULE). Best-effort, no rompe el server. */
export function startReportSchedule(): void {
  console.log(`[claude-cowork] scheduler de reportes activo (diario ~${REPORT_DAILY_AT}, semanal día ${REPORT_WEEKLY_DAY})`);
  const run = () => tick().catch((e) => console.warn(`[claude-cowork] scheduler reportes: ${e.message}`));
  // Best-effort: al boot solo genera el reporte de HOY (si ya pasó la hora). Un día en que el server
  // estuvo caído a la hora programada NO se backfillea; se puede generar on-demand con fecha desde el UI.
  run();                                             // corre una vez al boot (server arrancado tras la hora)
  const timer = setInterval(run, TICK_MS);
  timer.unref?.();                                   // no mantiene vivo el proceso
}
