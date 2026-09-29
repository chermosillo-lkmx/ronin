import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMemoryKind, MAX_DISTILLED_ENTRIES, MEMORY_TEXT_MAX_CHARS, type MemoryEntry, type MemoryKind } from "./memory.js";
import { getPromptTemplate, renderPrompt } from "./prompts.js";
import { evidenceDir, readCycleRepo, readEvidence } from "./stages.js";

/**
 * Entrada y salida de la destilación de memoria (spec §5). Todo es puro o de sólo lectura: el
 * ejecutor, la cola y el estado viven en memory-distiller.ts.
 */

/** Tope de la evidencia que va al prompt, en bytes UTF-8. */
export const DISTILL_EVIDENCE_MAX_BYTES = 24 * 1024;
/** Respuestas del usuario que entran al prompt (las más recientes). */
export const DISTILL_MAX_REPLIES = 20;

export interface DistillSources {
  summary: string | null;
  research: string | null;
  verdict: string | null;
  plan: string | null;
  tests: string | null;
}

const SOURCES: Array<{ key: keyof DistillSources; label: string }> = [
  { key: "summary", label: "evidence/summary.md" },
  { key: "research", label: "evidence/research.md" },
  { key: "verdict", label: "evidence/verdict.md" },
  { key: "plan", label: "plan.md" },
  { key: "tests", label: "evidence/tests.md" },
];

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Evidencia del ciclo (summary, research, verdict), el plan (`<cycle>/plan.md`) y el resumen de pruebas. */
export function readDistillSources(cycle: string): DistillSources {
  const evidence = readEvidence(cycle);
  return {
    summary: evidence.summary,
    research: evidence.research,
    verdict: evidence.verdict,
    plan: readIfExists(join(cycle, "plan.md")),
    tests: readIfExists(join(evidenceDir(cycle), "tests.md")),
  };
}

export function hasEvidence(sources: DistillSources): boolean {
  return SOURCES.some(({ key }) => Boolean(sources[key]?.trim()));
}

/** Los últimos `maxBytes` bytes de un texto, sin dejar un carácter multibyte partido al inicio. */
export function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  if (maxBytes <= 0) return "";
  return buffer.subarray(buffer.length - maxBytes).toString("utf8").replace(/^�+/, "");
}

/**
 * Evidencia para el prompt, con 24 KB como máximo en total. Cada archivo conserva su FINAL (ahí
 * están las conclusiones). El presupuesto se reparte de menor a mayor: un archivo corto cede lo que
 * no usa a los largos.
 */
export function buildEvidence(sources: DistillSources, maxBytes = DISTILL_EVIDENCE_MAX_BYTES): string {
  const present = SOURCES.flatMap(({ key, label }) => {
    const body = sources[key]?.trim();
    return body ? [{ header: `### ${label}\n`, body }] : [];
  });
  if (!present.length) return "";
  const overhead = present.reduce((sum, part) => sum + Buffer.byteLength(part.header, "utf8"), 0) + (present.length - 1) * 2;
  let budget = Math.max(0, maxBytes - overhead);
  const bodies = new Map<(typeof present)[number], string>();
  const bySize = [...present].sort((a, b) => Buffer.byteLength(a.body, "utf8") - Buffer.byteLength(b.body, "utf8"));
  bySize.forEach((part, index) => {
    const body = tailBytes(part.body, Math.floor(budget / (bySize.length - index)));
    bodies.set(part, body);
    budget -= Buffer.byteLength(body, "utf8");
  });
  return present.map((part) => part.header + bodies.get(part)).join("\n\n");
}

export interface CycleLaunch {
  repo: string | null;
  request: string;
  workflow: string;
}

/** Petición y workflow registrados al lanzar; una sesión adoptada no tiene launch.json y queda vacía. */
export function readCycleLaunch(cycle: string): CycleLaunch {
  let raw: { request?: unknown; workflowName?: unknown } = {};
  try {
    raw = JSON.parse(readFileSync(join(cycle, "launch.json"), "utf8")) ?? {};
  } catch {
    /* sesión adoptada o lanzamiento sin registro */
  }
  return {
    repo: readCycleRepo(cycle),
    request: typeof raw.request === "string" ? raw.request : "",
    workflow: typeof raw.workflowName === "string" ? raw.workflowName : "",
  };
}

export interface DistillPromptInput {
  repo: string;
  session: string;
  workflow: string;
  request: string;
  evidence: string;
  replies: string[];
  /** Memoria actual; sólo se usan las activas y las descartadas. */
  known: MemoryEntry[];
}

export function buildDistillPrompt(input: DistillPromptInput, template = getPromptTemplate("memory")): string {
  const replies = input.replies
    .slice(-DISTILL_MAX_REPLIES)
    .map((reply) => reply.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((reply) => `- ${reply}`);
  const known = input.known
    .filter((item) => item.status === "active" || item.status === "discarded")
    .map((item) => `- [${item.kind}] ${item.text}${item.status === "discarded" ? " (descartada)" : ""}`);
  return renderPrompt(template, {
    repo: input.repo,
    session: input.session,
    workflow: input.workflow || "(sin workflow registrado)",
    request: input.request.trim() || "(sin petición registrada)",
    evidence: input.evidence,
    replies: replies.length ? replies.join("\n") : "(ninguna)",
    known: known.length ? known.join("\n") : "(vacía)",
  });
}

export interface DistillCandidate {
  text: string;
  kind: MemoryKind;
}

function extractJsonObject(stdout: string): unknown {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("la salida no contiene JSON");
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new Error("la salida no es JSON válido");
  }
}

/**
 * Salida NO confiable de `claude -p`: `{ entries: Array<{ text: 1..200, kind: enum }> }` con 5 entradas
 * como máximo. Si algo no cumple, se descarta la respuesta completa (lanza). La limpieza de caracteres
 * de control y la deduplicación las hace el store al proponer.
 */
export function parseDistillOutput(stdout: string): DistillCandidate[] {
  const raw = extractJsonObject(stdout);
  const entries = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { entries?: unknown }).entries : undefined;
  if (!Array.isArray(entries)) throw new Error("la salida no cumple el esquema: entries debe ser una lista");
  if (entries.length > MAX_DISTILLED_ENTRIES) throw new Error(`la salida no cumple el esquema: más de ${MAX_DISTILLED_ENTRIES} entradas`);
  return entries.map((item, index) => {
    const { text, kind } = (item && typeof item === "object" ? item : {}) as { text?: unknown; kind?: unknown };
    if (typeof text !== "string" || text.length < 1 || text.length > MEMORY_TEXT_MAX_CHARS) {
      throw new Error(`la salida no cumple el esquema: la entrada ${index + 1} debe tener un text de 1 a ${MEMORY_TEXT_MAX_CHARS} caracteres`);
    }
    if (!isMemoryKind(kind)) throw new Error(`la salida no cumple el esquema: la entrada ${index + 1} tiene un kind inválido`);
    return { text, kind };
  });
}
