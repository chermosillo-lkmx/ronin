import { cacheHit, realGitPort, repoHeads, type RepoHead } from "./gate-cache.js";
import { readProvisionState, type ProvisionState } from "./provision.js";
import { DEFAULT_GATE_SETTINGS } from "./settings.js";
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
 * Concurrencia. Con 6-8 sesiones, correr las suites una tras otra dentro del tick hacía cola de
 * horas. Ahora el tick DECIDE (HEADs, árbol sucio, caché, ritmo ocupado/ocioso) y LANZA: las
 * corridas viven fuera del tick, con un cupo global (`maxConcurrent`, releído en cada tick) que
 * comparten gates de merge y normales. Sólo una corrida real del comando ocupa cupo; una caché o
 * un árbol sucio se resuelven al momento y nunca esperan detrás de una suite.
 * - Sin cupo, el gate queda `queued: true` (una sola escritura, no una por tick). Si deja de tener
 *   que correr — sesión desaparecida o ya no de workflow, worker ocupado, caché — se le quita.
 * - Al lanzar se escribe `running: true, queued: false`; el desenlace reescribe el estado sin
 *   `running` y llama a `onReport` una vez. El desenlace sale de la foto del lanzamiento (intentos,
 *   HEADs previos del gate de merge), nunca de releer un estado más nuevo.
 * - `running: true` en disco sin corrida en vuelo es una huérfana (Ronin se reinició a media
 *   suite): se trata como lista para correr, sin esperar al armado y sin gastar intento. Un gate
 *   `queued` también conserva su autorización: sale de la cola en el primer tick con cupo.
 * - Una corrida por sesión: mientras un gate de la sesión corre, los demás de esa sesión esperan
 *   (mismo worktree).
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
  /** Cupo global de corridas simultáneas (`gate.maxConcurrent` de settings), leído en cada tick. */
  maxConcurrent?(): number;
  logError?(error: unknown): void;
}

/** Clave de armado en memoria y de cupo: el estado persistido guarda intentos, no el rearme. */
const armKey = (session: string, stageKey: string): string => `${session}:${stageKey}`;

/**
 * El cupo global de corridas. Uno solo para gates de merge y normales: lo que se reparte es CPU y
 * memoria de la máquina, no turnos por tipo de gate.
 */
export interface GateSlots {
  /** Corridas simultáneas permitidas; `startVerifyDriver` lo relee de settings en cada tick. */
  max: number;
  /** `sesión:etapa` → corrida en marcha. Se borra sola al terminar. */
  inFlight: Map<string, Promise<void>>;
  /**
   * Interno del driver (se crea solo): `sesión:etapa` cuyo estado en disco lleva una marca
   * (`queued`, o `running` huérfano) que quizá haya que limpiar. Así una sesión que desaparece
   * del inventario no deja su marca para siempre.
   */
  marked?: Map<string, { cycle: string; stageKey: string }>;
}

/** Una corrida lista para lanzar: corre, escribe el desenlace y devuelve el informe. */
type Corrida = () => Promise<GateReport>;

/** El estado sin las marcas de cola: lo que queda cuando ya no está ni encolado ni corriendo. */
function sinMarcas(state: VerifyState): VerifyState {
  const { queued: _queued, running: _running, ...resto } = state;
  return resto;
}

/**
 * Una pasada del driver. Nunca lanza: una sesión ilegible se salta y las demás siguen — el gate
 * es una comodidad, no puede tumbar el servidor.
 *
 * Decide en el tick y corre fuera de él: lee HEADs, árbol sucio, caché y HEADs ilegibles aquí
 * mismo (eso no gasta cupo y nunca espera detrás de una suite), y sólo una corrida real del
 * comando ocupa un lugar en `slots`. No espera a las corridas: las lanza hasta llenar
 * `slots.max` y deja las demás con `queued: true`. Cada corrida terminada llama a `onReport`.
 */
export async function tickOnce(
  deps: DriverDeps,
  armed: Map<string, boolean>,
  slots: GateSlots,
  onReport?: (r: GateReport) => void,
): Promise<void> {
  const marcados = (slots.marked ??= new Map());
  const vigentes = new Set<string>(); // lanzadas o encoladas en este tick: su marca es actual
  // Registrar un error nunca puede lanzar: dentro de una corrida en vuelo eso sería un rechazo sin dueño.
  const registrar = (error: unknown): void => {
    try {
      deps.logError?.(error);
    } catch {
      /* el propio log falló: nada más que hacer */
    }
  };
  const informar = (informe: GateReport): void => {
    try {
      onReport?.(informe);
    } catch (error) {
      registrar(error);
    }
  };

  let sesiones: SessionSnapshot[];
  try {
    sesiones = await deps.listSessions();
  } catch (error) {
    deps.logError?.(error);
    return;
  }

  for (const sesion of sesiones) {
    // Una corrida por sesión: dos gates en el mismo worktree a la vez se pisarían (venv, reportes,
    // HEADs). Mientras uno corre, la sesión entera espera y sus marcas de cola se conservan.
    const prefijo = `${sesion.name}:`;
    if ([...slots.inFlight.keys()].some((clave) => clave.startsWith(prefijo))) {
      for (const clave of marcados.keys()) if (clave.startsWith(prefijo)) vigentes.add(clave);
      continue;
    }
    try {
      const launch = deps.launchOf(sesion.name);
      if (!launch || launch.mode !== "workflow" || !launch.worktree) continue;
      const worktree = launch.worktree;

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
      const heads = leerHeads ? await deps.heads(worktree) : undefined;
      const gate = selectGate(
        stages,
        reached,
        (key) => deps.readState(cycle, key),
        heads === undefined ? undefined : () => heads,
      );
      if (!gate) continue;

      const clave = armKey(sesion.name, gate.key);
      // Ya corre: ni se relanza ni se reescribe su estado.
      if (slots.inFlight.has(clave)) continue;

      const previo = deps.readState(cycle, gate.key);
      // Huérfana: `running` en disco sin corrida en vuelo (Ronin se reinició a media suite). Esa
      // corrida ya estaba autorizada, así que cuenta como armada y no gasta intento: el desenlace
      // sale de los intentos guardados, que el lanzamiento no tocó. Lo mismo un gate encolado:
      // `queued` sólo se escribe cuando el gate ya iba a correr, así que esperar en la cola (aun a
      // través de un reinicio) no le quita la autorización.
      const huerfana = previo?.running === true;
      const encolado = previo?.queued === true;
      if (encolado || huerfana) marcados.set(clave, { cycle, stageKey: gate.key });

      const corrida = gate.mergeGate
        ? await planMergeGate(deps, sesion, launch.repo, worktree, cycle, gate, heads, informar)
        : planGate(deps, sesion, launch.repo, worktree, cycle, gate, armed.get(clave) === true || huerfana || encolado, () => armed.set(clave, true));
      if (!corrida) continue;

      vigentes.add(clave);
      if (slots.inFlight.size >= slots.max) {
        // Sin cupo: a la cola. Se escribe una sola vez, no en cada tick que siga esperando. Se
        // conserva el estado previo (p.ej. un passed con sus SHAs): al salir de la cola sin correr,
        // quitar la marca lo deja tal cual estaba.
        marcados.set(clave, { cycle, stageKey: gate.key });
        if (previo?.queued !== true || huerfana) {
          const base: VerifyState = previo ? sinMarcas(previo) : { attempts: gate.attempts, status: "pending" };
          deps.writeState(cycle, gate.key, { ...base, queued: true });
        }
        continue;
      }

      if (!gate.mergeGate) armed.delete(clave);
      marcados.delete(clave);
      deps.writeState(cycle, gate.key, { attempts: gate.attempts, status: "pending", running: true, queued: false });
      const enVuelo = corrida()
        .then(informar, (error: unknown) => {
          // La corrida misma reventó (no un rojo): sin veredicto, se quita `running` y el gate
          // queda como estaba al lanzarse para que el siguiente tick lo reconsidere.
          registrar(error);
          try {
            deps.writeState(cycle, gate.key, { attempts: gate.attempts, status: "pending" });
          } catch (otro) {
            registrar(otro);
          }
        })
        .catch(registrar)
        .finally(() => slots.inFlight.delete(clave));
      slots.inFlight.set(clave, enVuelo);
    } catch (error) {
      deps.logError?.(error);
    }
  }

  // Marcas que ya no corresponden: encolada que ya no tiene que correr (sesión desaparecida, que
  // dejó de ser de workflow, worker ocupado, caché…) o `running` huérfano que no se relanzó.
  for (const [clave, { cycle, stageKey }] of marcados) {
    if (vigentes.has(clave)) continue;
    marcados.delete(clave);
    if (slots.inFlight.has(clave)) continue;
    try {
      const state = deps.readState(cycle, stageKey);
      if (state && (state.queued !== undefined || state.running !== undefined)) deps.writeState(cycle, stageKey, sinMarcas(state));
    } catch (error) {
      deps.logError?.(error);
    }
  }
}

/** Un gate normal: el ritmo ocupado/ocioso decide; si toca correr, devuelve la corrida. */
function planGate(
  deps: DriverDeps,
  sesion: SessionSnapshot,
  repo: string,
  worktree: string,
  cycle: string,
  gate: Gate,
  armado: boolean,
  armar: () => void,
): Corrida | null {
  const decision = verifyRunDecision(sesion.busy, gate.attempts, armado);
  if (decision === "arm") armar();
  if (decision !== "run") return null;
  // El desenlace sale de `gate` (el estado al decidir), nunca de una relectura posterior.
  return async () => {
    const resultado = await deps.run(gate.cmd, worktree, deps.gateConfig(repo));
    const desenlace = verifyOutcome(resultado.ok, gate.attempts, gate.maxRetries);
    const state: VerifyState = { attempts: desenlace.attempts, status: desenlace.status };
    deps.writeState(cycle, gate.key, state);
    return { session: sesion.name, stageKey: gate.key, status: state.status, attempts: state.attempts, output: resultado.output };
  };
}

/**
 * Un gate de merge, en orden: ocupado → nada; HEADs ilegibles/vacíos → failed con razón; árbol
 * sucio → failed sin correr; caché → passed sin correr; si no, devuelve la corrida, y un PASS se
 * re-valida contra los HEADs de ANTES de correr. Todo lo que no es correr se resuelve aquí, en el
 * tick, y se informa por `informar`. El orden sucio→caché es deliberado: `cacheHit` ignora `dirty`
 * y un árbol sucio con SHAs cacheados no puede dar verde.
 */
async function planMergeGate(
  deps: DriverDeps,
  sesion: SessionSnapshot,
  repo: string,
  worktree: string,
  cycle: string,
  gate: Gate,
  heads: RepoHead[] | null | undefined,
  informar: (r: GateReport) => void,
): Promise<Corrida | null> {
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
    informar(informe({ status: "failed", reason, attempts: gate.attempts }, reason));
    return null;
  }

  if (heads.some((h) => h.dirty)) {
    // Sin `shas`: se re-arma en cuanto el árbol quede limpio. Sin gastar intento: no se probó nada.
    informar(informe({ status: "failed", reason: DIRTY_REASON, attempts: gate.attempts }, DIRTY_REASON));
    return null;
  }

  const shas = shasOf(heads);
  if (await deps.cacheHit(deps.readState(cycle, gate.key), heads, worktree, MERGE_GATE_E2E_DIRS)) {
    informar(informe({ attempts: gate.attempts, status: "passed", shas, durationMs: 0, at: Date.now(), reason: "caché" }, "caché"));
    return null;
  }

  // `heads` y `gate.attempts` son la foto del lanzamiento: el desenlace se calcula contra ellos.
  return async () => {
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
  };
}

export interface DriverHandle {
  stop(): void;
}

/**
 * Arranca el bucle. Un solo tick a la vez (`corriendo`): dos ticks solapados decidirían dos veces
 * sobre la misma sesión. Las corridas viven fuera del tick, en `slots`, y el cupo se relee de
 * `maxConcurrent` en cada tick: un cambio en settings.json aplica sin reiniciar. `stop()` sólo
 * detiene el bucle; las corridas en vuelo terminan solas.
 */
export function startVerifyDriver(deps: DriverDeps, intervalMs = 20_000): DriverHandle {
  const armed = new Map<string, boolean>();
  const slots: GateSlots = { max: DEFAULT_GATE_SETTINGS.maxConcurrent, inFlight: new Map() };
  let corriendo = false;
  const timer = setInterval(() => {
    if (corriendo) return;
    corriendo = true;
    try {
      slots.max = deps.maxConcurrent?.() ?? DEFAULT_GATE_SETTINGS.maxConcurrent;
    } catch (error) {
      deps.logError?.(error);
    }
    void tickOnce(deps, armed, slots)
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
