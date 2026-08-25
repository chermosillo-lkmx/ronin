import { randomBytes } from "node:crypto";
import { validateStages, type WorkflowConfig } from "../workflow.js";
import { InsightsError, type AnalysisRange, type WorkflowAnalysis, type WorkflowProposal } from "./model.js";
import { buildPrompt, extractProposalsJson } from "./prompt.js";
import type { Signals } from "./signals.js";
import type { ProposalStore } from "./store.js";

/**
 * Orquesta un análisis en background: señales → prompt → `claude -p` → propuestas.
 *
 * `start()` es SÍNCRONO a propósito: persiste el análisis `running` y devuelve su id de
 * inmediato para que la ruta HTTP conteste 202 sin esperar al modelo; `run()` corre suelto
 * y `waitFor()` (lista de waiters, igual que `test-harness/service.ts`) deja que los tests
 * — y cualquier llamador que sí quiera bloquear — esperen el desenlace sin sondear disco.
 *
 * Toda salida del modelo es NO CONFIABLE: cada propuesta se valida una por una y las que
 * no pasan se descartan con un motivo legible en vez de tumbar el análisis completo. El
 * único caso que marca `error` es un fallo global (claude falló, o la salida no traía JSON):
 * ahí no se persiste NINGUNA propuesta, porque un lote a medias no es un análisis.
 */

export interface AnalyzerDeps {
  store: ProposalStore;
  signals: (range: AnalysisRange) => Promise<Signals>;
  catalogNames: () => string[];
  runClaude: (prompt: string) => Promise<string>;
  now?: () => Date;
}

const RATIONALE_MAX = 400;
const EVIDENCE_MAX = 20;

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * Mismo slug que `workflow-catalog.ts` (el catálogo es quien decide si un nombre "ya existe",
 * así que el nombre propuesto tiene que normalizarse igual) pero quitando primero los
 * diacríticos: sin esto "Hotfix Rápido" caería en "hotfix-r-pido", porque la "á" no está en
 * [a-z0-9] y el regex la convierte en guion.
 */
function slugName(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function proposalsOf(parsed: unknown): unknown[] {
  const list = (parsed as { proposals?: unknown } | null)?.proposals;
  return Array.isArray(list) ? list : [];
}

function countSignals(signals: Signals): WorkflowAnalysis["signals"] {
  const commits = Object.values(signals.commits ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
  return { tasks: signals.tasks.length, commits, evidenceFiles: signals.evidence.length };
}

export function createAnalyzer(deps: AnalyzerDeps) {
  const { store, signals, catalogNames, runClaude } = deps;
  const now = deps.now ?? (() => new Date());
  const waiters = new Map<string, Array<() => void>>();

  function settle(id: string): void {
    const list = waiters.get(id) ?? [];
    waiters.delete(id);
    for (const w of list) w();
  }

  function finish(analysis: WorkflowAnalysis): void {
    store.upsertAnalysis(analysis);
    settle(analysis.id);
  }

  /**
   * Valida el lote COMPLETO antes de tocar el store: si algo revienta a mitad de camino
   * (p. ej. el store falla al escribir) no queremos un análisis `error` con propuestas
   * huérfanas ya persistidas.
   */
  function review(analysisId: string, raw: unknown[], createdAt: string): { proposals: WorkflowProposal[]; discarded: WorkflowAnalysis["discarded"] } {
    const proposals: WorkflowProposal[] = [];
    const discarded: WorkflowAnalysis["discarded"] = [];
    const taken = new Set(catalogNames().map(slugName).filter(Boolean));

    for (const candidate of raw) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        discarded.push({ reason: "propuesta inválida: se esperaba un objeto" });
        continue;
      }
      const entry = candidate as Record<string, unknown>;
      const name = slugName(entry.name);
      if (!name) {
        discarded.push({ reason: "nombre vacío" });
        continue;
      }
      if (taken.has(name)) {
        discarded.push({ name, reason: `un workflow llamado "${name}" ya existe` });
        continue;
      }
      let config;
      try {
        config = validateStages((entry.config ?? {}) as Partial<WorkflowConfig>, { strict: true });
      } catch (e) {
        discarded.push({ name, reason: (e as Error).message });
        continue;
      }
      taken.add(name);
      proposals.push({
        id: newId("prop"),
        analysisId,
        name,
        rationale: String(entry.rationale ?? "").slice(0, RATIONALE_MAX),
        evidence: (Array.isArray(entry.evidence) ? entry.evidence : []).filter((e): e is string => typeof e === "string").slice(0, EVIDENCE_MAX),
        config,
        status: "proposed",
        createdAt,
      });
    }
    return { proposals, discarded };
  }

  async function run(analysis: WorkflowAnalysis): Promise<void> {
    try {
      const collected = await signals({ from: new Date(analysis.from), to: new Date(analysis.to) });
      const parsed = extractProposalsJson(await runClaude(buildPrompt(collected, catalogNames())));
      const { proposals, discarded } = review(analysis.id, proposalsOf(parsed), now().toISOString());
      for (const proposal of proposals) store.upsertProposal(proposal);
      finish({
        ...analysis,
        status: "done",
        finishedAt: now().toISOString(),
        proposalIds: proposals.map((p) => p.id),
        discarded,
        signals: countSignals(collected),
      });
    } catch (e) {
      finish({ ...analysis, status: "error", finishedAt: now().toISOString(), error: (e as Error).message });
    }
  }

  function start(range: AnalysisRange): string {
    const analysis: WorkflowAnalysis = {
      id: newId("an"),
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      status: "running",
      createdAt: now().toISOString(),
      proposalIds: [],
      discarded: [],
      signals: { tasks: 0, commits: 0, evidenceFiles: 0 },
    };
    store.upsertAnalysis(analysis);
    void run(analysis);
    return analysis.id;
  }

  function waitFor(id: string): Promise<void> {
    const analysis = store.getAnalysis(id);
    if (!analysis) return Promise.reject(new InsightsError(`análisis desconocido: ${id}`, "ANALYSIS_NOT_FOUND", 404));
    if (analysis.status !== "running") return Promise.resolve();
    return new Promise((resolveWait) => {
      const list = waiters.get(id) ?? [];
      list.push(resolveWait);
      waiters.set(id, list);
    });
  }

  return { start, waitFor };
}

export type Analyzer = ReturnType<typeof createAnalyzer>;
