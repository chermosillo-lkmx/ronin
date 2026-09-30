import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { runClaudeP, type ClaudePOptions } from "./claude-p.js";
import { LEARNED_SKILLS, MEMORY } from "./config.js";
import { DATA_DIR } from "./data-dir.js";
import { engineInvocation, type EngineChoice } from "./engine-config.js";
import { readFlowProgress } from "./flow-progress.js";
import { readReplies } from "./history.js";
import { defaultLearnedSkillStore, formatSkillCatalog, MAX_PENDING_SKILL_PROPOSALS, normalizeSkillName, type LearnedSkillStore } from "./learned-skills.js";
import { defaultMemoryStore, type MemoryStore } from "./memory.js";
import { buildDistillPrompt, buildEvidence, hasEvidence, parseDistillOutput, readCycleLaunch, readDistillSources } from "./memory-distill.js";
import { getPromptTemplate, MEMORY_TRIAGE_WARNING } from "./prompts.js";
import { resolveCwd } from "./repos.js";
import { isSafeSessionName } from "./session-name.js";
import { readEngine } from "./settings.js";
import { buildSkillDraftPrompt, evaluateSkillGate, formatOfferedSkills, isFlowComplete, parseSkillDraft, parseSkillTriage, readOfferedSkills } from "./skill-distill.js";
import { listSkills } from "./skills.js";
import { cycleDirForSession, readCycleRepo } from "./stages.js";
import type { DistillState, DistillStatus, SessionMemoryInfo, SkillDistillState, TmuxSessionInfo } from "./types.js";

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
const MEMORY_OFF = "la memoria está desactivada";
const NO_EVIDENCE = "la sesión no dejó evidencia";
const NOT_REUSABLE = "la destilación no encontró un procedimiento reutilizable";

interface SessionRecord {
  repo: string;
  memory: DistillState | null;
  /** Parte de skill: convive con la de memoria en la misma entrada de state.json. */
  skill: SkillDistillState | null;
}

interface DistillJournal {
  /** Marca del primer barrido: los ciclos que terminaron antes no se destilan solos. */
  since?: number;
  sessions: Record<string, SessionRecord>;
}

export interface DistillStateStore {
  get(session: string): DistillState | null;
  /** Escribe la parte de memoria y conserva la de skill. */
  set(session: string, state: DistillState): void;
  skill(session: string): SkillDistillState | null;
  setSkill(session: string, repo: string, state: SkillDistillState): void;
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

function sanitizeSkillState(raw: unknown): SkillDistillState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (!STATUSES.includes(value.status as DistillStatus) || typeof value.at !== "number") return null;
  return {
    status: value.status as DistillStatus,
    at: value.at,
    ...(typeof value.proposalId === "string" ? { proposalId: value.proposalId } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function sanitizeRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const memory = sanitizeState(value);
  const skill = sanitizeSkillState(value.skill);
  const repo = memory?.repo ?? (typeof value.repo === "string" ? value.repo : "");
  if (!repo || (!memory && !skill)) return null;
  return { repo, memory, skill };
}

/** En disco: los campos de memoria en la raíz (el formato previo) y `skill` como subcampo. */
function serializeRecord(record: SessionRecord): Record<string, unknown> {
  return { ...(record.memory ?? { repo: record.repo }), ...(record.skill ? { skill: record.skill } : {}) };
}

/** Estado por sesión con escritura atómica. Cada operación relee el archivo (es pequeño). */
export function createDistillStateStore(file: string): DistillStateStore {
  const load = (): DistillJournal => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { since?: unknown; sessions?: unknown } | null;
      const sessions: Record<string, SessionRecord> = {};
      const stored = raw?.sessions && typeof raw.sessions === "object" ? (raw.sessions as Record<string, unknown>) : {};
      for (const [name, value] of Object.entries(stored)) {
        const record = sanitizeRecord(value);
        if (record) sessions[name] = record;
      }
      return { ...(typeof raw?.since === "number" ? { since: raw.since } : {}), sessions };
    } catch {
      return { sessions: {} };
    }
  };
  const save = (journal: DistillJournal): void => {
    mkdirSync(dirname(file), { recursive: true });
    const sessions = Object.fromEntries(Object.entries(journal.sessions).map(([name, record]) => [name, serializeRecord(record)]));
    writeJsonAtomic(file, { ...(journal.since !== undefined ? { since: journal.since } : {}), sessions });
  };
  return {
    get: (session) => load().sessions[session]?.memory ?? null,
    set: (session, state) => {
      const journal = load();
      journal.sessions[session] = { repo: state.repo, memory: state, skill: journal.sessions[session]?.skill ?? null };
      save(journal);
    },
    skill: (session) => load().sessions[session]?.skill ?? null,
    setSkill: (session, repo, state) => {
      const journal = load();
      const previous = journal.sessions[session];
      journal.sessions[session] = { repo: previous?.repo ?? repo, memory: previous?.memory ?? null, skill: state };
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
  /** Skills aprendidas; sin esto el destilador sólo hace memoria. */
  skills?: SkillDistillDeps;
}

export interface SkillDistillDeps {
  store: Pick<LearnedSkillStore, "learningEnabled" | "catalog" | "pendingCount" | "hasPendingUpdate" | "names" | "current" | "propose">;
  /** COWORK_LEARNED_SKILLS. */
  globalEnabled(): boolean;
  /** Nombres de skills global y de repo: una colisión recibe sufijo. */
  reservedNames(repo: string): string[];
  /** Plantilla efectiva de la redacción; por defecto la editable `skill`. */
  promptTemplate?(): string;
}

export type DistillRequestOutcome = "queued" | "busy" | "exists" | "unknown";
export type SkillRequestOutcome = "queued" | "busy" | "unknown" | "incomplete" | "disabled";

export interface Distiller {
  /** `auto` no repite una sesión con estado; `manual` sirve también para reintentar. */
  request(session: string, trigger: "auto" | "manual"): DistillRequestOutcome;
  /** Encola las sesiones con el flujo completo y sin estado. Devuelve las encoladas. */
  scan(): string[];
  stateOf(session: string): DistillState | null;
  /** Propuesta manual de skill: salta el triaje y el requisito de verifyCmd, pero exige el flujo completo. */
  requestSkill(session: string): SkillRequestOutcome;
  skillStateOf(session: string): SkillDistillState | null;
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

type SkillPlan = { eligible: true } | { eligible: false; reason: string } | null;

export function createDistiller(deps: DistillerDeps): Distiller {
  const inFlight = new Map<string, { repo: string; at: number; job: "distill" | "skill" }>();
  const tails = new Map<string, Promise<void>>();
  const timeoutMs = deps.timeoutMs ?? DISTILL_TIMEOUT_MS;

  const callEngine = (prompt: string, repo: string): Promise<string> =>
    withTimeout(deps.runClaudeP(prompt, { timeoutMs, cwd: deps.cwdFor(repo), ...engineInvocation(deps.readEngine()) }), timeoutMs);

  const setSkill = (session: string, repo: string, state: Omit<SkillDistillState, "at">): void =>
    deps.state.setSkill(session, repo, { ...state, at: deps.now() });

  /**
   * ¿Esta destilación incluye la parte de skill? null = no participa (aprendizaje apagado o la sesión
   * ya tiene estado de skill: cada sesión propone una sola vez). La verificación del gate la hace el
   * servidor con flow.json y verify-<etapa>.json: el modelo no puede saltársela.
   */
  function skillPlan(session: string, repo: string, cycle: string, template: string): SkillPlan {
    const skills = deps.skills;
    if (!skills || !skills.globalEnabled() || !skills.store.learningEnabled(repo)) return null;
    if (deps.state.skill(session)) return null;
    if (!template.includes("{skillCatalog}")) return { eligible: false, reason: MEMORY_TRIAGE_WARNING };
    const gate = evaluateSkillGate(cycle);
    if (!gate.ok) return { eligible: false, reason: gate.reason };
    if (skills.store.pendingCount() >= MAX_PENDING_SKILL_PROPOSALS) {
      return { eligible: false, reason: `ya hay ${MAX_PENDING_SKILL_PROPOSALS} propuestas de skills pendientes` };
    }
    return { eligible: true };
  }

  /** Segunda llamada: redacta, valida (§4) y deja la propuesta `pending`. Nunca lanza. */
  async function draft(session: string, repo: string, input: { request: string; evidence: string; summary: string; updates: string | null }): Promise<void> {
    const skills = deps.skills!;
    try {
      setSkill(session, repo, { status: "running" });
      const prompt = buildSkillDraftPrompt({
        repo,
        session,
        request: input.request,
        evidence: input.evidence,
        summary: input.summary,
        catalog: formatSkillCatalog(skills.store.catalog()),
        current: input.updates ? skills.store.current(input.updates) : null,
      }, skills.promptTemplate?.() ?? getPromptTemplate("skill"));
      const parsed = parseSkillDraft(await callEngine(prompt, repo));
      if (parsed.kind === "skip") {
        setSkill(session, repo, { status: "skipped", reason: `la redacción la omitió: ${parsed.reason}` });
        return;
      }
      const proposal = skills.store.propose({
        repo,
        source: session,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        changes: parsed.changes,
        updates: input.updates,
        reservedNames: skills.reservedNames(repo),
      });
      setSkill(session, repo, { status: "done", proposalId: proposal.id });
    } catch (error) {
      deps.logError?.(error);
      try {
        setSkill(session, repo, { status: "failed", error: errorText(error) });
      } catch (persistError) {
        deps.logError?.(persistError);
      }
    }
  }

  /** Lee el campo `skill` de la salida de la destilación y, si lo pide, redacta. */
  async function triage(session: string, repo: string, output: string, request: string, evidence: string): Promise<void> {
    const skills = deps.skills!;
    const result = parseSkillTriage(output);
    if (!result.ok) return setSkill(session, repo, { status: "failed", error: errorText(result.error) });
    if (!result.triage) return setSkill(session, repo, { status: "skipped", reason: NOT_REUSABLE });
    const names = skills.store.names();
    const updates = [result.triage.updates, normalizeSkillName(result.triage.name)].find((name): name is string => Boolean(name) && names.includes(name!)) ?? null;
    if (updates && skills.store.hasPendingUpdate(updates)) {
      return setSkill(session, repo, { status: "skipped", reason: `ya hay una actualización pendiente para ${updates}` });
    }
    await draft(session, repo, { request, evidence, summary: result.triage.summary, updates });
  }

  async function run(session: string, repo: string): Promise<void> {
    const finish = (state: DistillState): void => deps.state.set(session, state);
    let memoryOn: boolean | null = null;
    let skillOpen = false;
    try {
      finish({ status: "running", repo, at: deps.now() });
      const memory = deps.store.read(repo);
      memoryOn = deps.globalEnabled() && memory.enabled;
      const cycle = deps.cycleFor(session);
      const template = deps.promptTemplate?.() ?? getPromptTemplate("memory");
      const plan = skillPlan(session, repo, cycle, template);
      if (plan && !plan.eligible) setSkill(session, repo, { status: "skipped", reason: plan.reason });
      skillOpen = plan?.eligible === true;
      // La llamada corre si la memoria O el aprendizaje de skills está activo en el repo.
      if (!memoryOn && !skillOpen) {
        finish({ status: "skipped", repo, at: deps.now(), reason: MEMORY_OFF });
        return;
      }
      const sources = readDistillSources(cycle);
      if (!hasEvidence(sources)) {
        finish({ status: "skipped", repo, at: deps.now(), reason: NO_EVIDENCE });
        if (skillOpen) {
          skillOpen = false;
          setSkill(session, repo, { status: "skipped", reason: NO_EVIDENCE });
        }
        return;
      }
      const launch = readCycleLaunch(cycle);
      const evidence = buildEvidence(sources);
      const prompt = buildDistillPrompt({
        repo,
        session,
        workflow: launch.workflow,
        request: launch.request,
        evidence,
        replies: deps.readReplies(session),
        known: memory.entries,
        ...(skillOpen && deps.skills ? { skillCatalog: formatSkillCatalog(deps.skills.store.catalog()), offeredSkills: formatOfferedSkills(readOfferedSkills(cycle)) } : {}),
      }, template);
      const output = await callEngine(prompt, repo);
      if (memoryOn) {
        // Tolerante: si las entradas no cumplen el esquema, sólo la memoria queda failed.
        try {
          const added = deps.store.propose(repo, parseDistillOutput(output), session);
          finish({ status: "done", repo, at: deps.now(), proposed: added.length });
        } catch (error) {
          deps.logError?.(error);
          finish({ status: "failed", repo, at: deps.now(), error: errorText(error) });
        }
      } else {
        finish({ status: "skipped", repo, at: deps.now(), reason: MEMORY_OFF });
      }
      if (skillOpen) {
        skillOpen = false;
        await triage(session, repo, output, launch.request, evidence);
      }
    } catch (error) {
      deps.logError?.(error);
      try {
        finish(memoryOn === false
          ? { status: "skipped", repo, at: deps.now(), reason: MEMORY_OFF }
          : { status: "failed", repo, at: deps.now(), error: errorText(error) });
        if (skillOpen) setSkill(session, repo, { status: "failed", error: errorText(error) });
      } catch (persistError) {
        deps.logError?.(persistError);
      }
    }
  }

  async function runSkill(session: string, repo: string): Promise<void> {
    const cycle = deps.cycleFor(session);
    await draft(session, repo, { request: readCycleLaunch(cycle).request, evidence: buildEvidence(readDistillSources(cycle)), summary: "", updates: null });
  }

  /** Una sola tarea por repo a la vez: destilaciones y redacciones manuales comparten la cola. */
  function enqueue(session: string, repo: string, job: "distill" | "skill", work: () => Promise<void>): void {
    inFlight.set(session, { repo, at: deps.now(), job });
    const previous = tails.get(repo) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(work)
      .catch((error) => deps.logError?.(error))
      .finally(() => {
        inFlight.delete(session);
        if (tails.get(repo) === next) tails.delete(repo);
      });
    tails.set(repo, next);
  }

  function knownRepoOf(session: string): string | null {
    try {
      const repo = readCycleRepo(deps.cycleFor(session));
      return repo && deps.store.knows(repo) ? repo : null;
    } catch {
      return null;
    }
  }

  function request(session: string, trigger: "auto" | "manual"): DistillRequestOutcome {
    if (!isSafeSessionName(session)) return "unknown";
    if (inFlight.has(session)) return "busy";
    if (trigger === "auto" && deps.state.get(session)) return "exists";
    const repo = knownRepoOf(session);
    if (!repo) return "unknown";
    enqueue(session, repo, "distill", () => run(session, repo));
    return "queued";
  }

  function requestSkill(session: string): SkillRequestOutcome {
    if (!isSafeSessionName(session)) return "unknown";
    if (!deps.skills?.globalEnabled()) return "disabled";
    if (inFlight.has(session)) return "busy";
    const repo = knownRepoOf(session);
    if (!repo) return "unknown";
    if (!isFlowComplete(deps.cycleFor(session))) return "incomplete";
    enqueue(session, repo, "skill", () => runSkill(session, repo));
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
    if (flight?.job === "distill") return persisted?.status === "running" ? persisted : { status: "running", repo: flight.repo, at: flight.at };
    // Un running persistido sin nadie ejecutándolo es de un proceso que murió: se reporta, no se reescribe.
    if (persisted?.status === "running") return { status: "failed", repo: persisted.repo, at: persisted.at, error: INTERRUPTED };
    return persisted;
  }

  function skillStateOf(session: string): SkillDistillState | null {
    const flight = inFlight.get(session);
    const persisted = deps.state.skill(session);
    if (flight?.job === "skill") return persisted?.status === "running" ? persisted : { status: "running", at: flight.at };
    // En una destilación en curso la parte de skill se decide adentro: se muestra lo persistido.
    if (flight?.job === "distill") return persisted;
    if (persisted?.status === "running") return { status: "failed", at: persisted.at, error: INTERRUPTED };
    return persisted;
  }

  async function idle(): Promise<void> {
    while (tails.size) await Promise.all([...tails.values()]);
  }

  return { request, scan, stateOf, requestSkill, skillStateOf, idle };
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
    skills: {
      store: defaultLearnedSkillStore(),
      globalEnabled: () => LEARNED_SKILLS,
      reservedNames: (repo) => listSkills([repo]).filter((skill) => skill.ref.root !== "learned").map((skill) => skill.name),
    },
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

/** Repo de una sesión según su cycle dir; null si no se sabe o el nombre es inseguro. */
export function sessionRepo(session: string): string | null {
  try {
    return readCycleRepo(cycleDirForSession(session));
  } catch {
    return null;
  }
}

export interface SessionMemoryDeps {
  store: Pick<MemoryStore, "knows" | "pending">;
  stateOf(session: string): DistillState | null;
  repoOf(session: string): string | null;
}

/** Lo que la UI necesita para el badge y el inspector. Nunca lanza: sin datos → null. */
export function sessionMemoryInfo(session: string, deps: SessionMemoryDeps): SessionMemoryInfo | null {
  try {
    const repo = deps.repoOf(session);
    if (!repo || !deps.store.knows(repo)) return null;
    return { repo, pending: deps.store.pending(repo).length, distill: deps.stateOf(session) };
  } catch {
    return null;
  }
}

/** Cuelga `memory` sólo de las sesiones gestionadas con datos; las ajenas no se tocan. */
export function attachSessionMemory(sessions: TmuxSessionInfo[], info: (name: string) => SessionMemoryInfo | null): TmuxSessionInfo[] {
  return sessions.map((session) => {
    if (session.kind !== "managed") return session;
    const memory = info(session.name);
    return memory ? { ...session, memory } : session;
  });
}
