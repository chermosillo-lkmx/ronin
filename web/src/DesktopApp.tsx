import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getRepoConfig, getRepos, getTmuxInventory, getWorkflowCatalog, listLocalSkills, readLocalSkill, saveRepoSkillAssociations, updateWorkflow, WorkflowSaveError } from "./api";
import { AdoptDialog } from "./components/AdoptDialog";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { NativeTerminal } from "./components/NativeTerminal";
import { PaneViewer } from "./components/PaneViewer";
import { SessionPresentationDialog } from "./components/SessionPresentationDialog";
import { StageEditor } from "./components/StageEditor";
import { WorkflowGraph } from "./components/WorkflowGraph";
import { WorkflowJsonEditor } from "./components/WorkflowJsonEditor";
import { adoptServerConfig, cancel as cancelDraft, createWorkflowDraft, setJsonText, setStages, switchView, type DraftView, type WorkflowDraftState } from "./components/workflow-draft";
import { createLocalSkill, downloadLocalSkill, saveLocalSkill } from "./api";
import { TestsScreen } from "./screens/TestsScreen";
import type { RepoOverrideConfig, SkillDocument, SkillRef, SkillSummary, TmuxDiagnostic, TmuxSessionInfo, WorkflowCatalogItem } from "./types";

type DesktopView = "sessions" | "terminals" | "workflows" | "tests" | "skills";
const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

function refKey(ref: SkillRef): string { return `${ref.root}:${ref.sourceRepo ?? ""}:${ref.name}`; }

export function DesktopApp() {
  const [view, setView] = useState<DesktopView>("sessions");
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [diagnostic, setDiagnostic] = useState<TmuxDiagnostic | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [presentationSession, setPresentationSession] = useState<TmuxSessionInfo | null>(null);
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
      <header className="ronin-titlebar">
        <div className="ronin-window-dots"><i /><i /><i /></div><span className="ronin-mark" /><strong>Ronin</strong>
        <span className="ronin-title-context">{current?.presentation?.title || current?.name || "sin sesión"}</span><span className="ronin-title-slash">/</span><span className="ronin-title-workflow">{view === "workflows" ? "workflow.json" : "tmux"}</span>
        <span className="ronin-title-spacer" />
        <span className={`ronin-health ${diagnostic ? "error" : ""}`}>{diagnostic ? diagnostic.code : "tmux listo"}</span><span className="ronin-title-cost">local</span>
      </header>
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
          {view === "workflows" && <WorkflowWorkspace onLaunch={() => setNewSessionOpen(true)} />}
          {view === "skills" && <SkillsWorkspace />}
          {view === "tests" && <TestsScreen />}
        </main>
        <aside className="ronin-inspector">
          {(view === "sessions" || view === "terminals") && <SessionInspector session={current} diagnostic={diagnostic} />}
          {view === "workflows" && <WorkflowInspector />}
          {view === "skills" && <SkillsInspector />}
          {view === "tests" && <TestsInspector />}
        </aside>
      </div>
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
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  useEffect(() => setPane(session?.panes[0]?.id ?? null), [session?.name, session?.panes]);
  useEffect(() => { setTerminalOpen(false); setClosing(false); }, [session?.name]);
  if (diagnostic) return <div className="ronin-empty-workspace"><span>tmux inaccesible</span><h1>{diagnostic.code}</h1><p>{diagnostic.detail}</p><button className="n-btn n-btn-secondary" onClick={() => void onRefresh()}>Reintentar</button></div>;
  if (!session) return <div className="ronin-empty-workspace"><span>tmux</span><h1>Sin sesión seleccionada</h1><p>Crea una sesión gestionada o selecciona una sesión activa de tmux.</p><button className="n-btn n-btn-primary" onClick={onNew}>Nueva sesión</button></div>;
  const selectedPane = session.panes.find((item) => item.id === pane) ?? session.panes[0] ?? null;
  if (terminalGrid) return <div className="ronin-terminals">
    <header className="ronin-view-header">
      <div><h1>Terminales</h1><p>{session.name} · {session.panes.length} panes · snapshots tmux en vivo</p></div>
      <button className="n-btn n-btn-secondary" onClick={() => void onRefresh()}>Sincronizar</button>
    </header>
    {session.panes.length ? <div className="ronin-terminal-grid" data-testid="tmux-pane-grid">
      {session.panes.map((item) => <section className="ronin-terminal-cell" key={item.id}>
        <header><code>{item.id} · win {item.windowIndex}</code><span>{item.role ?? item.command ?? "shell"}</span></header>
        <PaneViewer session={session.name} paneId={item.id} kind={session.kind} className="ronin-pane-view" />
      </section>)}
    </div> : <div className="ronin-empty-workspace"><span>tmux</span><h1>Sin panes disponibles</h1><p>La sesión sigue activa, pero tmux no reporta panes para mostrar.</p></div>}
  </div>;
  return <div className="ronin-session-workspace"><header className="ronin-view-header"><div><div className="ronin-heading-line"><h1>{session.presentation?.title || session.name}</h1><span className={`tag ${session.kind === "managed" ? "tag-accent" : "tag-neutral"}`}>{session.kind === "managed" ? "gestionada" : "ajena a Ronin"}</span></div><p><code>{session.name} · {session.presentation?.repo ? `${session.presentation.repo} · ` : ""}{session.windows} windows · {session.panes.length} panes · {new Date(session.createdAt).toLocaleString("es-MX")}</code></p></div><div className="ronin-header-actions">{session.kind === "foreign" && <button className="n-btn n-btn-primary" onClick={() => setAdopting(true)}>Adoptar</button>}<button className="n-btn n-btn-secondary" data-testid="attach-session" onClick={() => setTerminalOpen((open) => !open)}>{terminalOpen ? "Cerrar attach" : "Attach"}</button><button className="n-btn n-btn-danger" data-testid="close-session" onClick={() => setClosing(true)}>Cerrar sesión</button><button className="n-btn n-btn-secondary" onClick={() => void onRefresh()}>↻</button></div></header>{session.kind === "managed" && <div className="ronin-stepper"><span>● Workflow asociado</span><span>—</span><span>○ panes tmux</span><span>—</span><span>○ evidencia</span></div>}<div className="ronin-session-body"><div className="ronin-pane-list">{session.panes.map((item) => <button className={selectedPane?.id === item.id ? "chosen" : ""} key={item.id} onClick={() => setPane(item.id)}><code>{item.id}</code><span>{item.role ?? (item.command || "shell")}</span><small>win {item.windowIndex}</small></button>)}{!session.panes.length && <p>Sin panes disponibles.</p>}</div><section className="ronin-terminal-stage">{terminalOpen ? <><header><code>{session.name}</code><span>{session.kind === "foreign" ? "solo lectura · adopta para escribir" : "terminal interactiva"}</span></header><NativeTerminal session={session.name} className="ronin-session-native-attach" /></> : selectedPane ? <><header><code>{selectedPane.id} {selectedPane.command}</code><span>{session.kind === "foreign" ? "solo lectura" : "escritura dirigida"}</span></header><PaneViewer session={session.name} paneId={selectedPane.id} kind={session.kind} className="ronin-pane-view" /></> : <p>No hay un pane para abrir.</p>}</section></div>{adopting && <AdoptDialog session={session} onCancel={() => setAdopting(false)} onAdopted={() => { setAdopting(false); void onRefresh(); }} />}{closing && <CloseSessionDialog session={session} onCancel={() => setClosing(false)} onClosed={() => { setClosing(false); setTerminalOpen(false); void onRefresh(); }} />}</div>;
}

function SessionInspector({ session, diagnostic }: { session: TmuxSessionInfo | null; diagnostic: TmuxDiagnostic | null }) {
  return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">inspector</span><h2>{diagnostic ? "Estado de tmux" : session?.presentation?.title || session?.name || "Sin selección"}</h2>{diagnostic ? <><span className="ronin-inspector-status fail">● {diagnostic.code}</span><p>{diagnostic.detail}</p></> : session ? <><span className={`ronin-inspector-status ${session.kind}`}>◆ {session.kind === "managed" ? "Gestionada" : "Ajena"}</span><dl><dt>tmux</dt><dd>{session.name}</dd><dt>Repo</dt><dd>{session.presentation?.repo ?? "—"}</dd><dt>Ventanas</dt><dd>{session.windows}</dd><dt>Panes</dt><dd>{session.panes.length}</dd><dt>Adjunta</dt><dd>{session.attached ? "sí" : "no"}</dd><dt>Creada</dt><dd>{new Date(session.createdAt).toLocaleString("es-MX")}</dd></dl><p>{session.kind === "foreign" ? "No se envían teclas a esta sesión hasta que la adoptes." : "La escritura apunta siempre al pane %N elegido."}</p></> : <p>Selecciona una sesión de la lista lateral.</p>}</div>;
}

function WorkflowContext() { return <div className="ronin-context-head"><span className="ronin-eyebrow">workflows</span><h2>Loops guardados</h2><p className="ronin-context-copy">Grafo, stepper y JSON editan el mismo workflow.</p></div>; }
function WorkflowWorkspace({ onLaunch }: { onLaunch: () => void }) {
  const [catalog, setCatalog] = useState<WorkflowCatalogItem[]>([]); const [id, setId] = useState(""); const [draft, setDraft] = useState<WorkflowDraftState | null>(null); const [saving, setSaving] = useState(false); const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void getWorkflowCatalog().then((result) => { const items = result?.items ?? []; setCatalog(items); setId(items[0]?.id ?? ""); }); }, []);
  useEffect(() => { const item = catalog.find((candidate) => candidate.id === id); if (item) setDraft(createWorkflowDraft(item.config)); }, [catalog, id]);
  const current = catalog.find((item) => item.id === id);
  async function save() { if (!draft || !id || draft.jsonError) return; setSaving(true); setMessage(null); try { const updated = await updateWorkflow(id, { config: { stages: draft.stages, verifyAfter: draft.verifyAfter } }); setCatalog((items) => items.map((item) => item.id === updated.id ? updated : item)); setDraft(adoptServerConfig(draft, updated.config)); setMessage("Workflow guardado."); } catch (error) { const e = error as WorkflowSaveError; setMessage(e.message); } finally { setSaving(false); } }
  if (!draft || !current) return <div className="ronin-empty-workspace"><span>workflows</span><h1>Cargando workflows…</h1></div>;
  return <div className="ronin-workflow-workspace"><header className="ronin-view-header"><div><select value={id} onChange={(event) => setId(event.target.value)}>{catalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><p><code>workflow.json · id inmutable {current.id}</code></p></div><div className="ronin-header-actions"><div className="ronin-segment">{(["graph", "stepper", "json"] as DraftView[]).map((item) => <button className={draft.view === item ? "active" : ""} key={item} onClick={() => setDraft(switchView(draft, item))}>{item === "graph" ? "Grafo" : item === "stepper" ? "Stepper" : "JSON"}</button>)}</div><button className="n-btn n-btn-primary" onClick={onLaunch}>▷ Lanzar</button></div></header><div className={`ronin-workflow-canvas ${draft.view === "graph" ? "graph" : ""}`}>{draft.view === "graph" && <WorkflowGraph stages={draft.stages} verifyAfter={draft.verifyAfter} />}{draft.view === "stepper" && <StageEditor stages={draft.stages} verifyAfter={draft.verifyAfter} allowVerifyCmd={false} onStages={(stages) => setDraft(setStages(draft, stages, draft.verifyAfter))} onVerifyAfter={(verifyAfter) => setDraft(setStages(draft, draft.stages, verifyAfter))} />}{draft.view === "json" && <WorkflowJsonEditor jsonText={draft.jsonText} jsonError={draft.jsonError} onChange={(text) => setDraft(setJsonText(draft, text))} />}</div><footer className="ronin-editor-footer">{message && <span>{message}</span>}<span className="ronin-footer-spacer" /><button className="n-btn n-btn-secondary" onClick={() => setDraft(cancelDraft(draft))}>Cancelar</button><button className="n-btn n-btn-primary" disabled={saving || Boolean(draft.jsonError)} onClick={() => void save()}>{saving ? "Guardando…" : "Guardar"}</button></footer></div>;
}
function WorkflowInspector() { return <div className="ronin-inspector-inner"><span className="ronin-eyebrow">workflow</span><h2>Edición en caliente</h2><p>El Grafo, Stepper y JSON son tres vistas del mismo borrador. Sólo un guardado válido actualiza la configuración persistida.</p><span className="ronin-inspector-status managed">◆ Configuración local</span></div>; }

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
