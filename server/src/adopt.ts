import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { isWithinTrustedRoot } from "./repo-roots.js";
import { isSafeSessionName } from "./session-name.js";
import { ensureCycleDir, removeCycleDir, writeFlow } from "./stages.js";
import type { AdoptionRecord } from "./types.js";
import { stripVerifyFields, type WfStage, type WorkflowConfig } from "./workflow.js";

/**
 * Dominio puro de la adopción (F2/T1): NO ejecuta nada. El `execFile("tmux", …)` vive en
 * tmux.ts (regla de sessions.ts:9-12); aquí sólo se valida, con dependencias inyectadas, para
 * poder probarlo sin tmux ni disco real.
 */

export interface AdoptInventoryEntry {
  name: string;
  kind: "managed" | "foreign";
  createdAt: number; // ms epoch (session_created * 1000)
  panes: { id: string }[];
}

export interface AdoptDeps {
  inventory: () => AdoptInventoryEntry[];
  listRepos: () => string[];
  resolveCwd: (repo: string) => { cwd: string; real: boolean };
  allowedRoots: string[];
  realpath: (path: string) => string;
  resolveFlow: (repo: string) => WorkflowConfig;
}

export interface AdoptInput {
  session: string;
  confirm?: boolean;
  repo?: string;
  paneId?: string;
  expectedSessionCreatedAt?: number;
}

export type AdoptErrorCode =
  | "CONFIRMATION_REQUIRED"
  | "INVALID_SESSION"
  | "SESSION_NOT_FOUND"
  | "STALE_VIEW"
  | "INVALID_PANE"
  | "PANE_NOT_IN_SESSION"
  | "REPO_NOT_ALLOWED"
  | "ALREADY_MANAGED"
  | "PANE_AMBIGUOUS";

export class AdoptValidationError extends Error {
  constructor(readonly code: AdoptErrorCode) {
    super(code);
    this.name = "AdoptValidationError";
  }
}

export interface AdoptResult {
  session: string;
  repo: string;
  cwd: string; // realpath resuelto y contenido en una raíz permitida
  paneId: string;
  sessionCreatedAt: number;
  workflow: WorkflowConfig; // congelado: verifyAfter null, sin verifyCmd/maxRetries
}

export function validateAdopt(input: AdoptInput, deps: AdoptDeps): AdoptResult {
  if (input.confirm !== true) throw new AdoptValidationError("CONFIRMATION_REQUIRED");
  if (!isSafeSessionName(input.session)) throw new AdoptValidationError("INVALID_SESSION");
  const entry = deps.inventory().find((s) => s.name === input.session);
  if (!entry) throw new AdoptValidationError("SESSION_NOT_FOUND");
  // El cliente afirma haber visto un estado concreto (session_created); si no coincide con
  // el vivo, o no lo mandó, no puede haber visto lo que dice — un curl a ciegas no lo tiene.
  if (input.expectedSessionCreatedAt !== entry.createdAt) throw new AdoptValidationError("STALE_VIEW");
  if (input.paneId !== undefined) {
    if (!/^%\d+$/.test(input.paneId)) throw new AdoptValidationError("INVALID_PANE");
    if (!entry.panes.some((p) => p.id === input.paneId)) throw new AdoptValidationError("PANE_NOT_IN_SESSION");
  }
  // La clave de repos.json ES la allowlist; una ruta libre aquí haría que la adopción
  // apuntara al directorio del SERVIDOR por el `real:false` de resolveCwd (repos.ts:35-39).
  if (!input.repo || !deps.listRepos().includes(input.repo)) throw new AdoptValidationError("REPO_NOT_ALLOWED");
  const resolved = deps.resolveCwd(input.repo);
  if (!resolved.real) throw new AdoptValidationError("REPO_NOT_ALLOWED");
  // M1: las raíces de confianza son una política independiente (repo-roots.ts), nunca
  // derivadas de las entradas que se validan — de lo contrario el destino de un symlink
  // se convertiría en su propia raíz y esta comprobación no podría fallar nunca.
  const realCwd = deps.realpath(resolved.cwd);
  if (!isWithinTrustedRoot(realCwd, deps.allowedRoots)) throw new AdoptValidationError("REPO_NOT_ALLOWED");

  // Un adoptado nunca dispara el verificador independiente ni ejecuta verifyCmd: congelado
  // aquí, sea lo que sea que el repo traiga (T4/54d/54e dependen de esto en el engine).
  const flow = deps.resolveFlow(input.repo);
  const workflow: WorkflowConfig = {
    stages: flow.stages.map((stage) => stripVerifyFields(stage) as WfStage),
    verifyAfter: null,
  };

  if (entry.kind === "managed") throw new AdoptValidationError("ALREADY_MANAGED");

  // Nunca elegir por el operador: con 0 o 2+ panes candidatos no hay un %N inequívoco.
  let paneId = input.paneId;
  if (paneId === undefined) {
    if (entry.panes.length !== 1) throw new AdoptValidationError("PANE_AMBIGUOUS");
    paneId = entry.panes[0]!.id;
  }

  return {
    session: input.session,
    repo: input.repo,
    cwd: realCwd,
    paneId,
    sessionCreatedAt: entry.createdAt,
    workflow,
  };
}

// ---- T2: persistencia atómica + rollback (cierra B4) ----

export interface LiveSessionSnapshot {
  createdAt: number;
  panes: { id: string }[];
}

export interface CommitAdoptDeps extends AdoptDeps {
  cycleDirForSession: (session: string) => string;
  // D1 (bug real, hallado en review): validateAdopt valida contra `deps.inventory()`, que el
  // llamador (engine.ts's adoptSession) captura UNA vez, ANTES de esta sección crítica — matar
  // y recrear la MISMA sesión (otro createdAt, otro %N) entre esa lectura y este commit dejaría
  // pasar datos rancios si sólo se re-comprueba existencia. null = la sesión ya no existe.
  liveSessionSnapshot: (session: string) => Promise<LiveSessionSnapshot | null>;
  setAdoptedMark: (session: string, payload: string) => Promise<void>;
  readAdoptedMark: (session: string) => Promise<string | null>;
  clearAdoptedMark: (session: string) => Promise<void>;
  registerWorker: (result: AdoptResult) => void | Promise<void>;
  serialize: <T>(session: string, fn: () => Promise<T>) => Promise<T>;
}

export type CommitAdoptOutcome =
  | { status: "created"; result: AdoptResult }
  | { status: "idempotent"; result: AdoptResult }
  | { status: "conflict"; existing: AdoptionRecord };

export class AdoptCommitError extends Error {
  constructor(readonly code: "SESSION_GONE" | "MARK_MISMATCH") {
    super(code);
    this.name = "AdoptCommitError";
  }
}

function markPayload(result: AdoptResult): string {
  return `v1|${result.repo}|${result.paneId}|${Math.floor(result.sessionCreatedAt / 1000)}`;
}

function sameAdoption(a: AdoptResult, b: AdoptionRecord): boolean {
  return (
    a.repo === b.repo &&
    a.cwd === b.cwd &&
    a.paneId === b.paneId &&
    a.sessionCreatedAt === b.sessionCreatedAt &&
    JSON.stringify(a.workflow) === JSON.stringify(b.workflow)
  );
}

function readAdoptionRecord(cycle: string): AdoptionRecord | null {
  try {
    return JSON.parse(readFileSync(join(cycle, "adopted.json"), "utf8")) as AdoptionRecord;
  } catch {
    return null;
  }
}

/**
 * Orden de commit (T2): 1) valida sobre un inventario recién leído; 2) re-comprueba que la
 * sesión sigue viva DENTRO de la sección crítica (serializada por sesión); 3) decide
 * idempotente/conflicto/nuevo contra lo que ya hubiera en el cycle dir; 4) persiste
 * atómicamente (adopted.json + flow.json) — lanza si falla; 5) marca en tmux + relee para
 * confirmar; 6) registra el worker. La marca es LO ÚLTIMO antes de registrar el worker, no
 * lo primero: así el único estado intermedio posible es "dir con metadatos y sin marca" =
 * NO adoptado = basura inocua y re-adoptable. Un fallo en 6 ya no es adopción parcial: los
 * datos duraderos están completos, y un redescubrimiento la recupera (test 36).
 */
export async function commitAdopt(input: AdoptInput, deps: CommitAdoptDeps): Promise<CommitAdoptOutcome> {
  return deps.serialize(input.session, async () => {
    const result = validateAdopt(input, deps);
    const live = await deps.liveSessionSnapshot(input.session);
    if (!live) throw new AdoptCommitError("SESSION_GONE");
    // D1: `result` viene de validateAdopt, que sólo vio el inventario CONGELADO que el
    // llamador capturó antes de esta sección crítica. Si la sesión fue matada+recreada con el
    // mismo nombre entre esa lectura y este commit (otro createdAt y/o otro %N), `live` ya no
    // describe lo que `result` cree — rechazar aquí, nunca persistir datos rancios.
    if (live.createdAt !== result.sessionCreatedAt) throw new AdoptValidationError("STALE_VIEW");
    if (!live.panes.some((p) => p.id === result.paneId)) throw new AdoptValidationError("PANE_NOT_IN_SESSION");

    const cycle = deps.cycleDirForSession(input.session);
    const existing = readAdoptionRecord(cycle);
    // Un adopted.json cuyo sessionCreatedAt no coincide con la sesión VIVA es de una sesión
    // anterior con el mismo nombre: se ignora, nunca se lee como el registro vigente.
    const liveExisting = existing && existing.sessionCreatedAt === result.sessionCreatedAt ? existing : null;
    if (liveExisting) {
      if (sameAdoption(result, liveExisting)) return { status: "idempotent", result };
      return { status: "conflict", existing: liveExisting };
    }

    const snapshotExisted = existsSync(cycle);
    const record: AdoptionRecord = {
      version: 1,
      session: result.session,
      repo: result.repo,
      cwd: result.cwd,
      paneId: result.paneId,
      sessionCreatedAt: result.sessionCreatedAt,
      adoptedAt: Date.now(),
      workflow: result.workflow,
    };

    const rollback = async (): Promise<void> => {
      await deps.clearAdoptedMark(input.session).catch(() => {});
      if (!snapshotExisted) removeCycleDir(cycle);
    };

    try {
      ensureCycleDir(cycle);
      writeJsonAtomic(join(cycle, "adopted.json"), record);
      writeFlow(cycle, result.workflow);
    } catch (error) {
      await rollback();
      throw error;
    }

    const payload = markPayload(result);
    try {
      await deps.setAdoptedMark(input.session, payload);
      const readBack = await deps.readAdoptedMark(input.session);
      if (readBack !== payload) throw new AdoptCommitError("MARK_MISMATCH");
    } catch (error) {
      await rollback();
      throw error;
    }

    // El registro del worker puede fallar sin que la adopción deje de ser válida: los datos
    // duraderos ya están completos y la marca ya está puesta (paso 6, no rollback).
    try {
      await deps.registerWorker(result);
    } catch {
      // Diagnóstico, no rollback — ver comentario de la función.
    }

    return { status: "created", result };
  });
}
