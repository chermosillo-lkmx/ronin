import { readVerifyState, writeVerifyState, type VerifyState } from "./stages.js";
import { runVerify, verifyOutcome, verifyRunDecision, type VerifyResult } from "./verify.js";

/**
 * P2 — el bucle que faltaba. `verify.ts` traía el ejecutor (`runVerify`), la regla de desenlace
 * (`verifyOutcome`) y el ritmo (`verifyRunDecision`), y `stages.ts` el estado persistido; nada de
 * eso tenía llamador. Este módulo es ese llamador: por cada sesión de workflow mira hasta dónde
 * llegó el worker, busca la etapa con `verifyCmd` que aún se debe y la ejecuta cuando el worker
 * está ocioso.
 *
 * Lo que este driver NO hace, a propósito: no le escribe al worker. Ronin observa el flujo, no lo
 * ejecuta — quien toca los sentinelas y avanza es el propio worker dentro de tmux. El gate deja el
 * veredicto por escrito (estado persistido + informe); avisar al worker es una decisión aparte.
 */

export const DEFAULT_GATE_RETRIES = 2;
/** Un gate corre una suite entera: el default de `runVerify` (2 min) se queda corto. */
export const GATE_TIMEOUT_MS = 900_000;

export interface GateStage {
  key: string;
  label: string;
  verifyCmd?: string;
  maxRetries?: number;
}

export interface Gate {
  key: string;
  cmd: string;
  maxRetries: number;
  attempts: number;
}

/**
 * Gate que toca considerar: el MÁS TEMPRANO del flujo que ya fue alcanzado, tiene `verifyCmd` y
 * no está resuelto. Que el worker se haya adelantado no cancela un gate — es autónomo y puede
 * tocar el siguiente sentinela sin esperar a nadie, pero la deuda sigue siendo suya.
 */
export function selectGate(
  stages: GateStage[],
  reached: string | null,
  stateFor: (stageKey: string) => VerifyState | null,
): Gate | null {
  if (!reached) return null;
  const hasta = stages.findIndex((stage) => stage.key === reached);
  if (hasta < 0) return null;

  for (const stage of stages.slice(0, hasta + 1)) {
    const cmd = stage.verifyCmd?.trim();
    if (!cmd) continue;
    const state = stateFor(stage.key);
    if (state?.status === "passed" || state?.status === "failed") continue;
    return { key: stage.key, cmd, maxRetries: stage.maxRetries ?? DEFAULT_GATE_RETRIES, attempts: state?.attempts ?? 0 };
  }
  return null;
}

export interface SessionSnapshot {
  name: string;
  /** El worker está trabajando: un gate nunca corre a media faena. */
  busy: boolean;
}

export interface LaunchInfo {
  mode: "workflow" | "terminal";
  repo: string;
  /** Worktree de la sesión: el código que ESTA sesión escribió, y por tanto el que se prueba. */
  worktree?: string;
}

export interface GateReport {
  session: string;
  stageKey: string;
  status: VerifyState["status"];
  attempts: number;
  output: string;
}

export interface DriverDeps {
  listSessions(): Promise<SessionSnapshot[]>;
  launchOf(session: string): LaunchInfo | null;
  flowFor(repo: string): GateStage[];
  cycleFor(session: string): string;
  detect(cycle: string, order: string[]): string | null;
  readState(cycle: string, stageKey: string): VerifyState | null;
  writeState(cycle: string, stageKey: string, state: VerifyState): void;
  run(cmd: string, cwd: string): Promise<VerifyResult>;
  logError?(error: unknown): void;
}

/** Clave de armado en memoria: el estado persistido guarda intentos, no el rearme. */
const armKey = (session: string, stageKey: string): string => `${session}:${stageKey}`;

/**
 * Una pasada del driver. Nunca lanza: una sesión ilegible se salta y las demás siguen — el gate
 * es una comodidad, no puede tumbar el servidor.
 */
export async function tickOnce(deps: DriverDeps, armed: Map<string, boolean>): Promise<GateReport[]> {
  const informes: GateReport[] = [];
  let sesiones: SessionSnapshot[];
  try {
    sesiones = await deps.listSessions();
  } catch (error) {
    deps.logError?.(error);
    return informes;
  }

  for (const sesion of sesiones) {
    try {
      const launch = deps.launchOf(sesion.name);
      if (!launch || launch.mode !== "workflow" || !launch.worktree) continue;

      const stages = deps.flowFor(launch.repo);
      const cycle = deps.cycleFor(sesion.name);
      const gate = selectGate(stages, deps.detect(cycle, stages.map((s) => s.key)), (key) => deps.readState(cycle, key));
      if (!gate) continue;

      const clave = armKey(sesion.name, gate.key);
      const decision = verifyRunDecision(sesion.busy, gate.attempts, armed.get(clave) === true);
      if (decision === "arm") {
        armed.set(clave, true);
        continue;
      }
      if (decision === "skip") continue;

      armed.delete(clave);
      const resultado = await deps.run(gate.cmd, launch.worktree);
      const desenlace = verifyOutcome(resultado.ok, gate.attempts, gate.maxRetries);
      const state: VerifyState = { attempts: desenlace.attempts, status: desenlace.status };
      deps.writeState(cycle, gate.key, state);
      informes.push({ session: sesion.name, stageKey: gate.key, status: state.status, attempts: state.attempts, output: resultado.output });
    } catch (error) {
      deps.logError?.(error);
    }
  }
  return informes;
}

export interface DriverHandle {
  stop(): void;
}

/**
 * Arranca el bucle. Un solo tick en vuelo a la vez: una suite tarda minutos y solaparlos
 * quemaría los reintentos contra la misma corrida.
 */
export function startVerifyDriver(deps: DriverDeps, intervalMs = 20_000): DriverHandle {
  const armed = new Map<string, boolean>();
  let corriendo = false;
  const timer = setInterval(() => {
    if (corriendo) return;
    corriendo = true;
    void tickOnce(deps, armed)
      .catch((error) => deps.logError?.(error))
      .finally(() => { corriendo = false; });
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Dependencias reales: el estado y el ejecutor que ya existían, sin envoltorio nuevo. */
export const realGateDeps = {
  readState: readVerifyState,
  writeState: writeVerifyState,
  run: (cmd: string, cwd: string) => runVerify(cmd, cwd, GATE_TIMEOUT_MS),
};
