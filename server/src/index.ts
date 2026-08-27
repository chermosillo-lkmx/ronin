import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PORT, REPORT_SCHEDULE } from "./config.js";
import { adoptSession, releaseAdoption } from "./engine.js";
import { AdoptCommitError, AdoptValidationError, type AdoptErrorCode } from "./adopt.js";
import {
  capturePaneAnsi,
  focusSessionPane,
  hasSession,
  killSession,
  listSessionPaneIds,
  paneMembership,
  parsePaneRoleParam,
  pastePrompt,
  readAdoptedMark,
  readPaneGeometry,
  sendText,
  serializePerSession,
  openTerminal,
  PASTE_THRESHOLD_BYTES,
} from "./tmux.js";
import { classifySession } from "./sessions.js";
import { isSafeSessionName } from "./session-name.js";
import { readHistory, recordEvent } from "./history.js";
import { generateReport, listReports, readReport, BadRequest } from "./reports.js";
import { startReportSchedule } from "./report-schedule.js";
import { cycleDirForSession } from "./stages.js";
import { startTtyd } from "./ttyd.js";
import { getWorkflow, saveWorkflow, validateStages, WorkflowValidationError, type WorkflowConfig } from "./workflow.js";
import { createWorkflowCatalogItem, deleteWorkflowCatalogItem, importWorkflowCatalogItem, loadWorkflowCatalog, updateWorkflowCatalogItem } from "./workflow-catalog.js";
import { readPromptConfig, resetPromptTemplate, savePromptTemplate } from "./prompts.js";
import { listRepos, readRepoConfig, saveRepoConfig } from "./repos.js";
import { readRepoConfigFull, saveRepoOverrides } from "./repo-config.js";
import { saveAllowedRoots } from "./settings.js";
import { trustedRoots } from "./repo-roots.js";
import { ensureCapabilityToken, requireCapability } from "./capability.js";
import { constantTimeEqual, corsOptions, requireLocalOrigin } from "./security.js";
import { runPreflight } from "./preflight.js";
import { listAllSessions, readTmuxInventory } from "./sessions.js";
import { launchManagedSession, SessionLaunchError } from "./session-launch.js";
import { createSessionPresentationStore, SessionPresentationError } from "./session-presentation.js";
import { archiveSkill, createSkill, listSkills, readSkill, SkillError, updateSkill } from "./skills.js";
import { dataPath } from "./data-dir.js";
import { createHarnessStore } from "./test-harness/config.js";
import { HarnessValidationError, parseSelection } from "./test-harness/model.js";
import { createTestHarnessService, HarnessError, type TestHarnessService } from "./test-harness/service.js";
import { runClaudeP } from "./claude-p.js";
import { createAnalyzer, type Analyzer } from "./workflow-insights/analyzer.js";
import { InsightsError, parseRange, type ProposalStatus } from "./workflow-insights/model.js";
import { collectSignals, defaultSignalDeps } from "./workflow-insights/signals.js";
import { createProposalStore, type ProposalStore } from "./workflow-insights/store.js";

/** T11: an invalid workflow gets an actionable {path, code} alongside the message; any other
 *  thrown error keeps the plain {error} shape every other 400 in this file already uses. */
function workflowErrorBody(e: unknown): { error: string; path?: string; code?: string } {
  if (e instanceof WorkflowValidationError) return { error: e.message, path: e.path, code: e.code };
  return { error: (e as Error).message };
}

/** T12: /validate routes — same strict validateStages as a save, but never persist. */
function respondValidate(res: express.Response, build: () => ReturnType<typeof validateStages>): void {
  try {
    res.json({ ok: true, config: build() });
  } catch (e) {
    const path = e instanceof WorkflowValidationError ? e.path : "";
    const code = e instanceof WorkflowValidationError ? e.code : "INVALID";
    res.status(400).json({ ok: false, error: { path, code, message: (e as Error).message } });
  }
}

/** Workflow insights: los errores tipados ya traen status + code; cualquier otro es un 500. */
function respondInsightsError(res: express.Response, e: unknown): void {
  const status = e instanceof InsightsError ? e.status : 500;
  const code = e instanceof InsightsError ? e.code : "INTERNAL";
  res.status(status).json({ error: (e as Error).message, code });
}

function isProposalStatus(value: unknown): value is ProposalStatus {
  return value === "proposed" || value === "accepted" || value === "dismissed";
}

export interface CreateAppOptions {
  adoptSession?: typeof adoptSession;
  /** Seams de tests HTTP; producción usa settings.json + la política efectiva. */
  trustedRoots?: {
    read: () => { roots: string[]; source: "env" | "settings" };
    save: (input: unknown) => { roots: string[]; source: "settings" };
  };
  /** Inyección para tests: un harness con store aislado. Por defecto usa server/data. */
  harness?: TestHarnessService;
  /**
   * Inyección para tests: store + analyzer de workflow insights aislados. `catalogDirectory`
   * redirige el catálogo que leen las propuestas y en el que escribe `accept`, para que un
   * test nunca toque `server/data/workflows.json`.
   */
  insights?: { store: ProposalStore; analyzer: Analyzer; catalogDirectory?: string };
  /** Catálogo aislado para pruebas HTTP; por defecto usa server/data/workflows.json. */
  catalogDirectory?: string;
  /** Dependencias de terminal de sesión aislables: evitan arrancar ttyd/Terminal.app en tests HTTP. */
  terminal?: {
    hasSession?: typeof hasSession;
    startTtyd?: typeof startTtyd;
    openTerminal?: typeof openTerminal;
  };
  /** Seams del lanzamiento gestionado y el inventario para pruebas HTTP sin tmux. */
  launchManagedSession?: typeof launchManagedSession;
  readTmuxInventory?: typeof readTmuxInventory;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
const app = express();
const harness = options.harness ?? createTestHarnessService({ store: createHarnessStore() });
const catalogDirectory = options.catalogDirectory ?? options.insights?.catalogDirectory;
const insightsStore = options.insights?.store ?? createProposalStore();
const analyzer =
  options.insights?.analyzer ??
  createAnalyzer({
    store: insightsStore,
    signals: (range) => collectSignals(range, defaultSignalDeps),
    catalogNames: () => loadWorkflowCatalog(catalogDirectory).items.map((item) => item.name),
    runClaude: (prompt) => runClaudeP(prompt, { timeoutMs: 300_000, maxBytes: 256 * 1024 }),
  });
const sessionPresentations = createSessionPresentationStore(dataPath("session-presentations.json"), listRepos);
const terminal = {
  hasSession: options.terminal?.hasSession ?? hasSession,
  startTtyd: options.terminal?.startTtyd ?? startTtyd,
  openTerminal: options.terminal?.openTerminal ?? openTerminal,
};
const performLaunchManagedSession = options.launchManagedSession ?? launchManagedSession;
const readInventory = options.readTmuxInventory ?? readTmuxInventory;
const trustedRootsApi = options.trustedRoots ?? {
  read: () => ({ roots: trustedRoots(), source: process.env.COWORK_ALLOWED_ROOTS !== undefined ? "env" as const : "settings" as const }),
  save: (input: unknown) => {
    saveAllowedRoots(input);
    return { roots: trustedRoots(), source: "settings" as const };
  },
};
const performAdoptSession = options.adoptSession ?? adoptSession;
app.use(cors(corsOptions));
// Los tres guards van ANTES de express.json(): no hay razón para parsear el cuerpo de una
// petición que vamos a rechazar. Cubren TODO /api, incluidos sus OPTIONS.
app.use("/api", requireLocalOrigin);
// Puerta general: por MÉTODO, no enumerando rutas — GET/HEAD/OPTIONS pasan sin mirar nada
// (requireCapability.ts), todo lo demás exige `X-Ronin-Capability` en tiempo constante.
app.use("/api", requireCapability);
app.use(express.json());
// P12: /api/health publicaba el boot token en el cuerpo (el supervisor lo comparaba
// contra el suyo), así que cualquier proceso local podía leerlo sin credencial.
// El supervisor YA conoce el token (lo generó él y lo inyectó por env, backend-supervisor.ts:229):
// que lo PRESENTE por cabecera y el server sólo confirme el match, en vez de que el
// server lo publique, conserva la misma identidad mutua con cero divulgación.
app.get("/api/health", (req, res) => {
  const expected = process.env.COWORK_DESKTOP_BOOT_TOKEN?.trim() || "";
  const presented = req.get("x-ronin-boot-token") ?? "";
  const tokenOk = constantTimeEqual(expected, presented);
  res.json({ version: 1, ok: true, service: "ronin-api", tokenOk });
});


// Repo keys the custom-request modal can target (folder is resolved server-side)
app.get("/api/repos", (_req, res) => {
  res.json({ repos: listRepos() });
});

// Read / edit the repo→folder map (data/repos.json) from the settings UI
app.get("/api/repos-config", (_req, res) => {
  res.json(readRepoConfig());
});
app.put("/api/repos-config", (req, res) => {
  try {
    res.json(saveRepoConfig({ defaultPath: req.body?.defaultPath, repos: req.body?.repos }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get("/api/trusted-roots", (_req, res) => {
  res.json(trustedRootsApi.read());
});
app.put("/api/trusted-roots", (req, res) => {
  if (process.env.COWORK_ALLOWED_ROOTS !== undefined) {
    return res.status(409).json({ error: "COWORK_ALLOWED_ROOTS definida: las raíces se gestionan por entorno", code: "ROOTS_FROM_ENV" });
  }
  try {
    res.json(trustedRootsApi.save(req.body?.roots));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// Read / edit a repo's workflow override + vars + startCommand (data/repo-config.json)
app.get("/api/repo-config/:repo", (req, res) => {
  res.json(readRepoConfigFull(req.params.repo));
});
app.put("/api/repo-config/:repo", (req, res) => {
  try {
    const repo = req.params.repo;
    const body = req.body ?? {};
    res.json(saveRepoOverrides(repo, body));
  } catch (e) {
    res.status(400).json(workflowErrorBody(e));
  }
});
// T12: trial-validate a repo override's workflow (strict, verifyCmd ALLOWED — gitignored,
// same trust boundary as a real save) WITHOUT writing repo-config.json.
app.post("/api/repo-config/:repo/validate", (req, res) => {
  respondValidate(res, () => validateStages((req.body?.workflow as any) ?? {}, { allowVerifyCmd: true, strict: true }));
});

function skillRefFromRequest(source: Record<string, unknown>) {
  return {
    root: source.root as "global" | "repo-claude" | "repo-skills" | undefined,
    name: typeof source.name === "string" ? source.name : undefined,
    sourceRepo: typeof source.sourceRepo === "string" ? source.sourceRepo : undefined,
  };
}
function respondSkillError(res: express.Response, error: unknown): void {
  if (error instanceof SkillError) res.status(400).json({ error: error.message, code: error.code });
  else res.status(500).json({ error: "no se pudo operar la skill" });
}

// Local SKILL.md discovery/editor. Each reference includes its root (and sourceRepo for
// repository roots), so identical skill names never resolve ambiguously.
app.get("/api/skills", (_req, res) => {
  res.json({ skills: listSkills(listRepos()) });
});
app.get("/api/skills/read", (req, res) => {
  try { res.json(readSkill(skillRefFromRequest(req.query))); }
  catch (e) { respondSkillError(res, e); }
});
app.post("/api/skills", (req, res) => {
  try { res.status(201).json(createSkill(skillRefFromRequest(req.body ?? {}), String(req.body?.content ?? ""))); }
  catch (e) { respondSkillError(res, e); }
});
app.put("/api/skills", (req, res) => {
  try { res.json(updateSkill(skillRefFromRequest(req.body ?? {}), String(req.body?.content ?? ""))); }
  catch (e) { respondSkillError(res, e); }
});
app.get("/api/skills/archive", async (req, res) => {
  try {
    const archive = await archiveSkill(skillRefFromRequest(req.query));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
    res.send(archive.bytes);
  } catch (e) { respondSkillError(res, e); }
});
app.put("/api/repo-config/:repo/skills", (req, res) => {
  try {
    const repo = req.params.repo;
    const current = readRepoConfigFull(repo);
    // This route has no workflow/prompt side effect: only the persisted association changes.
    const saved = saveRepoOverrides(repo, {
      inheritWorkflow: current.usesDefaultWorkflow,
      workflow: current.workflow ?? undefined,
      vars: current.vars,
      startCommand: current.startCommand,
      plannerModel: current.plannerModel,
      workerModel: current.workerModel,
      skills: req.body?.skills,
    });
    res.json(saved);
  } catch (e) { res.status(400).json(workflowErrorBody(e)); }
});


// Read / edit the composable workflow (data/workflow.json)
app.get("/api/workflow", (_req, res) => {
  res.json(getWorkflow());
});
app.put("/api/workflow", (req, res) => {
  try {
    const input = { stages: req.body?.stages, verifyAfter: req.body?.verifyAfter ?? null };
    res.json(saveWorkflow(input));
  } catch (e) {
    res.status(400).json(workflowErrorBody(e));
  }
});
// T12: trial-validate the GLOBAL workflow (strict, verifyCmd NOT allowed — git-tracked, same
// rule as a real save) WITHOUT writing workflow.json or emitting a snapshot change.
app.post("/api/workflow/validate", (req, res) => {
  respondValidate(res, () => validateStages({ stages: req.body?.stages, verifyAfter: req.body?.verifyAfter ?? null }, { strict: true }));
});

// Named workflows back the Electron shell. The legacy singular route above remains available
// for the browser dashboard and is intentionally not coupled to a catalog item's immutable id.
app.get("/api/workflows", (_req, res) => {
  res.json(loadWorkflowCatalog(catalogDirectory));
});
app.post("/api/workflows", (req, res) => {
  try {
    res.status(201).json(createWorkflowCatalogItem(req.body?.name, req.body?.config ?? req.body, catalogDirectory));
  } catch (e) {
    res.status(400).json(workflowErrorBody(e));
  }
});
app.put("/api/workflows/:id", (req, res) => {
  try {
    const item = updateWorkflowCatalogItem(req.params.id, { name: req.body?.name, config: req.body?.config }, catalogDirectory);
    res.json(item);
  } catch (e) {
    const status = (e as Error).message === "WORKFLOW_NOT_FOUND" ? 404 : 400;
    res.status(status).json(workflowErrorBody(e));
  }
});
// Las sesiones ya creadas conservan su copia congelada en flow.json; borrar del catálogo no las afecta.
app.delete("/api/workflows/:id", (req, res) => {
  try {
    deleteWorkflowCatalogItem(req.params.id, catalogDirectory);
    res.json({ ok: true });
  } catch (e) {
    const code = (e as Error).message;
    if (code === "WORKFLOW_NOT_FOUND") return res.status(404).json({ error: code, code });
    if (code === "WORKFLOW_LAST") return res.status(409).json({ error: "no se puede eliminar el único workflow", code });
    res.status(400).json(workflowErrorBody(e));
  }
});
app.post("/api/workflows/import", (req, res) => {
  try {
    res.status(201).json(importWorkflowCatalogItem(req.body?.name, req.body?.config ?? req.body, catalogDirectory));
  } catch (e) {
    res.status(400).json(workflowErrorBody(e));
  }
});

// ---- Workflow insights: analizar el trabajo reciente y proponer workflows nuevos ----
// Rutas literales (`analyze`, `analyses/:id`, `proposals/…`) montadas JUNTAS y después de
// `/import`: el único parámetro hermano es `PUT /api/workflows/:id`, que no puede capturarlas
// por método, pero mantenerlas agrupadas evita que un futuro `GET /api/workflows/:id` las coma.

// `analyzer.start()` sólo persiste el análisis `running` y devuelve su id: el modelo corre
// suelto, así que la ruta contesta 202 y el cliente sondea `/analyses/:id`.
app.post("/api/workflows/analyze", (req, res) => {
  try {
    res.status(202).json({ analysisId: analyzer.start(parseRange(req.body ?? {})) });
  } catch (e) {
    respondInsightsError(res, e);
  }
});

app.get("/api/workflows/analyses/:id", (req, res) => {
  const analysis = insightsStore.getAnalysis(req.params.id);
  if (!analysis) {
    res.status(404).json({ error: "análisis no encontrado", code: "ANALYSIS_NOT_FOUND" });
    return;
  }
  res.json(analysis);
});

app.get("/api/workflows/proposals", (req, res) => {
  const status = req.query.status;
  if (status !== undefined && !isProposalStatus(status)) {
    res.status(400).json({ error: `status "${String(status)}" inválido: proposed|accepted|dismissed`, code: "INVALID_STATUS" });
    return;
  }
  res.json(insightsStore.listProposals(status));
});

// Aceptar = materializar la propuesta en el catálogo. El 409 se comprueba ANTES de escribir el
// catálogo: reaceptar una propuesta ya aceptada debe chocar con su estado, no crear un segundo
// item ni disfrazarse de 400 WORKFLOW_NAME_EXISTS. El nombre del cuerpo permite renombrarla al
// aceptar (el catálogo revalida y rechaza duplicados con su propio 400).
app.post("/api/workflows/proposals/:id/accept", (req, res) => {
  const proposal = insightsStore.getProposal(req.params.id);
  if (!proposal) {
    res.status(404).json({ error: `propuesta "${req.params.id}" no encontrada`, code: "PROPOSAL_NOT_FOUND" });
    return;
  }
  if (proposal.status !== "proposed") {
    res.status(409).json({ error: `propuesta "${proposal.id}" ya no está en estado "proposed"`, code: "PROPOSAL_NOT_PROPOSED" });
    return;
  }
  let item;
  try {
    item = createWorkflowCatalogItem(req.body?.name ?? proposal.name, proposal.config, catalogDirectory);
  } catch (e) {
    res.status(400).json(workflowErrorBody(e));
    return;
  }
  try {
    // El item ya está en disco: si la transición falla, se reporta el error real en vez de un
    // 201 mentiroso — la propuesta sigue `proposed` y reintentar chocará con WORKFLOW_NAME_EXISTS,
    // que es visible, en vez de dejar el catálogo y el journal en desacuerdo en silencio.
    insightsStore.transition(proposal.id, "accepted", item.id);
  } catch (e) {
    respondInsightsError(res, e);
    return;
  }
  res.status(201).json(item);
});

app.post("/api/workflows/proposals/:id/dismiss", (req, res) => {
  try {
    res.json(insightsStore.transition(req.params.id, "dismissed"));
  } catch (e) {
    respondInsightsError(res, e);
  }
});

// Read / edit las plantillas de prompt editables (data/prompts.json). Bare JSON,
// como /api/workflow. Sin emit(): los prompts no forman parte de Snapshot y aplican
// al próximo launch. key inválida → 400 (savePromptTemplate/reset lanzan).
app.get("/api/prompts", (_req, res) => {
  res.json(readPromptConfig());
});
app.put("/api/prompts/:key", (req, res) => {
  try {
    res.json(savePromptTemplate(req.params.key, String(req.body?.template ?? "")));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.post("/api/prompts/:key/reset", (req, res) => {
  try {
    res.json(resetPromptTemplate(req.params.key));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});


app.get("/api/sessions", async (_req, res) => {
  const inventory = await readInventory();
  const presentations = sessionPresentations.list(inventory.sessions.map((session) => session.name));
  res.json({
    ...inventory,
    sessions: inventory.sessions.map((session) => presentations[session.name]
      ? { ...session, presentation: presentations[session.name] }
      : session),
  });
});

// Electron's "Nueva sesión" only accepts a configured repo and managed session name. The
// server owns cwd, shell command, workflow branch/worktree, and the allowed normal CLI agents.
app.post("/api/sessions", async (req, res) => {
  try {
    const rawRequest = req.body?.request;
    const request = typeof rawRequest === "string" ? rawRequest.replace(/\0/g, "").trim() : undefined;
    if (request && Buffer.byteLength(request, "utf8") > 8 * 1024) {
      return res.status(400).json({ error: "la petición no puede superar 8 KB", code: "REQUEST_TOO_LONG" });
    }
    const launched = await performLaunchManagedSession({
      repo: String(req.body?.repo ?? ""),
      workflowId: String(req.body?.workflowId ?? ""),
      name: String(req.body?.name ?? ""),
      mode: req.body?.mode,
      agent: req.body?.agent,
      request,
    });
    const inventory = await readInventory();
    const session = inventory.sessions.find((item) => item.name === launched.name) ?? null;
    res.status(201).json({ ...launched, session, diagnostic: inventory.diagnostic });
  } catch (e) {
    if (e instanceof SessionLaunchError) {
      const status = e.code === "SESSION_ALREADY_EXISTS" ? 409 : e.code === "WORKFLOW_NOT_FOUND" ? 404 : 400;
      return void res.status(status).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: "no se pudo crear la sesión" });
  }
});

// Cierra exactamente la sesión indicada. El gesto de confirmación se valida también aquí: el
// renderer puede estar desactualizado, pero no puede convertir un DELETE accidental en un kill.
// Sólo mata tmux; evidencia, worktrees y metadata existentes se preservan para no borrar datos
// de trabajo como efecto lateral de cerrar una terminal.
app.delete("/api/sessions/:name", async (req, res) => {
  const { name } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (req.body?.confirm !== true) return res.status(400).json({ error: "confirmación requerida", code: "CONFIRMATION_REQUIRED" });
  if (!(await hasSession(name))) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  await killSession(name);
  recordEvent({ type: "close", key: name, title: name, repo: "", source: "session" });
  res.json({ ok: true });
});

// Superficie ttyd de una sesión tmux: verificamos nombre y existencia antes de arrancar procesos.
app.post("/api/sessions/:name/term", async (req, res) => {
  const { name } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (!(await terminal.hasSession(name))) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  const port = await terminal.startTtyd(name);
  if (port === null) return res.status(503).json({ error: "ttyd no pudo reservar un puerto propio; no se devolvió ninguna terminal", code: "TTYD_UNAVAILABLE" });
  res.json({ url: `http://127.0.0.1:${port}` });
});

// Attach conserva la vía nativa para quien necesita una Terminal.app independiente.
app.post("/api/sessions/:name/attach", async (req, res) => {
  const { name } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (!(await terminal.hasSession(name))) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  await terminal.openTerminal(name);
  res.json({ ok: true });
});

// La etiqueta es metadata local: título y repo para operar la lista, sin `rename-session`.
// Así worktrees, evidencias y workflows que se indexan por el nombre técnico siguen estables.
app.put("/api/sessions/:name/presentation", async (req, res) => {
  const { name } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (!(await hasSession(name))) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  try {
    res.json(sessionPresentations.save(name, { title: req.body?.title, repo: req.body?.repo }));
  } catch (error) {
    if (error instanceof SessionPresentationError) return res.status(400).json({ error: error.code, code: error.code });
    res.status(500).json({ error: "no se pudo guardar la etiqueta de sesión", code: "SESSION_PRESENTATION_FAILED" });
  }
});

// F2/T4 — Adopción segura de una sesión ajena. `confirm`+`expectedSessionCreatedAt` son la
// aserción de estado verificable en servidor (B3): un curl a ciegas no los tiene, y una UI
// rancia falla en vez de adoptar algo distinto de lo que se mostró.
function adoptErrorStatus(code: AdoptErrorCode): number {
  switch (code) {
    case "SESSION_NOT_FOUND":
      return 404;
    case "STALE_VIEW":
    case "ALREADY_MANAGED":
    case "PANE_AMBIGUOUS":
      return 409;
    default:
      return 400;
  }
}

app.post("/api/sessions/:name/adopt", async (req, res) => {
  try {
    const outcome = await performAdoptSession({
      session: req.params.name,
      confirm: req.body?.confirm === true,
      repo: typeof req.body?.repo === "string" ? req.body.repo : undefined,
      paneId: typeof req.body?.paneId === "string" ? req.body.paneId : undefined,
      expectedSessionCreatedAt:
        typeof req.body?.expectedSessionCreatedAt === "number" ? req.body.expectedSessionCreatedAt : undefined,
    });
    if (outcome.status === "conflict") {
      return res.status(409).json({ error: "adopción en conflicto", code: "ADOPTION_CONFLICT", existing: outcome.existing });
    }
    const { result } = outcome;
    res.json({
      session: result.session,
      cycleDir: cycleDirForSession(result.session),
      paneId: result.paneId,
      repo: result.repo,
      adoptedAt: Date.now(),
    });
  } catch (error) {
    if (error instanceof AdoptValidationError) {
      return res.status(adoptErrorStatus(error.code)).json({ error: error.detail ?? error.code, code: error.code });
    }
    if (error instanceof AdoptCommitError) {
      return res.status(error.code === "SESSION_GONE" ? 409 : 500).json({ error: error.code, code: error.code });
    }
    res.status(500).json({ error: "no se pudo adoptar la sesión" });
  }
});

// Libera una adopción: quita la marca en tmux y el worker del tablero. NO mata la sesión, NO
// borra el cycle dir — el opuesto de `stop` sobre un worker normal.
app.delete("/api/sessions/:name/adopt", async (req, res) => {
  await releaseAdoption(req.params.name);
  res.json({ ok: true });
});

const MAX_PANE_KEYS_BYTES = 16 * 1024;

function isPaneIdParam(value: string): boolean {
  return /^%\d+$/.test(value);
}


/** null = sesión inexistente. Evita el escaneo `list-panes -a` completo de listAllSessions()
 * para una ruta que se pollea cada ~200ms — has-session + display-message son ~4ms cada uno. */
async function sessionKind(session: string): Promise<"managed" | "foreign" | null> {
  if (!isSafeSessionName(session)) return null;
  if (!(await hasSession(session))) return null;
  const adopted = Boolean(await readAdoptedMark(session));
  const hasCycle = existsSync(cycleDirForSession(session));
  return classifySession(session, hasCycle, adopted);
}

// Render por pane (T5): nunca muta. Vale para foreign Y managed — es la misma garantía que ya
// tiene GET /api/sessions (sólo lectura sobre TODO el servidor tmux).
app.get("/api/sessions/:name/panes/:paneId/capture", async (req, res) => {
  const { name, paneId } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (!isPaneIdParam(paneId)) return res.status(400).json({ error: "pane inválido", code: "INVALID_PANE" });
  const membership = await paneMembership(name, paneId);
  if (membership === "session-not-found") return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  if (membership === "elsewhere") return res.status(400).json({ error: "el pane pertenece a otra sesión", code: "PANE_NOT_IN_SESSION" });
  if (membership === "gone") return res.json({ status: "gone", content: null });
  const content = await capturePaneAnsi(paneId);
  if (content === null) return res.json({ status: "gone", content: null }); // carrera: murió entre el chequeo y la captura
  const geometry = await readPaneGeometry(paneId);
  res.json({
    status: "ok",
    content,
    cursor: geometry?.cursor ?? { x: 0, y: 0 },
    size: geometry?.size ?? { cols: 0, rows: 0 },
  });
});

// Input dirigido a UN pane (T5): valida sesión managed, pertenencia del %N, y tamaño — antes
// de tocar send-keys. Nunca cae a la sesión completa si el pane no está: 400/403/404/409, no
// un fallback silencioso.
app.post("/api/sessions/:name/panes/:paneId/keys", async (req, res) => {
  const { name, paneId } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (!isPaneIdParam(paneId)) return res.status(400).json({ error: "pane inválido", code: "INVALID_PANE" });
  const kind = await sessionKind(name);
  if (kind === null) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  if (kind === "foreign") return res.status(403).json({ error: "sesión ajena: sólo lectura", code: "SESSION_READ_ONLY" });
  const rawText = typeof req.body?.text === "string" ? req.body.text : "";
  const text = rawText.split("\x00").join(""); // NUL eliminado a propósito, no cosmético
  if (Buffer.byteLength(text, "utf8") > MAX_PANE_KEYS_BYTES) {
    return res.status(400).json({ error: `texto por encima de ${MAX_PANE_KEYS_BYTES} bytes`, code: "PAYLOAD_TOO_LARGE" });
  }
  const membership = await paneMembership(name, paneId);
  if (membership === "session-not-found") return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  if (membership === "elsewhere") return res.status(400).json({ error: "el pane pertenece a otra sesión", code: "PANE_NOT_IN_SESSION" });
  if (membership === "gone") return res.status(409).json({ error: "el pane ya no existe", code: "PANE_GONE" });
  const submit = req.body?.submit === true;
  if (Buffer.byteLength(text, "utf8") > PASTE_THRESHOLD_BYTES) await pastePrompt(paneId, text, submit);
  else await sendText(paneId, text, submit);
  res.json({ ok: true });
});

// Foco de pane: el clic en la lista mueve la ventana/pane activos para que ttyd (tmux attach)
// enseñe ese pane. Mismo contrato de validación que /keys; en sesiones ajenas no se toca nada.
app.post("/api/sessions/:name/panes/:paneId/focus", async (req, res) => {
  const { name, paneId } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (!isPaneIdParam(paneId)) return res.status(400).json({ error: "pane inválido", code: "INVALID_PANE" });
  const kind = await sessionKind(name);
  if (kind === null) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  if (kind === "foreign") return res.status(403).json({ error: "sesión ajena: adóptala para cambiar de pane", code: "SESSION_READ_ONLY" });
  const membership = await paneMembership(name, paneId);
  if (membership === "session-not-found") return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  if (membership === "elsewhere") return res.status(400).json({ error: "el pane pertenece a otra sesión", code: "PANE_NOT_IN_SESSION" });
  if (membership === "gone") return res.status(409).json({ error: "el pane ya no existe", code: "PANE_GONE" });
  await focusSessionPane(paneId);
  res.json({ ok: true });
});

// Broadcast (T7): exige confirmación explícita, nunca disponible para foreign, y es TODO-O-NADA
// — se valida la pertenencia de TODOS los targets antes de enviar a NINGUNO. Serializado por
// sesión (tmux.ts:429) para no intercalarse con applyZoom sobre la misma sesión.
app.post("/api/sessions/:name/broadcast", async (req, res) => {
  const { name } = req.params;
  if (!isSafeSessionName(name)) return res.status(400).json({ error: "nombre de sesión inválido", code: "INVALID_SESSION" });
  if (req.body?.confirm !== true) return res.status(400).json({ error: "confirmación requerida", code: "CONFIRMATION_REQUIRED" });
  const kind = await sessionKind(name);
  if (kind === null) return res.status(404).json({ error: "sesión no encontrada", code: "SESSION_NOT_FOUND" });
  if (kind === "foreign") return res.status(403).json({ error: "sesión ajena: sólo lectura", code: "SESSION_READ_ONLY" });
  const targets: string[] = Array.isArray(req.body?.targets) ? req.body.targets.filter((t: unknown) => typeof t === "string") : [];
  if (targets.length === 0) return res.status(400).json({ error: "sin destinos", code: "NO_TARGETS" });
  const rawText = typeof req.body?.text === "string" ? req.body.text : "";
  const text = rawText.split("\x00").join("");
  if (Buffer.byteLength(text, "utf8") > MAX_PANE_KEYS_BYTES) {
    return res.status(400).json({ error: `texto por encima de ${MAX_PANE_KEYS_BYTES} bytes`, code: "PAYLOAD_TOO_LARGE" });
  }
  await serializePerSession(name, async () => {
    for (const target of targets) {
      if (!isPaneIdParam(target)) return res.status(400).json({ error: `pane inválido: ${target}`, code: "INVALID_PANE" });
      const membership = await paneMembership(name, target);
      if (membership !== "in-session") {
        const code = membership === "gone" ? "PANE_GONE" : membership === "session-not-found" ? "SESSION_NOT_FOUND" : "PANE_NOT_IN_SESSION";
        return res.status(membership === "gone" ? 409 : membership === "session-not-found" ? 404 : 400).json({ error: `pane fuera de la sesión: ${target}`, code });
      }
    }
    const submit = req.body?.submit === true;
    for (const target of targets) {
      if (Buffer.byteLength(text, "utf8") > PASTE_THRESHOLD_BYTES) await pastePrompt(target, text, submit);
      else await sendText(target, text, submit);
    }
    res.json({ ok: true, targets });
  });
});

// Comprobaciones de entorno (F1; F6 añade node-pty y firma/notarizado al mismo registro).
// Lanza 4 subprocesos, así que NO se pollea: la pantalla lo pide al montar y con un botón.
app.get("/api/preflight", async (_req, res) => {
  res.json({ checks: await runPreflight() });
});

// Manual re-sync of the board (refresh button)
// The sessions inventory is authoritative; board refresh no longer exists.

// Work history (JSONL). ?from=&to= in ms (default: last 7 days).
app.get("/api/history", (req, res) => {
  const from = req.query.from ? Number(req.query.from) : Date.now() - 7 * 86400000;
  const to = req.query.to ? Number(req.query.to) : Date.now() + 86400000;
  res.json(readHistory(from, to));
});

// Reportes de resumen (diario/semanal). Markdown en server/data/reports (gitignored).
app.post("/api/reports/generate", async (req, res) => {
  const kind = req.body?.kind;
  if (kind !== "daily" && kind !== "weekly") return res.status(400).json({ error: "kind inválido" });
  try {
    const { name, markdown } = await generateReport(kind, req.body?.date);
    res.json({ name, markdown });
  } catch (e) {
    // Solo los errores de validación (BadRequest: fecha/name) son 400 con su texto real;
    // claude/git → 500 con mensaje genérico (no filtra stderr interno al cliente).
    if (e instanceof BadRequest) return res.status(400).json({ error: e.message });
    console.warn(`[claude-cowork] generar reporte falló: ${(e as Error).message}`);
    res.status(500).json({ error: "no se pudo generar el reporte" });
  }
});
app.get("/api/reports", (_req, res) => {
  res.json(listReports());
});
app.get("/api/reports/:name", (req, res) => {
  try {
    const r = readReport(req.params.name);           // lanza BadRequest si name inválido → 400
    if (!r) return res.status(404).json({ error: "reporte no encontrado" });
    res.json(r);
  } catch (e) {
    const code = e instanceof BadRequest ? 400 : 500;
    res.status(code).json({ error: (e as Error).message });
  }
});


// ---- Test harness (/api/tests). El renderer manda IDENTIFICADORES (repo/perfil/suite), nunca
// texto ejecutable: parseSelection rechaza cualquier otra forma antes de llegar al servicio.
function respondHarnessError(res: express.Response, e: unknown, invalidCode: string): void {
  if (e instanceof HarnessValidationError) return void res.status(400).json({ error: e.message, code: invalidCode, path: e.path });
  if (e instanceof HarnessError) return void res.status(e.status).json({ error: e.message, code: e.code });
  res.status(500).json({ error: (e as Error).message });
}

app.get("/api/tests/config", (_req, res) => {
  res.json(harness.readPublicConfig());
});

app.get("/api/tests/config/:repo", (req, res) => {
  res.json(harness.publicRepo(req.params.repo));
});

app.put("/api/tests/config/:repo", (req, res) => {
  try {
    res.json(harness.saveRepo(req.params.repo, req.body ?? {}));
  } catch (e) {
    respondHarnessError(res, e, "INVALID_CONFIG");
  }
});

app.get("/api/tests/matrix", (_req, res) => {
  res.json(harness.matrix());
});

app.get("/api/tests/runs", (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const limit = q.limit ? Number(q.limit) : undefined;
  res.json(
    harness.listRuns({
      repo: q.repo || undefined,
      suite: q.suite as never,
      status: q.status as never,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
  );
});

app.get("/api/tests/runs/:id", (req, res) => {
  const run = harness.getRun(req.params.id);
  if (!run) return void res.status(404).json({ error: "run no encontrado", code: "RUN_NOT_FOUND" });
  res.json(run);
});

app.get("/api/tests/runs/:id/artifacts/:name", (req, res) => {
  try {
    res.sendFile(harness.artifactPath(req.params.id, req.params.name));
  } catch (e) {
    respondHarnessError(res, e, "INVALID_ARTIFACT");
  }
});

app.get("/api/tests/batches/:id", (req, res) => {
  const batch = harness.getBatch(req.params.id);
  if (!batch) return void res.status(404).json({ error: "lote no encontrado", code: "BATCH_NOT_FOUND" });
  res.json(batch);
});

app.post("/api/tests/runs", async (req, res) => {
  try {
    const selection = parseSelection(req.body);
    res.status(202).json(await harness.start(selection));
  } catch (e) {
    respondHarnessError(res, e, "INVALID_SELECTION");
  }
});

app.post("/api/tests/runs/:id/cancel", (req, res) => {
  const run = harness.getRun(req.params.id);
  if (!run) return void res.status(404).json({ error: "run no encontrado", code: "RUN_NOT_FOUND" });
  res.json({ runId: run.runId, cancelled: harness.cancel(run.runId) });
});

app.post("/api/tests/runs/:id/retry", async (req, res) => {
  try {
    res.status(202).json(await harness.retry(req.params.id));
  } catch (e) {
    respondHarnessError(res, e, "INVALID_RETRY");
  }
});

return app;
}

type Cleanup = () => void | Promise<void>;
export interface ServerHandle {
  app: express.Express;
  server: Server;
  port: number;
  close(): Promise<void>;
}

export interface ServerDependencies {
  createApp: () => express.Express;
  ensureCapability: () => string;
  startBackground: () => Promise<Cleanup>;
  listen: (app: express.Express, port: number) => Promise<Server>;
}

export interface StartServerOptions {
  port?: number;
  deps?: Partial<ServerDependencies>;
}

function once(cleanup: Cleanup): Cleanup {
  let closing: Promise<void> | undefined;
  return () => (closing ??= Promise.resolve(cleanup()).then(() => undefined));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listenOnLoopback(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

async function startDefaultBackground(): Promise<Cleanup> {
  const cleanups: Cleanup[] = [];
  try {
    if (REPORT_SCHEDULE) cleanups.push(startReportSchedule());
  } catch (error) {
    await Promise.allSettled(cleanups.reverse().map((cleanup) => cleanup()));
    throw error;
  }
  return once(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
}

const defaultDependencies: ServerDependencies = {
  createApp,
  ensureCapability: ensureCapabilityToken,
  startBackground: startDefaultBackground,
  listen: listenOnLoopback,
};

/**
 * Starts only after local capability and background producers are ready. Binding is intentionally
 * last, so a successful health response proves the runtime exists rather than merely a socket.
 */
export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const deps = { ...defaultDependencies, ...options.deps };
  const app = deps.createApp();
  const requestedPort = options.port ?? PORT;
  let background: Cleanup | undefined;
  let server: Server | undefined;

  try {
    deps.ensureCapability();
    background = await deps.startBackground();
    server = await deps.listen(app, requestedPort);
  } catch (error) {
    if (background) await background();
    throw error;
  }

  const address = server.address();
  const port = typeof address === "object" && address ? (address as AddressInfo).port : requestedPort;
  const close = once(async () => {
    await closeServer(server!);
    await background!();
  });

  console.log(
    `[claude-cowork] server en http://localhost:${port}  ` +
      `(sesiones gestionadas listas)`,
  );
  return { app, server, port, close: async () => { await close(); } };
}
