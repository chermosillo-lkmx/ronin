import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic.js";
import { dataPath } from "../data-dir.js";
import { InsightsError, type ProposalStatus, type WorkflowAnalysis, type WorkflowProposal } from "./model.js";

/**
 * Persistencia local de propuestas de workflow: `workflow-proposals.json`
 * `{ analyses: [], proposals: [] }`, mismo patrón que `test-harness/config.ts`
 * (`readJson` tolerante, `writeJsonAtomic`, copias vía `structuredClone`).
 */

interface Journal {
  analyses: WorkflowAnalysis[];
  proposals: WorkflowProposal[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function createProposalStore(directory: string = dataPath("")) {
  const file = join(directory, "workflow-proposals.json");

  function load(): Journal {
    const raw = readJson<Partial<Journal>>(file, {});
    return {
      analyses: Array.isArray(raw?.analyses) ? raw.analyses : [],
      proposals: Array.isArray(raw?.proposals) ? raw.proposals : [],
    };
  }

  let journal = load();

  function persist(): void {
    mkdirSync(directory, { recursive: true });
    writeJsonAtomic(file, journal);
  }

  function getAnalysis(id: string): WorkflowAnalysis | undefined {
    const found = journal.analyses.find((a) => a.id === id);
    return found ? clone(found) : undefined;
  }

  function upsertAnalysis(analysis: WorkflowAnalysis): void {
    const copy = clone(analysis);
    const i = journal.analyses.findIndex((a) => a.id === analysis.id);
    if (i >= 0) journal.analyses[i] = copy;
    else journal.analyses.push(copy);
    persist();
  }

  function listProposals(status?: ProposalStatus): WorkflowProposal[] {
    const all = status ? journal.proposals.filter((p) => p.status === status) : journal.proposals;
    return clone(all);
  }

  function getProposal(id: string): WorkflowProposal | undefined {
    const found = journal.proposals.find((p) => p.id === id);
    return found ? clone(found) : undefined;
  }

  function upsertProposal(proposal: WorkflowProposal): void {
    const copy = clone(proposal);
    const i = journal.proposals.findIndex((p) => p.id === proposal.id);
    if (i >= 0) journal.proposals[i] = copy;
    else journal.proposals.push(copy);
    persist();
  }

  function transition(id: string, to: "accepted" | "dismissed", catalogId?: string): WorkflowProposal {
    const i = journal.proposals.findIndex((p) => p.id === id);
    if (i < 0) throw new InsightsError(`propuesta "${id}" no encontrada`, "PROPOSAL_NOT_FOUND", 404);
    const current = journal.proposals[i];
    if (current.status !== "proposed") {
      throw new InsightsError(`propuesta "${id}" ya no está en estado "proposed"`, "PROPOSAL_NOT_PROPOSED", 409);
    }
    const next: WorkflowProposal = { ...current, status: to, ...(catalogId !== undefined ? { catalogId } : {}) };
    journal.proposals[i] = next;
    persist();
    return clone(next);
  }

  /** Re-lee disco (tests / edición manual). */
  function reload(): void {
    journal = load();
  }

  return {
    directory,
    getAnalysis,
    upsertAnalysis,
    listProposals,
    getProposal,
    upsertProposal,
    transition,
    reload,
  };
}

export type ProposalStore = ReturnType<typeof createProposalStore>;
