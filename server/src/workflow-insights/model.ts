import type { WorkflowConfig } from "../workflow.js";

export type ProposalStatus = "proposed" | "accepted" | "dismissed";

export interface WorkflowProposal {
  id: string;
  analysisId: string;
  name: string;
  rationale: string;
  evidence: string[];
  config: WorkflowConfig;
  status: ProposalStatus;
  createdAt: string;
  catalogId?: string;
}

export interface WorkflowAnalysis {
  id: string;
  from: string;
  to: string;
  status: "running" | "done" | "error";
  createdAt: string;
  finishedAt?: string;
  proposalIds: string[];
  discarded: { name?: string; reason: string }[];
  error?: string;
  signals: { tasks: number; commits: number; evidenceFiles: number };
}

export interface AnalysisRange {
  from: Date;
  to: Date;
}

export class InsightsError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "InsightsError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SPAN_DAYS = 14;
const MAX_SPAN_DAYS = 120;

function parseDate(value: unknown, field: string): Date {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new InsightsError(`"${field}" inválido: se esperaba una fecha ISO`, "INVALID_RANGE", 400);
  }
  return date;
}

/** from/to ISO opcionales; default to=ahora, from=to-14d; from<to obligatorio; máximo 120 días. */
export function parseRange(input: { from?: unknown; to?: unknown }, now: Date = new Date()): AnalysisRange {
  const to = input.to !== undefined ? parseDate(input.to, "to") : now;
  const from = input.from !== undefined ? parseDate(input.from, "from") : new Date(to.getTime() - DEFAULT_SPAN_DAYS * DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw new InsightsError('rango inválido: "from" debe ser anterior a "to"', "INVALID_RANGE", 400);
  }
  if (to.getTime() - from.getTime() > MAX_SPAN_DAYS * DAY_MS) {
    throw new InsightsError(`rango inválido: máximo ${MAX_SPAN_DAYS} días`, "INVALID_RANGE", 400);
  }

  return { from, to };
}
