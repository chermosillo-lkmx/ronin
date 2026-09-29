import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { DATA_DIR } from "./data-dir.js";
import { listRepos } from "./repos.js";

/**
 * Memoria por repo (spec 2026-09-29-memoria-por-repo-design.md): aprendizajes que Ronin destila al
 * terminar una sesión y que el usuario aprueba. Vive FUERA del repo, en `<dataDir>/memory/<repo>.json`,
 * con escritura atómica. Aquí están las funciones puras (normalización, validación, deduplicación,
 * armado del bloque) y el store. Nada de este módulo ejecuta procesos.
 */

export const MEMORY_KINDS = ["comando", "trampa", "preferencia", "decision", "arquitectura"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = "pending" | "active" | "discarded";
export type MemoryAction = "approve" | "discard" | "edit";

/** Tope del bloque que recibe cada sesión nueva, medido en bytes UTF-8. */
export const MEMORY_BLOCK_MAX_BYTES = 2 * 1024;
export const MEMORY_TEXT_MAX_CHARS = 200;
export const MAX_DISTILLED_ENTRIES = 5;

export interface MemoryEntry {
  id: string;
  text: string;
  kind: MemoryKind;
  /** Sesión que lo propuso, o "manual". */
  source: string;
  createdAt: number;
  updatedAt: number;
  status: MemoryStatus;
  /** Cuántas veces entró en el bloque de una sesión nueva. */
  uses: number;
}

export interface KbSuggestion {
  id: string;
  text: string;
  source: string;
  createdAt: number;
}

export interface RepoMemory {
  repo: string;
  enabled: boolean;
  entries: MemoryEntry[];
  kbSuggestions: KbSuggestion[];
}

export interface MemoryBlock {
  text: string;
  bytes: number;
  /** Ids de las entradas que entraron, en orden. */
  included: string[];
  omitted: number;
}

export interface MemoryView {
  repo: string;
  enabled: boolean;
  /** false cuando COWORK_MEMORY=0: la UI lo explica en vez de ofrecer un interruptor que no hace nada. */
  globalEnabled: boolean;
  entries: MemoryEntry[];
  kbSuggestions: KbSuggestion[];
  preview: { text: string; bytes: number; maxBytes: number; omitted: number };
}

export interface PendingMemoryEntry {
  id: string;
  repo: string;
  text: string;
  kind: MemoryKind;
  source: string;
}

export type MemoryErrorCode = "REPO_UNKNOWN" | "MEMORY_NOT_FOUND" | "MEMORY_INVALID";

/** Error esperado de la memoria: trae el status HTTP para que la ruta no tenga que adivinarlo. */
export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = "MemoryError";
  }
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Sin caracteres de control y con los espacios colapsados: una entrada es una sola línea. */
export function normalizeMemoryText(raw: string): string {
  return raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** Dos textos que sólo difieren en mayúsculas o espacios son el mismo aprendizaje. */
export function dedupeKey(text: string): string {
  return normalizeMemoryText(text).toLowerCase().replace(/\s+/g, "");
}

export function validateMemoryText(raw: unknown): string {
  const text = typeof raw === "string" ? normalizeMemoryText(raw) : "";
  if (text.length < 1 || text.length > MEMORY_TEXT_MAX_CHARS) {
    throw new MemoryError("MEMORY_INVALID", `el texto debe tener entre 1 y ${MEMORY_TEXT_MAX_CHARS} caracteres`, 400);
  }
  return text;
}

export function validateMemoryInput(raw: unknown): { text: string; kind: MemoryKind } {
  const input = raw && typeof raw === "object" ? (raw as { text?: unknown; kind?: unknown }) : {};
  const text = validateMemoryText(input.text);
  if (!isMemoryKind(input.kind)) {
    throw new MemoryError("MEMORY_INVALID", `kind debe ser uno de: ${MEMORY_KINDS.join(", ")}`, 400);
  }
  return { text, kind: input.kind };
}

const SAFE_REPO_FILE = /^[A-Za-z0-9._-]+$/;
// `state` chocaría con <dataDir>/memory/state.json (estado de la destilación).
const RESERVED_REPO_NAMES = new Set([".", "..", "state"]);

/** Sólo claves que sirven tal cual como nombre de archivo dentro de <dataDir>/memory. */
export function isStorableRepo(repo: string): boolean {
  return SAFE_REPO_FILE.test(repo) && !RESERVED_REPO_NAMES.has(repo);
}

export function memoryBlockHeader(repo: string): string {
  return `Memoria del repo ${repo} (aprendizajes aprobados por el usuario; verifícalos si algo no cuadra):`;
}

const bytesOf = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Bloque literal que se antepone al prompt de arranque. Prioridad: `uses` descendente y después
 * `updatedAt` descendente. Se corta en la primera entrada que ya no cabe (la prioridad es estricta)
 * y la nota "(+N entradas omitidas)" se cuenta dentro del tope. Sin entradas activas → "".
 */
export function buildMemoryBlock(repo: string, entries: MemoryEntry[], maxBytes = MEMORY_BLOCK_MAX_BYTES): MemoryBlock {
  const active = entries
    .filter((item) => item.status === "active")
    .sort((a, b) => b.uses - a.uses || b.updatedAt - a.updatedAt);
  const empty: MemoryBlock = { text: "", bytes: 0, included: [], omitted: 0 };
  if (!active.length) return empty;

  const lines = [memoryBlockHeader(repo)];
  const included: string[] = [];
  const compose = (extra: string[], omitted: number): string =>
    [...lines, ...extra, ...(omitted > 0 ? [`(+${omitted} entradas omitidas)`] : [])].join("\n");

  for (let index = 0; index < active.length; index++) {
    const line = `- [${active[index].kind}] ${active[index].text}`;
    if (bytesOf(compose([line], active.length - index - 1)) > maxBytes) break;
    lines.push(line);
    included.push(active[index].id);
  }
  if (!included.length) return empty;
  const omitted = active.length - included.length;
  const text = compose([], omitted);
  return { text, bytes: bytesOf(text), included, omitted };
}

/** Lo que ve la UI: activas y pendientes, sugerencias para la KB y la vista previa del bloque. */
export function memoryView(memory: RepoMemory, globalEnabled: boolean): MemoryView {
  const block = buildMemoryBlock(memory.repo, memory.entries);
  return {
    repo: memory.repo,
    enabled: memory.enabled,
    globalEnabled,
    entries: memory.entries.filter((item) => item.status !== "discarded"),
    kbSuggestions: memory.kbSuggestions,
    preview: { text: block.text, bytes: block.bytes, maxBytes: MEMORY_BLOCK_MAX_BYTES, omitted: block.omitted },
  };
}

// ---- Lectura tolerante: se desconfía del disco, como en el resto de stores del servidor. ----

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeEntry(raw: unknown): MemoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.text !== "string" || !isMemoryKind(value.kind)) return null;
  if (value.status !== "pending" && value.status !== "active" && value.status !== "discarded") return null;
  return {
    id: value.id,
    text: value.text,
    kind: value.kind,
    source: typeof value.source === "string" ? value.source : "",
    createdAt: finiteOrZero(value.createdAt),
    updatedAt: finiteOrZero(value.updatedAt),
    status: value.status,
    uses: finiteOrZero(value.uses),
  };
}

function sanitizeSuggestion(raw: unknown): KbSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.text !== "string") return null;
  return { id: value.id, text: value.text, source: typeof value.source === "string" ? value.source : "", createdAt: finiteOrZero(value.createdAt) };
}

function sanitizeMemory(raw: unknown, repo: string): RepoMemory {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    repo,
    enabled: value.enabled !== false,
    entries: Array.isArray(value.entries) ? value.entries.flatMap((item) => { const clean = sanitizeEntry(item); return clean ? [clean] : []; }) : [],
    kbSuggestions: Array.isArray(value.kbSuggestions) ? value.kbSuggestions.flatMap((item) => { const clean = sanitizeSuggestion(item); return clean ? [clean] : []; }) : [],
  };
}

function defaultId(prefix: "m" | "k"): string {
  return `${prefix}_${randomBytes(3).toString("hex")}`;
}

export interface MemoryStoreOptions {
  directory?: string;
  listRepos?: () => string[];
  now?: () => number;
  newId?: (prefix: "m" | "k") => string;
}

/**
 * Store por repo. Cada operación relee el archivo (son pocos KB) para que el API, la destilación y la
 * inyección nunca trabajen sobre una copia rancia. Leer nunca escribe.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}) {
  const directory = options.directory ?? join(DATA_DIR, "memory");
  const repos = options.listRepos ?? listRepos;
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? defaultId;

  function knows(repo: string): boolean {
    return isStorableRepo(repo) && repos().includes(repo);
  }

  function fileFor(repo: string): string {
    if (!knows(repo)) throw new MemoryError("REPO_UNKNOWN", `el repositorio ${repo} no está configurado`, 404);
    return join(directory, `${repo}.json`);
  }

  function read(repo: string): RepoMemory {
    const file = fileFor(repo);
    try {
      return sanitizeMemory(JSON.parse(readFileSync(file, "utf8")), repo);
    } catch {
      return { repo, enabled: true, entries: [], kbSuggestions: [] };
    }
  }

  function save(memory: RepoMemory): RepoMemory {
    const file = fileFor(memory.repo);
    mkdirSync(directory, { recursive: true });
    writeJsonAtomic(file, memory);
    return memory;
  }

  function findEntry(memory: RepoMemory, id: string): MemoryEntry {
    const found = memory.entries.find((item) => item.id === id);
    if (!found) throw new MemoryError("MEMORY_NOT_FOUND", `no existe la entrada ${id}`, 404);
    return found;
  }

  /** Aprobar: `arquitectura` nunca queda activa, se va a las sugerencias para la KB. */
  function promote(memory: RepoMemory, item: MemoryEntry): void {
    const at = now();
    if (item.kind === "arquitectura") {
      memory.entries = memory.entries.filter((other) => other.id !== item.id);
      memory.kbSuggestions.push({ id: newId("k"), text: item.text, source: item.source, createdAt: at });
      return;
    }
    item.status = "active";
    item.updatedAt = at;
  }

  return {
    knows,
    read,

    setEnabled(repo: string, enabled: unknown): RepoMemory {
      const memory = read(repo);
      if (typeof enabled !== "boolean") throw new MemoryError("MEMORY_INVALID", "enabled debe ser true o false", 400);
      memory.enabled = enabled;
      return save(memory);
    },

    /** Alta manual: entra activa (o como sugerencia para la KB si es de arquitectura). */
    add(repo: string, raw: unknown, source = "manual"): RepoMemory {
      const memory = read(repo);
      const input = validateMemoryInput(raw);
      const at = now();
      if (input.kind === "arquitectura") {
        memory.kbSuggestions.push({ id: newId("k"), text: input.text, source, createdAt: at });
      } else {
        memory.entries.push({ id: newId("m"), text: input.text, kind: input.kind, source, createdAt: at, updatedAt: at, status: "active", uses: 0 });
      }
      return save(memory);
    },

    /**
     * Propuestas de la destilación: todo entra `pending`. Se limpian caracteres de control, se descartan
     * los textos vacíos y los duplicados (exactos o que sólo difieren en mayúsculas y espacios) contra
     * activas, pendientes, descartadas, sugerencias para la KB y la propia respuesta.
     */
    propose(repo: string, candidates: Array<{ text: string; kind: MemoryKind }>, source: string): MemoryEntry[] {
      const memory = read(repo);
      const seen = new Set([...memory.entries.map((item) => dedupeKey(item.text)), ...memory.kbSuggestions.map((item) => dedupeKey(item.text))]);
      const added: MemoryEntry[] = [];
      for (const candidate of candidates) {
        const text = normalizeMemoryText(candidate.text);
        const key = dedupeKey(text);
        if (!text || seen.has(key)) continue;
        seen.add(key);
        const at = now();
        const created: MemoryEntry = { id: newId("m"), text, kind: candidate.kind, source, createdAt: at, updatedAt: at, status: "pending", uses: 0 };
        memory.entries.push(created);
        added.push(created);
      }
      if (added.length) save(memory);
      return added;
    },

    resolve(repo: string, id: string, action: unknown, text?: unknown): RepoMemory {
      const memory = read(repo);
      if (action !== "approve" && action !== "discard" && action !== "edit") {
        throw new MemoryError("MEMORY_INVALID", "action debe ser approve, discard o edit", 400);
      }
      const item = findEntry(memory, id);
      if (action === "approve") {
        if (item.status !== "pending") throw new MemoryError("MEMORY_INVALID", "sólo se puede aprobar una entrada pendiente", 409);
        promote(memory, item);
      } else if (action === "discard") {
        if (item.status === "discarded") throw new MemoryError("MEMORY_INVALID", "la entrada ya está descartada", 409);
        item.status = "discarded";
        item.updatedAt = now();
      } else {
        if (item.status === "discarded") throw new MemoryError("MEMORY_INVALID", "no se puede editar una entrada descartada", 409);
        item.text = validateMemoryText(text);
        item.updatedAt = now();
        if (item.status === "pending") promote(memory, item);
      }
      return save(memory);
    },

    /** Borra una entrada (cualquier estado) o una sugerencia para la KB. */
    remove(repo: string, id: string): RepoMemory {
      const memory = read(repo);
      const entries = memory.entries.filter((item) => item.id !== id);
      const kbSuggestions = memory.kbSuggestions.filter((item) => item.id !== id);
      if (entries.length === memory.entries.length && kbSuggestions.length === memory.kbSuggestions.length) {
        throw new MemoryError("MEMORY_NOT_FOUND", `no existe la entrada ${id}`, 404);
      }
      return save({ ...memory, entries, kbSuggestions });
    },

    pending(repo?: string): PendingMemoryEntry[] {
      const targets = repo === undefined ? repos().filter(knows) : [repo];
      return targets.flatMap((target) => read(target).entries
        .filter((item) => item.status === "pending")
        .map((item) => ({ id: item.id, repo: target, text: item.text, kind: item.kind, source: item.source })));
    },

    /** Repo dueño de un id de entrada o de sugerencia; null si no existe en ninguno. */
    locate(id: string): string | null {
      for (const repo of repos().filter(knows)) {
        const memory = read(repo);
        if (memory.entries.some((item) => item.id === id) || memory.kbSuggestions.some((item) => item.id === id)) return repo;
      }
      return null;
    },

    markUsed(repo: string, ids: string[]): void {
      const memory = read(repo);
      let changed = false;
      for (const id of ids) {
        const item = memory.entries.find((candidate) => candidate.id === id);
        if (!item) continue;
        item.uses += 1;
        changed = true;
      }
      if (changed) save(memory);
    },

    dropKbSuggestions(repo: string, ids: string[]): void {
      const memory = read(repo);
      const kbSuggestions = memory.kbSuggestions.filter((item) => !ids.includes(item.id));
      if (kbSuggestions.length !== memory.kbSuggestions.length) save({ ...memory, kbSuggestions });
    },
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;

let sharedStore: MemoryStore | null = null;

/** Store de producción sobre <DATA_DIR>/memory. Crearlo no toca el disco. */
export function defaultMemoryStore(): MemoryStore {
  return (sharedStore ??= createMemoryStore());
}
