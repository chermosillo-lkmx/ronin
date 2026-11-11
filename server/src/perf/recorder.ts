import type { GateEvent, PerfJournal } from "./journal.js";
import type { MachineSample } from "./sampler.js";

/**
 * Registrador de performance: en cada tick mira los ciclos vivos y anota en el diario lo que
 * cambió (lanzamiento, sentinelas tocados, cierre) más una muestra de CPU/memoria. Los gates
 * llegan por `onGateOutcome` desde el driver, con su duración real.
 *
 * Al arrancar reconstruye lo ya anotado leyendo el diario, así que reiniciar Ronin no duplica
 * eventos. La primera vez que ve un ciclo vuelca lo que el ciclo ya tenía (sentinelas y el
 * último veredicto de cada gate): así los ciclos que ya existían no empiezan en cero.
 */
export interface RecorderDeps {
  journal: PerfJournal;
  /** Sesiones con carpeta de ciclo en disco. */
  listCycleSessions(): string[];
  readLaunch(session: string): { mode?: string; repo?: string; workflowId?: string; workflowName?: string; createdAt?: number } | null;
  stageKeys(session: string): string[];
  sentinelAt(session: string, stage: string): number | null;
  verifyState(session: string, stage: string): { status: string; attempts: number; durationMs?: number; at?: number; reason?: string } | null;
  /** Sesiones managed vivas en tmux; null si tmux no se pudo leer (entonces no se cierra nada). */
  liveSessions(): Promise<Set<string> | null>;
  sample(gatePids: Map<string, number[]>): Promise<MachineSample>;
  now?(): number;
}

export interface GateOutcome {
  session: string;
  stage: string;
  status: string;
  attempts: number;
  ran: boolean;
  startedAt?: number;
  endedAt: number;
  armedAt?: number;
  reason?: string;
}

export interface PerfRecorder {
  tick(): Promise<void>;
  onGateSpawn(session: string, pid: number): void;
  onGateExit(session: string, pid: number): void;
  onGateOutcome(e: GateOutcome): void;
}

/** Ventana que se relee al arrancar: un ciclo más viejo que esto ya no se reconoce como visto. */
export const REPLAY_MS = 62 * 24 * 3600_000;

export function createPerfRecorder(deps: RecorderDeps): PerfRecorder {
  const now = deps.now ?? Date.now;
  const launched = new Set<string>();
  const closed = new Set<string>();
  const lastStage = new Map<string, number>();
  const gates = new Set<string>();
  const gatePids = new Map<string, number[]>();
  /** Sesiones que este proceso vio vivas en tmux; las demás ya estaban cerradas al arrancar. */
  const seenLive = new Set<string>();
  /** Última actividad conocida (sentinela o gate): el cierre de una sesión que nunca vimos viva. */
  const lastActivity = new Map<string, number>();
  const touch = (session: string, at: number) => lastActivity.set(session, Math.max(lastActivity.get(session) ?? 0, at));
  const gateKey = (s: string, stage: string, endedAt: number) => `${s}\u0000${stage}\u0000${endedAt}`;

  for (const ev of deps.journal.read(now() - REPLAY_MS)) {
    if (ev.type === "launch") launched.add(ev.session);
    else if (ev.type === "close") closed.add(ev.session);
    else if (ev.type === "stage") {
      lastStage.set(`${ev.session}\u0000${ev.stage}`, ev.at);
      touch(ev.session, ev.at);
    } else if (ev.type === "gate") {
      gates.add(gateKey(ev.session, ev.stage, ev.endedAt));
      touch(ev.session, ev.endedAt);
    }
  }

  const appendGate = (e: GateOutcome): void => {
    const key = gateKey(e.session, e.stage, e.endedAt);
    if (gates.has(key)) return;
    gates.add(key);
    touch(e.session, e.endedAt);
    const ev: Omit<GateEvent, "t"> = { type: "gate", ...e };
    deps.journal.append(ev);
  };

  return {
    async tick() {
      const t = now();
      for (const session of deps.listCycleSessions()) {
        let launch;
        try {
          launch = deps.readLaunch(session);
        } catch {
          continue;
        }
        if (!launch || launch.mode !== "workflow") continue;
        let stages: string[] = [];
        try {
          stages = deps.stageKeys(session);
        } catch {
          /* sin flow legible: sólo el lanzamiento */
        }
        if (!launched.has(session)) {
          launched.add(session);
          deps.journal.append({
            type: "launch",
            session,
            repo: launch.repo ?? "",
            ...(launch.workflowId ? { workflowId: launch.workflowId } : {}),
            ...(launch.workflowName ? { workflowName: launch.workflowName } : {}),
            createdAt: typeof launch.createdAt === "number" ? launch.createdAt : t,
          });
          // Volcado inicial: el último veredicto de cada gate que el ciclo ya tenía.
          for (const stage of stages) {
            const st = deps.verifyState(session, stage);
            if (!st || typeof st.at !== "number" || st.status === "pending") continue;
            const dur = st.durationMs ?? 0;
            appendGate({ session, stage, status: st.status, attempts: st.attempts, ran: dur > 0, ...(dur > 0 ? { startedAt: st.at - dur } : {}), endedAt: st.at, ...(st.reason ? { reason: st.reason } : {}) });
          }
        }
        for (const stage of stages) {
          const at = deps.sentinelAt(session, stage);
          const key = `${session}\u0000${stage}`;
          if (at === null || lastStage.get(key) === at) continue;
          lastStage.set(key, at);
          touch(session, Math.round(at));
          deps.journal.append({ type: "stage", session, stage, at: Math.round(at) });
        }
      }

      const live = await deps.liveSessions().catch(() => null);
      const open = [...launched].filter((s) => !closed.has(s));
      if (live) {
        for (const session of open) {
          if (live.has(session)) {
            seenLive.add(session);
            continue;
          }
          closed.add(session);
          // Ya cerrada antes de que este proceso la viera: su cierre es su última actividad, no ahora.
          const at = seenLive.has(session) ? t : (lastActivity.get(session) ?? t);
          deps.journal.append({ type: "close", session, at });
        }
      }

      try {
        const s = await deps.sample(gatePids);
        const sessions: MachineSample["sessions"] = {};
        for (const [name, v] of Object.entries(s.sessions)) if (launched.has(name) && !closed.has(name)) sessions[name] = v;
        deps.journal.append({ type: "sample", load1: s.load1, cores: s.cores, freeMemMb: s.freeMemMb, ...(s.swapUsedMb !== undefined ? { swapUsedMb: s.swapUsedMb, swapTotalMb: s.swapTotalMb } : {}), sessions });
      } catch {
        /* sin muestra este tick */
      }
    },
    onGateSpawn(session, pid) {
      gatePids.set(session, [...(gatePids.get(session) ?? []), pid]);
    },
    onGateExit(session, pid) {
      const rest = (gatePids.get(session) ?? []).filter((p) => p !== pid);
      if (rest.length) gatePids.set(session, rest);
      else gatePids.delete(session);
    },
    onGateOutcome: appendGate,
  };
}
