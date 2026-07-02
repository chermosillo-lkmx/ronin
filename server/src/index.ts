import cors from "cors";
import express from "express";
import { join } from "node:path";
import { startDmPoller } from "./clickup-chat.js";
import { CLICKUP_REFRESH_MS, DM_POLL, DM_POLL_MS, PORT } from "./config.js";
import { attachWorker, launchAction, launchAdhoc, launchCustom, launchPrReview, launchResearch, launchTask, start, stopWorker, workerInput, workerPane } from "./engine.js";
import { getActions, saveActions } from "./actions.js";
import { readHistory } from "./history.js";
import { setOrder } from "./order.js";
import { evidenceDir, readEvidence } from "./stages.js";
import { startTtyd } from "./ttyd.js";
import { classifyDM } from "./classify.js";
import { emit, findTask, findWorker, snapshot, subscribe } from "./state.js";
import { initTasks, refreshTasks, startAutoRefresh } from "./tasks-source.js";
import { togglePin } from "./today.js";
import { getWorkflow, saveWorkflow } from "./workflow.js";
import { readPromptConfig, resetPromptTemplate, savePromptTemplate } from "./prompts.js";
import { listRepos, readRepoConfig, saveRepoConfig } from "./repos.js";
import { readRepoConfigFull, saveRepoOverrides } from "./repo-config.js";
import { readConnectorSettings, saveConnectorSettings } from "./settings.js";
import { fetchClickUpDescription, testClickUp } from "./clickup.js";
import { testJira } from "./jira.js";
import { testGitLab } from "./gitlab.js";

const app = express();
app.use(cors());
app.use(express.json());

// Full snapshot (initial load / polling fallback)
app.get("/api/state", (_req, res) => {
  res.json(snapshot());
});

// Server-Sent Events: push a full snapshot on every state change
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send(snapshot());

  const unsubscribe = subscribe(send);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// Create + launch an ad-hoc task (from a DM/mention): simple worker, no skill
app.post("/api/adhoc", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "empty text" });
  const worker = await launchAdhoc(text, String(req.body?.title ?? ""), String(req.body?.repo ?? "monorepo"));
  res.json({ worker });
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

// Read / edit a repo's workflow override + vars + startCommand (data/repo-config.json)
app.get("/api/repo-config/:repo", (req, res) => {
  res.json(readRepoConfigFull(req.params.repo));
});
app.put("/api/repo-config/:repo", (req, res) => {
  try {
    res.json(saveRepoOverrides(req.params.repo, req.body ?? {}));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Leer / editar credenciales de conectores (data/settings.json) desde el UI. Tokens enmascarados.
app.get("/api/connectors", (_req, res) => {
  res.json(readConnectorSettings());
});
app.put("/api/connectors", async (req, res) => {
  try {
    const settings = saveConnectorSettings(req.body); // valida (throw → 400); baseUrl allowlist
    await refreshTasks(); // aplica creds nuevas al tablero en runtime (side-effect; no se devuelve)
    res.json(settings); // bare, como /api/repos-config y /api/workflow
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
app.post("/api/connectors/:name/test", async (req, res) => {
  const name = req.params.name;
  if (name === "clickup") return res.json(await testClickUp());
  if (name === "jira") return res.json(await testJira());
  if (name === "gitlab") return res.json(await testGitLab());
  return res.status(400).json({ error: "conector desconocido" });
});

// Create + launch a free-text request that runs the composable workflow loop
app.post("/api/custom", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "empty text" });
  const repo = String(req.body?.repo ?? "monorepo");
  const stageKeys: string[] | undefined = Array.isArray(req.body?.stageKeys)
    ? req.body.stageKeys.filter((x: unknown) => typeof x === "string")
    : undefined;
  const worker = await launchCustom(text, repo, stageKeys);
  res.json({ worker });
});

// Generic DM webhook: classify via `claude -p`; if it's a task, launch it; else ignore.
app.post("/api/webhook/dm", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "empty text" });
  const c = await classifyDM(text);
  if (!c.isTask) return res.json({ launched: false, reason: "no es una tarea" });
  const worker = await launchAdhoc(c.task || text, c.task, "monorepo", c.complexity === "complex");
  res.json({ launched: true, complexity: c.complexity, task: c.task, worker });
});

// PR reviewer: pass a PR URL (+ optional task URL); verify the PR, curl-test in dev after merge
app.post("/api/pr-review", async (req, res) => {
  const prUrl = String(req.body?.prUrl ?? "").trim();
  if (!prUrl) return res.status(400).json({ error: "missing prUrl" });
  const worker = await launchPrReview(
    prUrl,
    String(req.body?.taskUrl ?? ""),
    String(req.body?.title ?? ""),
    String(req.body?.repo ?? "ant-liebre-api")
  );
  res.json({ worker });
});

// Start (or reuse) an embedded interactive terminal (ttyd) for the worker
app.post("/api/workers/:id/term", (req, res) => {
  const worker = findWorker(req.params.id);
  if (!worker?.session) return res.status(404).json({ error: "no session for worker" });
  const port = startTtyd(worker.session);
  // 127.0.0.1 (not "localhost") — ttyd binds IPv4 while the browser may resolve localhost to ::1.
  res.json({ url: `http://127.0.0.1:${port}` });
});

// Respond to a worker (type into its pane)
app.post("/api/workers/:id/input", async (req, res) => {
  const text = String(req.body?.text ?? "");
  const ok = await workerInput(req.params.id, text);
  if (!ok) return res.status(404).json({ error: "no session for worker" });
  res.json({ ok: true });
});

// Launch a worker for a task (simulated, or a real tmux+claude session in live mode)
app.post("/api/tasks/:id/launch", async (req, res) => {
  const stageKeys: string[] | undefined = Array.isArray(req.body?.stageKeys)
    ? req.body.stageKeys.filter((x: unknown) => typeof x === "string")
    : undefined;
  const worker = await launchTask(req.params.id, stageKeys);
  if (!worker) return res.status(404).json({ error: "task not found" });
  res.json(worker);
});

// Launch a read-only research worker for a task (investigates + proposes a plan)
app.post("/api/tasks/:id/research", async (req, res) => {
  const worker = await launchResearch(req.params.id);
  if (!worker) return res.status(404).json({ error: "task not found" });
  res.json({ worker });
});

// Launch a user-defined custom action worker for a task (decoupled del tablero, como research).
// 404 si la tarea o la acción no existe.
app.post("/api/tasks/:id/action/:key", async (req, res) => {
  const worker = await launchAction(req.params.id, req.params.key);
  if (!worker) return res.status(404).json({ error: "task or action not found" });
  res.json({ worker });
});

// Best-effort description for the preview modal: body → clickup lazy fetch → title fallback
app.get("/api/tasks/:id/description", async (req, res) => {
  const task = findTask(req.params.id);
  if (!task) return res.status(404).json({ error: "task not found" });
  if (task.body && task.body.trim()) return res.json({ description: task.body });
  if (task.source === "clickup") {
    const desc = await fetchClickUpDescription(task.id);
    if (desc) {
      task.body = desc;                    // cachea en el objeto vivo (snapshot lo clona)
      return res.json({ description: desc });
    }
  }
  res.json({ description: task.title });    // fallback
});

// Read / edit the composable workflow (data/workflow.json)
app.get("/api/workflow", (_req, res) => {
  res.json(getWorkflow());
});
app.put("/api/workflow", (req, res) => {
  try {
    const saved = saveWorkflow({ stages: req.body?.stages, verifyAfter: req.body?.verifyAfter ?? null });
    emit(); // snapshot.stages changed → push to all clients
    res.json(saved);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
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

// Leer / editar las acciones custom (data/actions.json). Bare JSON como /api/workflow. Sin emit():
// las acciones no forman parte de Snapshot (la App las trae aparte). Registry inválido → 400.
app.get("/api/actions", (_req, res) => {
  res.json(getActions());
});
app.put("/api/actions", (req, res) => {
  try {
    res.json(saveActions(req.body));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Stop a worker (kills its tmux session in live mode)
app.post("/api/workers/:id/stop", async (req, res) => {
  const ok = await stopWorker(req.params.id);
  if (!ok) return res.status(404).json({ error: "worker not found" });
  res.json({ ok: true });
});

// Open a visible Terminal attached to the worker's tmux session (live mode)
app.post("/api/workers/:id/attach", async (req, res) => {
  const ok = await attachWorker(req.params.id);
  if (!ok) return res.status(404).json({ error: "no session for worker" });
  res.json({ ok: true });
});

// Manual re-sync of the board (refresh button)
app.post("/api/refresh", async (_req, res) => {
  const result = await refreshTasks();
  res.json(result);
});

// Work history (JSONL). ?from=&to= in ms (default: last 7 days).
app.get("/api/history", (req, res) => {
  const from = req.query.from ? Number(req.query.from) : Date.now() - 7 * 86400000;
  const to = req.query.to ? Number(req.query.to) : Date.now() + 86400000;
  res.json(readHistory(from, to));
});

// Pin / unpin a task into "today's plan"
app.post("/api/today/pin/:id", (req, res) => {
  const pins = togglePin(req.params.id, true);
  emit();
  res.json({ pins });
});
app.post("/api/today/unpin/:id", (req, res) => {
  const pins = togglePin(req.params.id, false);
  emit();
  res.json({ pins });
});

// Persist the user's manual task ordering (secondary sort within priority)
app.post("/api/order", (req, res) => {
  const ids: string[] = Array.isArray(req.body?.order)
    ? req.body.order.filter((x: unknown) => typeof x === "string")
    : [];
  setOrder(ids);
  emit();
  res.json({ ok: true });
});

// Live terminal content of a worker's tmux pane
app.get("/api/workers/:id/pane", async (req, res) => {
  const result = await workerPane(req.params.id);
  if (!result) return res.status(404).json({ error: "worker not found" });
  res.json(result);
});

// Evidence artifacts produced by the worker (markdown + screenshot names)
app.get("/api/workers/:id/evidence", (req, res) => {
  const worker = findWorker(req.params.id);
  if (!worker?.cycle) return res.status(404).json({ error: "worker not found" });
  res.json(readEvidence(worker.cycle));
});

// Serve a single evidence image (screenshot). Name is sanitized to its basename.
app.get("/api/workers/:id/evidence/file/:name", (req, res) => {
  const worker = findWorker(req.params.id);
  if (!worker?.cycle) return res.status(404).end();
  const safe = req.params.name.replace(/[/\\]/g, "").replace(/\.\./g, "");
  if (!/\.(png|jpe?g|gif|webp)$/i.test(safe)) return res.status(400).end();
  res.sendFile(join(evidenceDir(worker.cycle), safe));
});

app.listen(PORT, async () => {
  const source = await initTasks(); // populate the board before the engine seeds workers
  const mode = await start(source);
  startAutoRefresh(CLICKUP_REFRESH_MS);
  if (DM_POLL) startDmPoller(DM_POLL_MS);
  console.log(
    `[claude-cowork] server en http://localhost:${PORT}  ` +
      `(modo: ${mode}, tareas: ${source}, auto-refresh: ${Math.round(CLICKUP_REFRESH_MS / 1000)}s)`
  );
});
