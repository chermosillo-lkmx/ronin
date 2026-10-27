import { cacheHit, realGitPort, repoHeads, type RepoHead } from "./gate-cache.js";
import { readProvisionState, type ProvisionState } from "./provision.js";
import { readVerifyState, writeVerifyState, type VerifyState } from "./stages.js";
import { runVerify, verifyOutcome, verifyRunDecision, type VerifyResult } from "./verify.js";

/**
 * P2 — el bucle que faltaba. `verify.ts` traía el ejecutor (`runVerify`), la regla de desenlace
 * (`verifyOutcome`) y el ritmo (`verifyRunDecision`), y `stages.ts` el estado persistido; nada de
 * eso tenía llamador. Este módulo es ese llamador: por cada sesión de workflow mira hasta dónde
 * llegó el worker, busca la etapa con `verifyCmd` que aún se debe y la ejecuta cuando el worker
 * está ocioso.
 *
 * Gate de merge (`mergeGate`, el de unitarias previo al merge). Su riesgo es el VERDE FALSO: un
 * PASS para código que no se probó. Por eso, a diferencia de un gate normal:
 * - Lee los HEADs de cada sub-repo ANTES de correr y guarda ésos: si el worker commitea durante la
 *   corrida, el PASS no cubre el commit nuevo. Tras un PASS se vuelven a leer: si cambiaron (commit,
 *   edición, git ilegible) el veredicto es `failed` sin `shas`, nunca un verde dudoso.
 * - HEADs ilegibles o sin repos → `failed` con su razón, sin correr, sin gastar intento y sin `shas`
 *   (se avisa una vez); se re-arma solo cuando vuelvan a leerse.
 * - Árbol sucio → `failed` sin correr, sin gastar intento y sin `shas` (se mira ANTES que la caché:
 *   `cacheHit` no ve la suciedad).
 * - Un PASS guardado que cubre los HEADs actuales (mismos SHAs o commits sólo-e2e) se reusa sin correr.
 * - Un FAIL queda `failed` con sus SHAs: el mismo commit no se reintenta. Se re-arma cuando el árbol
 *   está limpio en SHAs distintos, así que `maxRetries` cuenta commits, no corridas. Un `passed`
 *   también se re-considera con un commit nuevo; ahí la caché decide si hace falta correr.
 * - El re-arme lo da el cambio de SHA, no el armado en memoria por ocupado/ocioso: sobrevive a un
 *   reinicio de Ronin sin repetir corridas.
 * Timeout y entorno salen de `gateConfig(repo)` para todos los gates, con o sin la bandera.
 *
 * Lo que este driver NO hace, a propósito: no le escribe al worker. Ronin observa el flujo, no lo
 * ejecuta — quien toca los sentinelas y avanza es el propio worker dentro de tmux. El gate deja el
 * veredicto por escrito (estado persistido + informe); avisar al worker es una decisión aparte.
 */

export const DEFAULT_GATE_RETRIES = 2;
/** Rutas cuyo cambio no invalida un PASS del gate de merge (ver `cacheHit`). */
export const MERGE_GATE_E2E_DIRS = ["e2e_dev/"];
export const DIRTY_REASON = "hay cambios sin commitear";
export const UNREADABLE_HEADS_REASON = "no se pudieron leer los HEADs del worktree";
export const NO_REPOS_REASON = "no encontré repos con tests en el worktree";
export const CHANGED_REASON = "el árbol cambió durante la corrida";

export interface GateStage {
  key: string;
  label: string;
  verifyCmd?: string;
  maxRetries?: number;
  mergeGate?: true;
}

export interface Gate {
  key: string;
  cmd: string;
  maxRetries: number;
  attempts: number;
  mergeGate: boolean;
}

/** sub-repo → SHA, la forma en que se persisten los HEADs probados. */
const shasOf = (heads: RepoHead[]): Record<string, string> => Object.fromEntries(heads.map((h) => [h.repo, h.sha]));

function sameShas(stored: Record<string, string> | undefined, heads: RepoHead[]): boolean {
  if (!stored || Object.keys(stored).length !== heads.length) return false;
  return heads.every((h) => Object.hasOwn(stored, h.repo) && stored[h.repo] === h.sha);
}

/** Misma foto: mismos sub-repos, mismos SHAs y todos limpios. null o vacío nunca es "igual". */
function sameHeads(antes: RepoHead[], despues: RepoHead[] | null): boolean {
  if (!despues || despues.length === 0 || despues.some((h) => h.dirty)) return false;
  return sameShas(shasOf(antes), despues);
}

/**
 * ¿Un gate de merge ya resuelto vuelve a estar en juego? Sólo con HEADs legibles, no vacíos, todos
 * limpios y distintos de los guardados (sin `shas` cuenta como distinto). Un `failed` además
 * necesita intentos libres: agotados, se queda failed.
 */
function mergeGateRearms(state: VerifyState, heads: RepoHead[] | null, maxRetries: number): boolean {
  if (!heads || heads.length === 0 || heads.some((h) => h.dirty)) return false;
  if (state.status === "failed" && state.attempts >= maxRetries) return false;
  return !sameShas(state.shas, heads);
}

/**
 * Gate que toca considerar: el MÁS TEMPRANO del flujo que ya fue alcanzado, tiene `verifyCmd` y
 * no está resuelto. Que el worker se haya adelantado no cancela un gate — es autónomo y puede
 * tocar el siguiente sentinela sin esperar a nadie, pero la deuda sigue siendo suya.
 *
 * `headsFor`: HEADs actuales del worktree. Con ellos, un gate de merge resuelto se re-arma si
 * hubo commit nuevo (ver `mergeGateRearms`); sin ellos, resuelto es resuelto, como siempre.
 */
export function selectGate(
  stages: GateStage[],
  reached: string | null,
  stateFor: (stageKey: string) => VerifyState | null,
  headsFor?: () => RepoHead[] | null,
): Gate | null {
  if (!reached) return null;
  const hasta = stages.findIndex((stage) => stage.key === reached);
  if (hasta < 0) return null;

  for (const stage of stages.slice(0, hasta + 1)) {
    const cmd = stage.verifyCmd?.trim();
    if (!cmd) continue;
    const state = stateFor(stage.key);
    const maxRetries = stage.maxRetries ?? DEFAULT_GATE_RETRIES;
    const mergeGate = stage.mergeGate === true;
    if (state?.status === "passed" || state?.status === "failed") {
      if (!mergeGate || !headsFor || !mergeGateRearms(state, headsFor(), maxRetries)) continue;
    }
    return { key: stage.key, cmd, maxRetries, attempts: state?.attempts ?? 0, mergeGate };
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
  flowFor(session: string, repo: string): GateStage[];
  cycleFor(session: string): string;
  detect(cycle: string, order: string[]): string | null;
  /** Estado del entorno del worktree; null = este repo no provisiona nada. */
  provisionOf(cycle: string): ProvisionState | null;
  readState(cycle: string, stageKey: string): VerifyState | null;
  writeState(cycle: string, stageKey: string, state: VerifyState): void;
  run(cmd: string, cwd: string, opts: { timeoutMs: number; env: Record<string, string> }): Promise<VerifyResult>;
  /** HEAD y suciedad de cada sub-repo del worktree; null si git no se pudo leer. */
  heads(worktree: string): Promise<RepoHead[] | null>;
  /** `cacheHit` de gate-cache con el git real ya inyectado. */
  cacheHit(cached: VerifyState | null, heads: RepoHead[], worktree: string, e2eDirs: string[]): Promise<boolean>;
  /** Timeout y entorno del gate para un repo (override del repo o global), leídos en cada llamada. */
  gateConfig(repo: string): { timeoutMs: number; env: Record<string, string> };
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

      const stages = deps.flowFor(sesion.name, launch.repo);
      const cycle = deps.cycleFor(sesion.name);

      // Sin entorno no hay nada que probar. `running`: la instalación sigue en marcha. `failed`:
      // el entorno no se pudo armar — se salta SIN tocar el estado del gate, porque un venv que
      // no existe no es un veredicto sobre el código y un rojo aquí sería una señal falsa.
      const provision = deps.provisionOf(cycle);
      if (provision?.status === "running" || provision?.status === "failed") continue;
      // HEADs leídos UNA vez y ANTES de cualquier corrida: son los que se guardan con el veredicto.
      // Sólo si el worker está ocioso (ocupado no corre nada) y ya alcanzó el primer gate de merge
      // del flujo: antes de eso no hay nada que re-armar y git sería trabajo tirado.
      const reached = deps.detect(cycle, stages.map((s) => s.key));
      const primerMerge = stages.findIndex((s) => s.mergeGate === true && s.verifyCmd?.trim());
      const alcanzado = reached ? stages.findIndex((s) => s.key === reached) : -1;
      const leerHeads = primerMerge >= 0 && alcanzado >= primerMerge && !sesion.busy;
      const heads = leerHeads ? await deps.heads(launch.worktree) : undefined;
      const gate = selectGate(
        stages,
        reached,
        (key) => deps.readState(cycle, key),
        heads === undefined ? undefined : () => heads,
      );
      if (!gate) continue;

      if (gate.mergeGate) {
        const informe = await runMergeGate(deps, sesion, launch.repo, launch.worktree, cycle, gate, heads);
        if (informe) informes.push(informe);
        continue;
      }

      const clave = armKey(sesion.name, gate.key);
      const decision = verifyRunDecision(sesion.busy, gate.attempts, armed.get(clave) === true);
      if (decision === "arm") {
        armed.set(clave, true);
        continue;
      }
      if (decision === "skip") continue;

      armed.delete(clave);
      const resultado = await deps.run(gate.cmd, launch.worktree, deps.gateConfig(launch.repo));
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

/**
 * Un gate de merge, en orden: ocupado → nada; HEADs ilegibles/vacíos → failed con razón; árbol
 * sucio → failed sin correr; caché → passed sin correr; si no, corre y un PASS se re-valida.
 * El orden sucio→caché es deliberado: `cacheHit` ignora `dirty` y un árbol sucio con SHAs
 * cacheados no puede dar verde.
 */
async function runMergeGate(
  deps: DriverDeps,
  sesion: SessionSnapshot,
  repo: string,
  worktree: string,
  cycle: string,
  gate: Gate,
  heads: RepoHead[] | null | undefined,
): Promise<GateReport | null> {
  if (sesion.busy) return null;
  const informe = (state: VerifyState, output: string): GateReport => {
    deps.writeState(cycle, gate.key, state);
    return { session: sesion.name, stageKey: gate.key, status: state.status, attempts: state.attempts, output };
  };

  if (!heads || heads.length === 0) {
    // Sin HEADs no hay qué probar ni qué guardar: failed SIN `shas` y sin gastar intento, para que
    // la UI y el worker no esperen para siempre. Se re-arma solo cuando los HEADs vuelvan a leerse.
    const reason = heads ? NO_REPOS_REASON : UNREADABLE_HEADS_REASON;
    const previo = deps.readState(cycle, gate.key);
    if (previo?.status === "failed" && previo.reason === reason) return null; // ya avisado: sin ruido
    deps.logError?.(new Error(`gate ${gate.key} de ${sesion.name}: ${reason} (${worktree}); no se corre`));
    return informe({ status: "failed", reason, attempts: gate.attempts }, reason);
  }

  if (heads.some((h) => h.dirty)) {
    // Sin `shas`: se re-arma en cuanto el árbol quede limpio. Sin gastar intento: no se probó nada.
    return informe({ status: "failed", reason: DIRTY_REASON, attempts: gate.attempts }, DIRTY_REASON);
  }

  const shas = shasOf(heads);
  if (await deps.cacheHit(deps.readState(cycle, gate.key), heads, worktree, MERGE_GATE_E2E_DIRS)) {
    return informe({ attempts: gate.attempts, status: "passed", shas, durationMs: 0, at: Date.now(), reason: "caché" }, "caché");
  }

  const inicio = Date.now();
  const resultado = await deps.run(gate.cmd, worktree, deps.gateConfig(repo));
  const fin = Date.now();
  // Un PASS sólo vale si el árbol sigue igual que en la foto previa: un commit o una edición a
  // media corrida pudo quedar fuera de lo probado. Sin `shas` → se re-arma en el siguiente tick limpio.
  if (resultado.ok && !sameHeads(heads, await deps.heads(worktree))) {
    return informe({ status: "failed", reason: CHANGED_REASON, attempts: gate.attempts }, resultado.output);
  }
  // Un FAIL queda failed aunque sobren intentos: el mismo commit no se reintenta (ver selectGate).
  const state: VerifyState = resultado.ok
    ? { attempts: gate.attempts, status: "passed", shas, durationMs: fin - inicio, at: fin }
    : { attempts: gate.attempts + 1, status: "failed", shas, durationMs: fin - inicio, at: fin };
  return informe(state, resultado.output);
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
  provisionOf: readProvisionState,
  readState: readVerifyState,
  writeState: writeVerifyState,
  run: (cmd: string, cwd: string, opts: { timeoutMs: number; env: Record<string, string> }) => runVerify(cmd, cwd, opts.timeoutMs, opts.env),
  heads: (worktree: string) => repoHeads(worktree, realGitPort),
  cacheHit: (cached: VerifyState | null, heads: RepoHead[], worktree: string, e2eDirs: string[]) =>
    cacheHit(cached, heads, realGitPort, worktree, e2eDirs),
};
