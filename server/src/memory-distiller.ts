import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { runClaudeP, type ClaudePOptions } from "./claude-p.js";
import { MEMORY } from "./config.js";
import { DATA_DIR } from "./data-dir.js";
import { engineInvocation, type EngineChoice } from "./engine-config.js";
import { readFlowProgress } from "./flow-progress.js";
import { readReplies } from "./history.js";
import { defaultMemoryStore, type MemoryStore } from "./memory.js";
import { buildDistillPrompt, buildEvidence, hasEvidence, parseDistillOutput, readCycleLaunch, readDistillSources } from "./memory-distill.js";
import { getPromptTemplate } from "./prompts.js";
import { resolveCwd } from "./repos.js";
import { isSafeSessionName } from "./session-name.js";
import { readEngine } from "./settings.js";
import { cycleDirForSession, readCycleRepo } from "./stages.js";
import type { DistillState, DistillStatus } from "./types.js";

/**
 * Destilación de memoria (spec §5). Una sola en curso por repo; las demás esperan en una cola EN
 * MEMORIA. Lo persistido (`<dataDir>/memory/state.json`) garantiza que cada sesión se destile una
 * sola vez aunque Ronin se reinicie: una sesión que sólo estaba en cola no dejó estado y el barrido
 * la vuelve a encontrar. Un fallo o un timeout deja `failed` y nunca toca la sesión.
 */

export const DISTILL_TIMEOUT_MS = 600_000;
export const DISTILL_SCAN_INTERVAL_MS = 30_000;
const CYCLE_PREFIX = "cowork-cycle-";
const ERROR_MAX_CHARS = 500;
const INTERRUPTED = "interrumpida: Ronin se reinició antes de terminar";
const STATUSES: DistillStatus[] = ["running", "done", "failed", "skipped"];

interface DistillJournal {
  /** Marca del primer barrido: los ciclos que terminaron antes no se destilan solos. */
  since?: number;
  sessions: Record<string, DistillState>;
}

export interface DistillStateStore {
  get(session: string): DistillState | null;
  set(session: string, state: DistillState): void;
  since(): number | undefined;
  setSince(at: number): void;
}

function sanitizeState(raw: unknown): DistillState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!STATUSES.includes(value.status as DistillStatus) || typeof value.repo !== "string" || typeof value.at !== "number") return null;
  return {
    status: value.status as DistillStatus,
    repo: value.repo,
    at: value.at,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.proposed === "number" ? { proposed: value.proposed } : {}),
  };
}

/** Estado por sesión con escritura atómica. Cada operación relee el archivo (es pequeño). */
export function createDistillStateStore(file: string): DistillStateStore {
  const load = (): DistillJournal => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { since?: unknown; sessions?: unknown } | null;
      const sessions: Record<string, DistillState> = {};
      const stored = raw?.sessions && typeof raw.sessions === "object" ? (raw.sessions as Record<string, unknown>) : {};
      for (const [name, value] of Object.entries(stored)) {
        const state = sanitizeState(value);
        if (state) sessions[name] = state;
      }
      return { ...(typeof raw?.since === "number" ? { since: raw.since } : {}), sessions };
    } catch {
      return { sessions: {} };
    }
  };
  const save = (journal: DistillJournal): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeJsonAtomic(file, journal);
  };
  return {
    get: (session) => load().sessions[session] ?? null,
    set: (session, state) => {
      const journal = load();
      journal.sessions[session] = state;
      save(journal);
    },
    since: () => load().since,
    setSince: (at) => {
      const journal = load();
      journal.since = at;
      save(journal);
    },
  };
}

export interface DistillerDeps {
  store: MemoryStore;
  state: DistillStateStore;
  cycleFor(session: string): string;
  listCycleSessions(): string[];
  /** Carpeta del repo: `codex exec` exige correr dentro de un repo git. */
  cwdFor(repo: string): string;
  readEngine(): EngineChoice;
  runClaudeP(input: string, options: ClaudePOptions): Promise<string>;
  readReplies(session: string): string[];
  globalEnabled(): boolean;
  now(): number;
  /** Plantilla efectiva; por defecto la editable `memory` de prompts.ts. */
  promptTemplate?(): string;
  timeoutMs?: number;
  logError?(error: unknown): void;
}

export type DistillRequestOutcome = "queued" | "busy" | "exists" | "unknown";

export interface Distiller {
  /** `auto` no repite una sesión con estado; `manual` sirve también para reintentar. */
  request(session: string, trigger: "auto" | "manual"): DistillRequestOutcome;
  /** Encola las sesiones con el flujo completo y sin estado. Devuelve las encoladas. */
  scan(): string[];
  stateOf(session: string): DistillState | null;
  /** Resuelve cuando todas las colas se vaciaron (lo usan las pruebas). */
  idle(): Promise<void>;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > ERROR_MAX_CHARS ? `${text.slice(0, ERROR_MAX_CHARS)}…` : text;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`la destilación excedió el tiempo límite (${Math.round(ms / 1000)} s)`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export function createDistiller(deps: DistillerDeps): Distiller {
  const inFlight = new Map<string, { repo: string; at: number }>();
  const tails = new Map<string, Promise<void>>();
  const timeoutMs = deps.timeoutMs ?? DISTILL_TIMEOUT_MS;

  async function run(session: string, repo: string): Promise<void> {
    const finish = (state: DistillState): void => deps.state.set(session, state);
    try {
      finish({ status: "running", repo, at: deps.now() });
      const memory = deps.store.read(repo);
      if (!deps.globalEnabled() || !memory.enabled) {
        finish({ status: "skipped", repo, at: deps.now(), reason: "la memoria está desactivada" });
        return;
      }
      const cycle = deps.cycleFor(session);
      const sources = readDistillSources(cycle);
      if (!hasEvidence(sources)) {
        finish({ status: "skipped", repo, at: deps.now(), reason: "la sesión no dejó evidencia" });
        return;
      }
      const launch = readCycleLaunch(cycle);
      const prompt = buildDistillPrompt({
        repo,
        session,
        workflow: launch.workflow,
        request: launch.request,
        evidence: buildEvidence(sources),
        replies: deps.readReplies(session),
        known: memory.entries,
      }, deps.promptTemplate?.() ?? getPromptTemplate("memory"));
      const output = await withTimeout(
        deps.runClaudeP(prompt, { timeoutMs, cwd: deps.cwdFor(repo), ...engineInvocation(deps.readEngine()) }),
        timeoutMs,
      );
      const added = deps.store.propose(repo, parseDistillOutput(output), session);
      finish({ status: "done", repo, at: deps.now(), proposed: added.length });
    } catch (error) {
      deps.logError?.(error);
      try {
        finish({ status: "failed", repo, at: deps.now(), error: errorText(error) });
      } catch (persistError) {
        deps.logError?.(persistError);
      }
    }
  }

  function request(session: string, trigger: "auto" | "manual"): DistillRequestOutcome {
    if (!isSafeSessionName(session)) return "unknown";
    if (inFlight.has(session)) return "busy";
    if (trigger === "auto" && deps.state.get(session)) return "exists";
    let repo: string | null;
    try {
      repo = readCycleRepo(deps.cycleFor(session));
    } catch {
      return "unknown";
    }
    if (!repo || !deps.store.knows(repo)) return "unknown";
    const target = repo;
    inFlight.set(session, { repo: target, at: deps.now() });
    const previous = tails.get(target) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(() => run(session, target))
      .finally(() => {
        inFlight.delete(session);
        if (tails.get(target) === next) tails.delete(target);
      });
    tails.set(target, next);
    return "queued";
  }

  function scan(): string[] {
    const since = deps.state.since();
    if (since === undefined) {
      deps.state.setSince(deps.now());
      return [];
    }
    const queued: string[] = [];
    for (const session of deps.listCycleSessions()) {
      if (inFlight.has(session) || deps.state.get(session)) continue;
      let finishedAt = 0;
      try {
        const flow = readFlowProgress(deps.cycleFor(session));
        if (!flow || flow.total === 0 || flow.done < flow.total) continue;
        finishedAt = Math.max(...flow.stages.map((stage) => stage.at ?? 0));
      } catch {
        continue;
      }
      if (finishedAt < since) continue;
      if (request(session, "auto") === "queued") queued.push(session);
    }
    return queued;
  }

  function stateOf(session: string): DistillState | null {
    const flight = inFlight.get(session);
    const persisted = deps.state.get(session);
    if (flight) return persisted?.status === "running" ? persisted : { status: "running", repo: flight.repo, at: flight.at };
    // Un running persistido sin nadie ejecutándolo es de un proceso que murió: se reporta, no se reescribe.
    if (persisted?.status === "running") return { status: "failed", repo: persisted.repo, at: persisted.at, error: INTERRUPTED };
    return persisted;
  }

  async function idle(): Promise<void> {
    while (tails.size) await Promise.all([...tails.values()]);
  }

  return { request, scan, stateOf, idle };
}

/** Sesiones con cycle dir en `root` (por defecto /tmp, donde lo crea cycleDirForSession). */
export function listCycleSessions(root = "/tmp"): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(CYCLE_PREFIX))
      .map((entry) => entry.name.slice(CYCLE_PREFIX.length))
      .filter((name) => isSafeSessionName(name));
  } catch {
    return [];
  }
}

let sharedDistiller: Distiller | null = null;

/** Destilador de producción, compartido por el barrido y la ruta manual. Crearlo no escribe nada. */
export function getDefaultDistiller(): Distiller {
  return (sharedDistiller ??= createDistiller({
    store: defaultMemoryStore(),
    state: createDistillStateStore(join(DATA_DIR, "memory", "state.json")),
    cycleFor: cycleDirForSession,
    listCycleSessions: () => listCycleSessions(),
    cwdFor: (repo) => resolveCwd(repo).cwd,
    readEngine: () => readEngine(),
    runClaudeP,
    readReplies: (session) => readReplies(session),
    globalEnabled: () => MEMORY,
    now: () => Date.now(),
    logError: (error) => console.error("[claude-cowork] destilación de memoria", error),
  }));
}

/** Disparador automático: barre cada `intervalMs`. Un barrido que lanza no detiene el bucle. */
export function startMemoryDistiller(distiller: Pick<Distiller, "scan">, intervalMs = DISTILL_SCAN_INTERVAL_MS): { stop(): void } {
  const timer = setInterval(() => {
    try {
      distiller.scan();
    } catch (error) {
      console.error("[claude-cowork] barrido de memoria", error);
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
