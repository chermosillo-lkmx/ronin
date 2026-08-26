import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./workflow-insights.css";
import { acceptWorkflowProposal, analyzeWorkflows, attachSessionTerminal, createWorkflow, dismissWorkflowProposal, getRepoConfig, getRepos, getSessionTerminalUrl, getTmuxInventory, getWorkflowAnalysis, getWorkflowCatalog, getWorkflowProposals, listLocalSkills, readLocalSkill, saveRepoSkillAssociations, updateWorkflow, WorkflowSaveError } from "./api";
import { AdoptDialog } from "./components/AdoptDialog";
import { ProposalList } from "./components/ProposalList";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { PaneViewer } from "./components/PaneViewer";
import { SessionPresentationDialog } from "./components/SessionPresentationDialog";
import { StageEditor } from "./components/StageEditor";
import { WorkflowGraph } from "./components/WorkflowGraph";
import { WorkflowJsonEditor } from "./components/WorkflowJsonEditor";
import { adoptServerConfig, cancel as cancelDraft, createWorkflowDraft, setJsonText, setStages, switchView, type DraftView, type WorkflowDraftState } from "./components/workflow-draft";
import { createLocalSkill, downloadLocalSkill, saveLocalSkill } from "./api";
import { TestsScreen } from "./screens/TestsScreen";
import type { RepoOverrideConfig, SkillDocument, SkillRef, SkillSummary, TmuxDiagnostic, TmuxSessionInfo, WorkflowAnalysis, WorkflowCatalogItem, WorkflowConfig, WorkflowProposal } from "./types";

type DesktopView = "sessions" | "terminals" | "workflows" | "tests" | "skills";
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Plantilla mínima de "＋ Nuevo": el loop más corto que sigue siendo un workflow (plan →
 *  implementación → pruebas). Sin `verifyCmd`: eso sólo existe como override por repo. */
const NEW_WORKFLOW_TEMPLATE: WorkflowConfig = { stages: [{ key: "planning", label: "Plan", icon: "📋" }, { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" }, { key: "tests", label: "Tests", icon: "🧪" }], verifyAfter: null };

function refKey(ref: SkillRef): string { return `${ref.root}:${ref.sourceRepo ?? ""}:${ref.name}`; }

function isoDay(offsetDays = 0): string { return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10); }

export interface WorkflowInsights {
  analysis: WorkflowAnalysis | null;
  proposals: WorkflowProposal[];
  busy: boolean;
  error: string | null;
  start: (range: { from?: string; to?: string }) => Promise<void>;
  accept: (id: string) => Promise<string | null>;
  dismiss: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

/** Estado compartido entre el workspace (botones) y el inspector (panel). El análisis corre en
 *  el server, así que aquí sólo se sondea cada 3 s mientras `running` y, al terminar, se recargan
 *  las propuestas pendientes. Los fallos se guardan como texto: nunca se descarta un análisis. */
function useWorkflowInsights(): WorkflowInsights {
  const [analysis, setAnalysis] = useState<WorkflowAnalysis | null>(null);
  const [proposals, setProposals] = useState<WorkflowProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => { setProposals(await getWorkflowProposals("proposed")); }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Sólo se reprograma mientras el estado siga siendo `running`: al pasar a done/error el efecto
  // se limpia y el timer muere, sin dejar un poll huérfano contra un análisis ya terminado.
  useEffect(() => {
    const id = analysis?.id;
    if (!id || analysis?.status !== "running") return;
    let alive = true;
    const tick = async () => {
      const next = await getWorkflowAnalysis(id);
      if (!alive) return;
      if (next) setAnalysis(next);
      if (!next || next.status === "running") { poll.current = window.setTimeout(tick, 3000); return; }
      if (next.status === "done") await refresh();
    };
    poll.current = window.setTimeout(tick, 3000);
    return () => { alive = false; window.clearTimeout(poll.current); };
  }, [analysis?.id, analysis?.status, refresh]);

  const start = useCallback(async (range: { from?: string; to?: string }) => {
    setBusy(true); setError(null);
    try { const { analysisId } = await analyzeWorkflows(range); setAnalysis(await getWorkflowAnalysis(analysisId) ?? { id: analysisId, from: range.from ?? "", to: range.to ?? "", status: "running", createdAt: new Date().toISOString(), proposalIds: [], discarded: [], signals: { tasks: 0, commits: 0, evidenceFiles: 0 } }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, []);

  const accept = useCallback(async (id: string) => {
    setBusy(true); setError(null);
    try { const created = await acceptWorkflowProposal(id); setProposals((list) => list.filter((item) => item.id !== id)); return created.id; }
    catch (e) { setError((e as Error).message); return null; }
    finally { setBusy(false); }
  }, []);

  const dismiss = useCallback(async (id: string) => {
    setBusy(true); setError(null);
    try { await dismissWorkflowProposal(id); setProposals((list) => list.filter((item) => item.id !== id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }, []);

  return { analysis, proposals, busy, error, start, accept, dismiss, refresh };
}

export function DesktopApp() {
  const [view, setView] = useState<DesktopView>("sessions");
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [diagnostic, setDiagnostic] = useState<TmuxDiagnostic | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [presentationSession, setPresentationSession] = useState<TmuxSessionInfo | null>(null);
  const [acceptedWorkflowId, setAcceptedWorkflowId] = useState<string | undefined>(undefined);
  const insights = useWorkflowInsights();
  const timer = useRef<number | undefined>(undefined);

  const refreshInventory = useCallback(async () => {
    const inventory = await getTmuxInventory();
    if (!inventory) { setDiagnostic({ code: "TMUX_INVENTORY_FAILED", detail: "El backend local no respondió." }); return; }
    setDiagnostic(inventory.diagnostic);
    if (!inventory.diagnostic) {
      setSessions(inventory.sessions);
      setSelectedSession((current) => current && inventory.sessions.some((item) => item.name === current) ? current : inventory.sessions.find((item) => item.kind === "managed")?.name ?? inventory.sessions[0]?.name ?? null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => { await refreshInventory(); if (alive) timer.current = window.setTimeout(tick, 5000); };
    void tick();
    return () => { alive = false; window.clearTimeout(timer.current); };
  }, [refreshInventory]);

  const current = sessions.find((item) => item.name === selectedSession) ?? null;
  const visibleSessions = useMemo(() => filter.trim() ? sessions.filter((item) => item.name.toLowerCase().includes(filter.trim().toLowerCase())) : sessions, [sessions, filter]);

  return (
    <div className="ronin-desktop nocturne">
      <div className="ronin-shell-body">
        <nav className="ronin-rail" aria-label="Navegación principal">
          <RailButton active={view === "sessions"} icon="▦" label="Sesiones" onClick={() => setView("sessions")} />
          <RailButton active={view === "terminals"} icon="⌨" label="Terminales" onClick={() => setView("terminals")} />
          <RailButton active={view === "workflows"} icon="⌘" label="Workflows" onClick={() => setView("workflows")} />
          <RailButton active={view === "tests"} icon="⚗" label="Pruebas" onClick={() => setView("tests")} />
          <RailButton active={view === "skills"} icon="▤" label="Skills" onClick={() => setView("skills")} />
          <span className="ronin-rail-spacer" /><RailButton disabled icon="◴" label="Preflight · próximamente" />
        </nav>
        <aside className="ronin-context-list">
          {(view === "sessions" || view === "terminals") && <SessionContext sessions={visibleSessions} selected={selectedSession} filter={filter} diagnostic={diagnostic} onFilter={setFilter} onSelect={setSelectedSession} onEditPresentation={setPresentationSession} onNew={() => setNewSessionOpen(true)} />}
          {view === "workflows" && <WorkflowContext />}
          {view === "skills" && <SkillsContext />}
          {view === "tests" && <TestsContext />}
        </aside>
        <main className="ronin-workspace">
          {(view === "sessions" || view === "terminals") && <SessionWorkspace session={current} diagnostic={diagnostic} terminalGrid={view === "terminals"} onRefresh={refreshInventory} onNew={() => setNewSessionOpen(true)} />}
          {view === "workflows" && <WorkflowWorkspace insights={insights} selectId={acceptedWorkflowId} onLaunch={() => setNewSessionOpen(true)} />}
          {view === "skills" && <SkillsWorkspace />}
          {view === "tests" && <TestsScreen />}
        </main>
        <aside className="ronin-inspector">
          {(view === "sessions" || view === "terminals") && <SessionInspector session={current} diagnostic={diagnostic} />}
          {view === "workflows" && <WorkflowInspector insights={insights} onAccepted={setAcceptedWorkflowId} />}
          {view === "skills" && <SkillsInspector />}
          {view === "tests" && <TestsInspector />}
        </aside>
      </div>
      {/* Electron ya pone la barra de título nativa; el contexto vive en un pie de estado. */}
      <footer className="ronin-statusbar">
        <span className="ronin-mark" /><strong>Ronin</strong>
        <span className="ronin-title-context">{current?.presentation?.title || current?.name || "sin sesión"}</span><span className="ronin-title-slash">/</span><span className="ronin-title-workflow">{view === "workflows" ? "workflow.json" : view === "tests" ? "pruebas" : view === "skills" ? "skills" : "tmux"}</span>
        <span className="ronin-title-spacer" />
        <span className={`ronin-health ${diagnostic ? "error" : ""}`}>{diagnostic ? diagnostic.code : "tmux listo"}</span><span className="ronin-title-cost">local</span>
      </footer>
      {newSessionOpen && <NewSessionDialog onClose={() => setNewSessionOpen(false)} onCreated={(name) => { setSelectedSession(name); void refreshInventory(); }} />}
      {presentationSession && <SessionPresentationDialog session={presentationSession} onCancel={() => setPresentationSession(null)} onSaved={() => { setPresentationSession(null); void refreshInventory(); }} />}
    </div>
  );
}

function TestsContext() {
  return <div className="ronin-context-head"><span className="ronin-eyebrow">test harness</span><h2>Pruebas</h2><p className="ronin-context-copy">Una fila por repo de repos.json. Unit conserva JUnit y cobertura reales; una celda sin configurar nunca cuenta como verde.</p></div>;
}

function TestsInspector() {
  return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">pruebas</span><h2>Sin shell, sin secretos</h2><p>Los comandos se ejecutan como <code>program + args</code> sin shell, en la carpeta del repo, con un entorno mínimo más las variables del perfil. Los valores de perfil nunca vuelven a la UI.</p><p>Desde terminal/CI: <code>npm run tests:all -- --profile dev</code>.</p><span className="ronin-inspector-status managed">◆ Resultados persistidos</span></div>;
}

function RailButton({ active, icon, label, disabled, onClick }: { active?: boolean; icon: string; label: string; disabled?: boolean; onClick?: () => void }) {
  return <button className={`ronin-rail-button ${active ? "active" : ""}`} title={label} aria-label={label} aria-disabled={disabled || undefined} disabled={disabled} onClick={onClick}>{icon}</button>;
}

function SessionContext({ sessions, selected, filter, diagnostic, onFilter, onSelect, onEditPresentation, onNew }: { sessions: TmuxSessionInfo[]; selected: string | null; filter: string; diagnostic: TmuxDiagnostic | null; onFilter: (value: string) => void; onSelect: (name: string) => void; onEditPresentation: (session: TmuxSessionInfo) => void; onNew: () => void }) {
  const managed = sessions.filter((session) => session.kind === "managed");
  const foreign = sessions.filter((session) => session.kind === "foreign");
  return <><div className="ronin-context-head"><div className="ronin-search"><span>⌕</span><input value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="Filtrar sesiones…" /><kbd>⌘K</kbd></div><button className="ronin-add" onClick={onNew} title="Nueva sesión">+</button><div className="ronin-list-stat">tmux · {diagnostic ? "diagnóstico" : `${sessions.length} sesiones`}</div></div><div className="ronin-context-scroll">{diagnostic && <p className="ronin-context-error">{diagnostic.code}<br />{diagnostic.detail}</p>}<SessionRows sessions={managed} selected={selected} onSelect={onSelect} onEditPresentation={onEditPresentation} /><div className="ronin-section-label">ajenas a Ronin</div><SessionRows sessions={foreign} selected={selected} onSelect={onSelect} onEditPresentation={onEditPresentation} />{!sessions.length && !diagnostic && <p className="ronin-empty-list">No hay sesiones tmux.</p>}</div></>;
}
function SessionRows({ sessions, selected, onSelect, onEditPresentation }: { sessions: TmuxSessionInfo[]; selected: string | null; onSelect: (name: string) => void; onEditPresentation: (session: TmuxSessionInfo) => void }) {
  return <>{sessions.map((session) => <div className="ronin-session-entry" key={session.name}><button className={`ronin-session-row ${selected === session.name ? "selected" : ""} ${session.kind}`} onClick={() => onSelect(session.name)}><span className="ronin-session-top"><i /><code title={session.name}>{session.presentation?.title || session.name}</code><b>{session.attached ? "◌" : session.kind === "managed" ? "●" : ""}</b></span><span>{session.presentation?.repo ? `${session.presentation.repo} · ` : ""}{session.panes.length} panes · {session.kind === "managed" ? "gestionada" : "ajena"}</span></button><button className="ronin-session-edit" data-testid="edit-session-presentation" title={`Editar ${session.presentation?.title || session.name}`} aria-label={`Editar ${session.presentation?.title || session.name}`} onClick={() => onEditPresentation(session)}>⋯</button></div>)}</>;
}

function SessionWorkspace({ session, diagnostic, terminalGrid, onRefresh, onNew }: { session: TmuxSessionInfo | null; diagnostic: TmuxDiagnostic | null; terminalGrid: boolean; onRefresh: () => Promise<void>; onNew: () => void }) {
  const [pane, setPane] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [terminalUrl, setTerminalUrl] = useState<string | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalLoading, setTerminalLoading] = useState(Boolean(session));
  const [attachError, setAttachError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => setPane(session?.panes[0]?.id ?? null), [session?.name, session?.panes]);
  useEffect(() => {
    let alive = true;
    setTerminalUrl(null); setTerminalError(null); setTerminalLoading(Boolean(session)); setAttachError(null); setClosing(false);
    if (!session) return () => { alive = false; };
    void getSessionTerminalUrl(session.name).then((result) => {
      if (!alive) return;
      setTerminalUrl(result.url); setTerminalError(result.error); setTerminalLoading(false);
    }).catch((error) => {
      if (!alive) return;
      setTerminalError((error as Error).message); setTerminalLoading(false);
    });
    return () => { alive = false; };
  }, [session?.name]);
  if (diagnostic) return <div className="ronin-empty-workspace"><span>tmux inaccesible</span><h1>{diagnostic.code}</h1><p>{diagnostic.detail}</p><button className="n-btn n-btn-secondary" onClick={() => void onRefresh()}>Reintentar</button></div>;
  if (!session) return <div className="ronin-empty-workspace"><span>tmux</span><h1>Sin sesión seleccionada</h1><p>Crea una sesión gestionada o selecciona una sesión activa de tmux.</p><button className="n-btn n-btn-primary" onClick={onNew}>Nueva sesión</button></div>;
  const selectedPane = session.panes.find((item) => item.id === pane) ?? session.panes[0] ?? null;
  // ttyd ya pinta TODOS los panes con el layout real de tmux, así que la vista Terminales es el
  // mismo iframe a pantalla completa; la rejilla de snapshots queda sólo como respaldo sin ttyd.
  if (terminalGrid) return <div className="ronin-terminals">
    <header className="ronin-view-header">
      <div><h1>Terminales</h1><p>{session.name} · {session.panes.length} panes · {terminalUrl ? "tmux en vivo (ttyd)" : "snapshots tmux"}</p></div>
      <button className="n-btn n-btn-secondary" onClick={() => void onRefresh()}>Sincronizar</button>
    </header>
    {terminalLoading ? <p className="ronin-terminal-note">conectando terminal…</p> : terminalUrl ? <iframe key={`grid-${session.name}`} className="ttyd ronin-session-ttyd" src={terminalUrl} title="terminales" /> : session.panes.length ? <div className="ronin-terminal-grid" data-testid="tmux-pane-grid">
      {session.panes.map((item) => <section className="ronin-terminal-cell" key={item.id}>
        <header><code>{item.id} · win {item.windowIndex}</code><span>{item.role ?? item.command ?? "shell"}</span></header>
        <PaneViewer session={session.name} paneId={item.id} kind={session.kind} className="ronin-pane-view" />
      </section>)}
    </div> : <div className="ronin-empty-workspace"><span>tmux</span><h1>Sin panes disponibles</h1><p>La sesión sigue activa, pero tmux no reporta panes para mostrar.</p></div>}
    {!terminalLoading && !terminalUrl && terminalError && <p className="ronin-form-error ronin-terminal-note">{terminalError}</p>}
  </div>;
  const fallback = selectedPane ? <PaneViewer session={session.name} paneId={selectedPane.id} kind={session.kind} className="ronin-pane-view" /> : <p>No hay un pane para abrir.</p>;
  const terminal = terminalLoading ? <p>conectando terminal…</p> : terminalUrl ? <iframe key={session.name} className="ttyd ronin-session-ttyd" src={terminalUrl} title="terminal" /> : <>{terminalError && <p className="ronin-form-error">{terminalError === "ttyd no instalado (brew install ttyd)" ? "ttyd no instalado — brew install ttyd" : terminalError}</p>}<header><code>{selectedPane?.id} {selectedPane?.command}</code><span>respaldo de sólo lectura</span></header>{fallback}</>;
  return <div className="ronin-session-workspace"><header className="ronin-view-header"><div><div className="ronin-heading-line"><h1>{session.presentation?.title || session.name}</h1><span className={`tag ${session.kind === "managed" ? "tag-accent" : "tag-neutral"}`}>{session.kind === "managed" ? "gestionada" : "ajena a Ronin"}</span></div><p><code>{session.name} · {session.presentation?.repo ? `${session.presentation.repo} · ` : ""}{session.windows} windows · {session.panes.length} panes · {new Date(session.createdAt).toLocaleString("es-MX")}</code></p></div><div className="ronin-header-actions">{session.kind === "foreign" && <button className="n-btn n-btn-primary" onClick={() => setAdopting(true)}>Adoptar</button>}<button className="n-btn n-btn-secondary" data-testid="attach-session" onClick={() => void attachSessionTerminal(session.name).then(() => setAttachError(null)).catch((error) => setAttachError((error as Error).message))}>Attach</button><button className="n-btn n-btn-danger" data-testid="close-session" onClick={() => setClosing(true)}>Cerrar sesión</button><button className="n-btn n-btn-secondary" onClick={() => void onRefresh()}>↻</button></div></header>{attachError && <p className="ronin-form-error">{attachError}</p>}{session.kind === "managed" && <div className="ronin-stepper"><span>● Workflow asociado</span><span>—</span><span>○ panes tmux</span><span>—</span><span>○ evidencia</span></div>}<div className="ronin-session-body"><div className="ronin-pane-list">{session.panes.map((item) => <button className={selectedPane?.id === item.id ? "chosen" : ""} key={item.id} onClick={() => setPane(item.id)}><code>{item.id}</code><span>{item.role ?? (item.command || "shell")}</span><small>win {item.windowIndex}</small></button>)}{!session.panes.length && <p>Sin panes disponibles.</p>}</div><section className="ronin-terminal-stage">{terminal}</section></div>{adopting && <AdoptDialog session={session} onCancel={() => setAdopting(false)} onAdopted={() => { setAdopting(false); void onRefresh(); }} />}{closing && <CloseSessionDialog session={session} onCancel={() => setClosing(false)} onClosed={() => { setClosing(false); void onRefresh(); }} />}</div>;
}

function SessionInspector({ session, diagnostic }: { session: TmuxSessionInfo | null; diagnostic: TmuxDiagnostic | null }) {
  return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">inspector</span><h2>{diagnostic ? "Estado de tmux" : session?.presentation?.title || session?.name || "Sin selección"}</h2>{diagnostic ? <><span className="ronin-inspector-status fail">● {diagnostic.code}</span><p>{diagnostic.detail}</p></> : session ? <><span className={`ronin-inspector-status ${session.kind}`}>◆ {session.kind === "managed" ? "Gestionada" : "Ajena"}</span><dl><dt>tmux</dt><dd>{session.name}</dd><dt>Repo</dt><dd>{session.presentation?.repo ?? "—"}</dd><dt>Ventanas</dt><dd>{session.windows}</dd><dt>Panes</dt><dd>{session.panes.length}</dd><dt>Adjunta</dt><dd>{session.attached ? "sí" : "no"}</dd><dt>Creada</dt><dd>{new Date(session.createdAt).toLocaleString("es-MX")}</dd></dl><p>{session.kind === "foreign" ? "ttyd permite adjuntarte a esta sesión; sólo las teclas dirigidas de Ronin exigen adoptarla." : "La escritura dirigida de Ronin apunta siempre al pane %N elegido."}</p></> : <p>Selecciona una sesión de la lista lateral.</p>}</div>;
}

function WorkflowContext() { return <div className="ronin-context-head"><span className="ronin-eyebrow">workflows</span><h2>Loops guardados</h2><p className="ronin-context-copy">Grafo, stepper y JSON editan el mismo workflow.</p></div>; }
function WorkflowWorkspace({ insights, selectId, onLaunch }: { insights: WorkflowInsights; selectId?: string; onLaunch: () => void }) {
  const [catalog, setCatalog] = useState<WorkflowCatalogItem[]>([]); const [id, setId] = useState(""); const [draft, setDraft] = useState<WorkflowDraftState | null>(null); const [saving, setSaving] = useState(false); const [message, setMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false); const [newName, setNewName] = useState(""); const [rangeOpen, setRangeOpen] = useState(false); const [from, setFrom] = useState(() => isoDay(-14)); const [to, setTo] = useState(() => isoDay());
  useEffect(() => { void getWorkflowCatalog().then((result) => { const items = result?.items ?? []; setCatalog(items); setId(items[0]?.id ?? ""); }); }, []);
  // Una propuesta aceptada ya vive en el catálogo del server: se recarga y se abre en el editor.
  useEffect(() => { if (!selectId) return; void getWorkflowCatalog().then((result) => { const items = result?.items ?? []; setCatalog(items); if (items.some((item) => item.id === selectId)) setId(selectId); }); }, [selectId]);
  useEffect(() => { const item = catalog.find((candidate) => candidate.id === id); if (item) setDraft(createWorkflowDraft(item.config)); }, [catalog, id]);
  const current = catalog.find((item) => item.id === id);
  const running = insights.analysis?.status === "running";
  async function save() { if (!draft || !id || draft.jsonError) return; setSaving(true); setMessage(null); try { const updated = await updateWorkflow(id, { config: { stages: draft.stages, verifyAfter: draft.verifyAfter } }); setCatalog((items) => items.map((item) => item.id === updated.id ? updated : item)); setDraft(adoptServerConfig(draft, updated.config)); setMessage("Workflow guardado."); } catch (error) { const e = error as WorkflowSaveError; setMessage(e.message); } finally { setSaving(false); } }
  async function create() { const name = newName.trim(); if (!name) return setMessage("El nombre es obligatorio."); setMessage(null); try { const item = await createWorkflow(name, NEW_WORKFLOW_TEMPLATE); setCatalog((items) => [...items, item]); setId(item.id); setCreating(false); setNewName(""); } catch (error) { setMessage((error as WorkflowSaveError).message); } }
  const newModal = creating ? <div className="ronin-inline-modal"><div><h2>Nuevo workflow</h2><label>Nombre<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="hotfix-rapido" /></label><p className="ronin-form-note">Se crea con la plantilla mínima: Plan → Impl → Tests.</p><footer><button className="n-btn n-btn-secondary" onClick={() => { setCreating(false); setNewName(""); }}>Cancelar</button><button className="n-btn n-btn-primary" onClick={() => void create()}>Crear</button></footer></div></div> : null;
  const headerActions = <><button className="n-btn n-btn-secondary" onClick={() => setCreating(true)}>＋ Nuevo</button><button className="n-btn n-btn-secondary" onClick={() => setRangeOpen((open) => !open)}>✦ Analizar flujo reciente</button></>;
  const rangeRow = rangeOpen ? <div className="ronin-analyze-range"><label>desde<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>hasta<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="n-btn n-btn-primary" disabled={!from || !to || from >= to || insights.busy || running} onClick={() => void insights.start({ from: new Date(`${from}T00:00:00.000Z`).toISOString(), to: new Date(`${to}T23:59:59.999Z`).toISOString() })}>{running ? "Analizando…" : "Analizar"}</button>{insights.error && <span className="ronin-form-error">{insights.error}</span>}</div> : null;
  if (!draft || !current) return <div className="ronin-empty-workspace"><span>workflows</span><h1>{catalog.length ? "Cargando workflows…" : "Sin workflows"}</h1><p>Crea uno desde la plantilla mínima (Plan → Impl → Tests) o pide un análisis del trabajo reciente.</p><div className="ronin-header-actions">{headerActions}</div>{rangeRow}{message && <p className="ronin-form-error">{message}</p>}{newModal}</div>;
  return <div className="ronin-workflow-workspace"><header className="ronin-view-header"><div><select value={id} onChange={(event) => setId(event.target.value)}>{catalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><p><code>workflow.json · id inmutable {current.id}</code></p></div><div className="ronin-header-actions">{headerActions}<div className="ronin-segment">{(["graph", "stepper", "json"] as DraftView[]).map((item) => <button className={draft.view === item ? "active" : ""} key={item} onClick={() => setDraft(switchView(draft, item))}>{item === "graph" ? "Grafo" : item === "stepper" ? "Stepper" : "JSON"}</button>)}</div><button className="n-btn n-btn-primary" onClick={onLaunch}>▷ Lanzar</button></div></header>{rangeRow}<div className={`ronin-workflow-canvas ${draft.view === "graph" ? "graph" : ""}`}>{draft.view === "graph" && <WorkflowGraph stages={draft.stages} verifyAfter={draft.verifyAfter} />}{draft.view === "stepper" && <StageEditor stages={draft.stages} verifyAfter={draft.verifyAfter} allowVerifyCmd={false} onStages={(stages) => setDraft(setStages(draft, stages, draft.verifyAfter))} onVerifyAfter={(verifyAfter) => setDraft(setStages(draft, draft.stages, verifyAfter))} />}{draft.view === "json" && <WorkflowJsonEditor jsonText={draft.jsonText} jsonError={draft.jsonError} onChange={(text) => setDraft(setJsonText(draft, text))} />}</div><footer className="ronin-editor-footer">{message && <span>{message}</span>}<span className="ronin-footer-spacer" /><button className="n-btn n-btn-secondary" onClick={() => setDraft(cancelDraft(draft))}>Cancelar</button><button className="n-btn n-btn-primary" disabled={saving || Boolean(draft.jsonError)} onClick={() => void save()}>{saving ? "Guardando…" : "Guardar"}</button></footer>{newModal}</div>;
}
function WorkflowInspector({ insights, onAccepted }: { insights: WorkflowInsights; onAccepted: (id: string) => void }) {
  return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">workflow</span><h2>Propuestas</h2><p>Borradores propuestos por Claude a partir del trabajo reciente. Nada entra al catálogo hasta que lo aceptes; al aceptar se abre en el editor.</p><ProposalList proposals={insights.proposals} analysis={insights.analysis} busy={insights.busy} onAccept={(id) => void insights.accept(id).then((catalogId) => { if (catalogId) onAccepted(catalogId); })} onDismiss={(id) => void insights.dismiss(id)} /><span className="ronin-inspector-status managed">◆ Configuración local</span></div>;
}

function SkillsContext() { return <div className="ronin-context-head"><span className="ronin-eyebrow">skills</span><h2>SKILL.md locales</h2><p className="ronin-context-copy">Explora, valida y asocia skills por repositorio.</p></div>; }
function SkillsWorkspace() {
  const [skills, setSkills] = useState<SkillSummary[]>([]); const [selected, setSelected] = useState<SkillSummary | null>(null); const [skillDocument, setSkillDocument] = useState<SkillDocument | null>(null); const [content, setContent] = useState(""); const [repos, setRepos] = useState<string[]>([]); const [repo, setRepo] = useState("monorepo"); const [active, setActive] = useState<SkillRef[]>([]); const [newName, setNewName] = useState(""); const [newDescription, setNewDescription] = useState(""); const [creating, setCreating] = useState(false); const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(async () => { const all = await listLocalSkills(); setSkills(all); }, []);
  useEffect(() => { void reload(); void getRepos().then((items) => { setRepos(items); setRepo(items[0] ?? "monorepo"); }); }, [reload]);
  useEffect(() => { if (!repo) return; void getRepoConfig(repo).then((config) => setActive(config?.skills ?? [])); }, [repo]);
  async function choose(skill: SkillSummary) { setSelected(skill); setSkillDocument(null); setNote(null); try { const next = await readLocalSkill(skill.ref); setSkillDocument(next); setContent(next.content); } catch (error) { setNote((error as Error).message); } }
  async function save() { if (!selected) return; try { const next = await saveLocalSkill(selected.ref, content); setSkillDocument(next); setNote("SKILL.md guardado."); await reload(); } catch (error) { setNote((error as Error).message); } }
  async function toggle(ref: SkillRef, on: boolean) { const next = on ? [...active, ref] : active.filter((item) => refKey(item) !== refKey(ref)); try { const saved = await saveRepoSkillAssociations(repo, next); setActive(saved.skills); } catch (error) { setNote((error as Error).message); } }
  async function create() { const name = newName.trim(); if (!name || !newDescription.trim()) return setNote("Nombre y descripción son obligatorios."); try { const next = await createLocalSkill({ root: "global", name }, `---\nname: ${name}\ndescription: ${newDescription.trim()}\n---\n\n# ${name}\n\nDescribe aquí cuándo usar esta skill.\n`); setCreating(false); setNewName(""); setNewDescription(""); await reload(); await choose({ ref: next.ref, name: next.name, description: next.description, valid: true }); } catch (error) { setNote((error as Error).message); } }
  async function zip() { if (!selected) return; try { const blob = await downloadLocalSkill(selected.ref); const href = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = href; a.download = `${selected.name}.zip`; a.click(); URL.revokeObjectURL(href); } catch (error) { setNote((error as Error).message); } }
  return <div className="ronin-skills-workspace"><header className="ronin-view-header"><div><h1>Skills</h1><p>SKILL.md locales · validación de frontmatter</p></div><div className="ronin-header-actions"><button className="n-btn n-btn-secondary" disabled={!selected} onClick={() => void zip()}>Empaquetar ZIP</button><button className="n-btn n-btn-primary" onClick={() => setCreating(true)}>+ Nueva skill</button></div></header><div className="ronin-skills-body"><aside className="ronin-skill-list">{skills.map((skill) => <button key={refKey(skill.ref)} className={refKey(selected?.ref ?? { root: "global", name: "" }) === refKey(skill.ref) ? "selected" : ""} onClick={() => void choose(skill)}><strong>{skill.name}</strong><span>{skill.ref.root}{skill.ref.sourceRepo ? ` · ${skill.ref.sourceRepo}` : ""}</span><small className={skill.valid ? "ok" : "bad"}>{skill.valid ? skill.description : skill.error}</small></button>)}{!skills.length && <p>No se encontraron SKILL.md.</p>}</aside><section className="ronin-skill-editor">{selected ? <><header><span className="ronin-eyebrow">{selected.ref.root}</span><h2>{selected.name}</h2></header><textarea value={content} spellCheck={false} onChange={(event) => setContent(event.target.value)} placeholder="Selecciona una skill válida para editar." disabled={!skillDocument} /><footer><span>{note}</span><button className="n-btn n-btn-primary" disabled={!skillDocument} onClick={() => void save()}>Guardar</button></footer></> : <div className="ronin-empty-workspace"><span>SKILL.md</span><h1>Selecciona una skill</h1><p>Las skills locales se validan antes de poder guardarse o empaquetarse.</p></div>}</section></div><section className="ronin-associations"><div><span className="ronin-eyebrow">activación por repo</span><select value={repo} onChange={(event) => setRepo(event.target.value)}>{repos.map((item) => <option key={item}>{item}</option>)}</select><p>La activación sólo guarda la asociación; no inyecta contenido en prompts ni sesiones.</p></div><div className="ronin-association-list">{skills.filter((skill) => skill.valid).map((skill) => { const enabled = active.some((item) => refKey(item) === refKey(skill.ref)); return <label key={refKey(skill.ref)}><input type="checkbox" checked={enabled} onChange={(event) => void toggle(skill.ref, event.target.checked)} /> <span>{skill.name}</span><code>{skill.ref.root}</code></label>; })}</div></section>{creating && <div className="ronin-inline-modal"><div><h2>Nueva skill</h2><label>Nombre<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="api-review" /></label><label>Descripción<input value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Cuándo y para qué usarla" /></label><footer><button className="n-btn n-btn-secondary" onClick={() => setCreating(false)}>Cancelar</button><button className="n-btn n-btn-primary" onClick={() => void create()}>Crear</button></footer></div></div>}</div>;
}
function SkillsInspector() { return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">skills</span><h2>Asociaciones</h2><p>Una SkillRef conserva su raíz y, si aplica, el repositorio de origen. Dos skills con el mismo nombre no se confunden.</p><span className="ronin-inspector-status managed">◆ Sin inyección de prompt</span></div>; }
