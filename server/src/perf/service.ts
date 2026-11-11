import { readdirSync } from "node:fs";
import { readLaunchRecord, readTmuxInventory } from "../sessions.js";
import { cycleDirForSession, readFlow, readVerifyState, sentinelMtime } from "../stages.js";
import { buildReport, reportFrom, type Bucket, type PerfReport } from "./aggregate.js";
import { createJournal, type PerfJournal } from "./journal.js";
import { createPerfRecorder, type PerfRecorder } from "./recorder.js";
import { sampleMachine } from "./sampler.js";

const CYCLE_PREFIX = "cowork-cycle-";

/** Sesiones con carpeta de ciclo en /tmp (nombres que `cycleDirForSession` acepta). */
export function listCycleSessions(dir = "/tmp"): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(CYCLE_PREFIX)).map((n) => n.slice(CYCLE_PREFIX.length));
  } catch {
    return [];
  }
  return names.filter((n) => {
    try {
      cycleDirForSession(n);
      return true;
    } catch {
      return false;
    }
  });
}

let journal: PerfJournal | null = null;
let recorder: PerfRecorder | null = null;
const getJournal = (): PerfJournal => (journal ??= createJournal());

/** El registrador real (singleton): lo comparten el bucle de muestreo y los ganchos del driver. */
export function getPerfRecorder(): PerfRecorder {
  return (recorder ??= createPerfRecorder({
    journal: getJournal(),
    listCycleSessions: () => listCycleSessions(),
    readLaunch: (s) => readLaunchRecord(s) as ReturnType<Parameters<typeof createPerfRecorder>[0]["readLaunch"]>,
    stageKeys: (s) => readFlow(cycleDirForSession(s))?.stages.map((st) => st.key) ?? [],
    sentinelAt: (s, k) => sentinelMtime(cycleDirForSession(s), k),
    verifyState: (s, k) => readVerifyState(cycleDirForSession(s), k),
    liveSessions: async () => {
      const inv = await readTmuxInventory();
      if (inv.diagnostic) return null;
      return new Set(inv.sessions.filter((x) => x.kind === "managed").map((x) => x.name));
    },
    sample: sampleMachine,
  }));
}

/** Arranca el muestreo (un tick a la vez; el primero enseguida para volcar los ciclos que ya hay). */
export function startPerfRecorder(intervalMs = 60_000): () => void {
  const rec = getPerfRecorder();
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    rec.tick().catch((e) => console.error("[claude-cowork] perf", e)).finally(() => (running = false));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function perfReport(bucket: Bucket, now = Date.now()): PerfReport {
  return buildReport(getJournal().read(reportFrom(now, bucket)), bucket, now);
}
