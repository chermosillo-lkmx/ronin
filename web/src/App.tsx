import { useEffect, useState } from "react";
import { generateReport, getPrompts, getReport, getReposConfig, getTrustedRoots, listReports, resetPrompt, savePrompt, saveReposConfig, saveTrustedRoots } from "./api";
import type { PromptTemplate, ReportMeta, ReposConfig, TrustedRoots } from "./types";
import { APP_VIEWS } from "./app-views";
export { APP_VIEWS } from "./app-views";
import { StatusBar } from "./components/StatusBar";
import { TrustedRootsEditor } from "./components/TrustedRootsEditor";
import { NewSessionDialog } from "./components/NewSessionDialog";
import { SkillsContext, SkillsInspector, SkillsWorkspace } from "./components/skills/SkillsWorkspace";
import { WorkflowContext, WorkflowInspector, WorkflowWorkspace, useWorkflowInsights } from "./components/workflows/WorkflowWorkspace";
import { PreflightScreen } from "./screens/PreflightScreen";
import { SessionsScreen } from "./screens/SessionsScreen";
import { TestsScreen } from "./screens/TestsScreen";
import { WorkflowEditorScreen } from "./screens/WorkflowEditorScreen";

function ReposSection() {
  const [config, setConfig] = useState<ReposConfig | null>(null);
  const [trusted, setTrusted] = useState<TrustedRoots | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getReposConfig().then(setConfig).catch((reason) => setError((reason as Error).message));
    getTrustedRoots().then(setTrusted).catch((reason) => setError((reason as Error).message));
  }, []);

  async function save() {
    if (!config) return;
    setError(null);
    setSaved(false);
    try {
      setConfig(await saveReposConfig(config));
      setSaved(true);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  return <div className="settings-panel">
    <header className="settings-panel-head"><div className="drawer-title">📁 Repos</div></header>
    {!config ? <div className="empty">cargando…</div> : <>
      <div className="repos-editor">{config.repos.map((repo, index) => <div className="repos-row" key={index}>
        <input className="repos-key" value={repo.key} placeholder="key" onChange={(event) => setConfig({ ...config, repos: config.repos.map((item, i) => i === index ? { ...item, key: event.target.value } : item) })} />
        <input className="repos-path" value={repo.path} placeholder="/ruta/al/repo" onChange={(event) => setConfig({ ...config, repos: config.repos.map((item, i) => i === index ? { ...item, path: event.target.value } : item) })} />
        <button className="btn stop" onClick={() => setConfig({ ...config, repos: config.repos.filter((_, i) => i !== index) })}>✕</button>
      </div>)}</div>
      <button className="btn add-stage" onClick={() => setConfig({ ...config, repos: [...config.repos, { key: "", path: "" }] })}>＋ agregar repo</button>
      <div className="repos-default"><span>Carpeta por defecto:</span><input className="repos-path" value={config.defaultPath} onChange={(event) => setConfig({ ...config, defaultPath: event.target.value })} /></div>
      {trusted && <TrustedRootsEditor {...trusted} onSave={async (roots) => setTrusted(await saveTrustedRoots(roots))} />}
      <div className="modal-foot"><span className="muted">{error ?? (saved ? "guardado ✓" : "")}</span><button className="btn copy" onClick={save}>💾 guardar repos</button></div>
    </>}
  </div>;
}

function PromptsSection() {
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { getPrompts().then((items) => { setTemplates(items); if (items?.[0]) { setSelected(items[0].key); setDraft(items[0].template); } }); }, []);
  const current = templates?.find((item) => item.key === selected);
  const choose = (key: string) => { setSelected(key); setDraft(templates?.find((item) => item.key === key)?.template ?? ""); setError(null); };
  async function save() { if (!current) return; try { setTemplates(await savePrompt(current.key, draft)); } catch (reason) { setError((reason as Error).message); } }
  async function restore() { if (!current) return; try { const next = await resetPrompt(current.key); setTemplates(next); setDraft(next.find((item) => item.key === current.key)?.template ?? ""); } catch (reason) { setError((reason as Error).message); } }
  return <div className="settings-panel">
    <header className="settings-panel-head"><div className="drawer-title">✍️ Prompts</div></header>
    {!templates ? <div className="empty">cargando…</div> : <>
      <div className="prompt-tabs">{templates.map((item) => <button key={item.key} className={`settings-item ${selected === item.key ? "on" : ""}`} onClick={() => choose(item.key)}>{item.label}</button>)}</div>
      {current && <><textarea className="wf-instr prompt-textarea" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} /><div className="prompt-ph">{current.placeholders.map((placeholder) => <code key={placeholder} className="prompt-chip">{placeholder}</code>)}</div></>}
      <div className="modal-foot"><span className="wf-err">{error}</span><button className="btn" disabled={!current || current.isDefault} onClick={restore}>↩ restaurar default</button><button className="btn copy" disabled={!current} onClick={save}>💾 guardar prompt</button></div>
    </>}
  </div>;
}

function SettingsView() {
  const [section, setSection] = useState<"repos" | "workflow" | "prompts">("repos");
  return <div className="settings"><nav className="settings-menu"><div className="settings-menu-title">Configuración</div>
    <button className={`settings-item ${section === "repos" ? "on" : ""}`} onClick={() => setSection("repos")}>📁 Repos</button>
    <button className={`settings-item ${section === "workflow" ? "on" : ""}`} onClick={() => setSection("workflow")}>⚙ Workflows</button>
    <button className={`settings-item ${section === "prompts" ? "on" : ""}`} onClick={() => setSection("prompts")}>✍️ Prompts</button>
  </nav><div className="settings-content">{section === "repos" ? <ReposSection /> : section === "workflow" ? <WorkflowEditorScreen /> : <PromptsSection />}</div></div>;
}

function ReportsView() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [selected, setSelected] = useState<{ name: string; markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => listReports().then(setReports).catch((reason) => setError((reason as Error).message));
  useEffect(() => { reload(); }, []);
  async function generate(kind: "daily" | "weekly") { try { setSelected(await generateReport(kind)); await reload(); } catch (reason) { setError((reason as Error).message); } }
  return <div className="settings"><nav className="settings-menu"><div className="settings-menu-title">Reportes</div><button className="btn launch" onClick={() => generate("daily")}>📅 Generar diario</button><button className="btn launch" onClick={() => generate("weekly")}>🗓️ Generar semanal</button>{reports.map((report) => <button className={`settings-item ${selected?.name === report.name ? "on" : ""}`} key={report.name} onClick={() => getReport(report.name).then(setSelected)}>{report.kind === "daily" ? "📅" : "🗓️"} {report.date}</button>)}</nav><div className="settings-content"><div className="settings-panel"><div className="drawer-title">📊 {selected?.name ?? "Reportes de resumen"}</div>{error && <div className="wf-err">{error}</div>}{selected ? <pre className="ev-md">{selected.markdown}</pre> : <div className="empty">genera o selecciona un reporte para verlo aquí</div>}</div></div></div>;
}

export function App() {
  const [view, setView] = useState<(typeof APP_VIEWS)[number]>("sessions");
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("cowork-theme") === "dark" ? "dark" : "light");
  const [workflowOverrides, setWorkflowOverrides] = useState(false);
  const [workflowLaunchOpen, setWorkflowLaunchOpen] = useState(false);
  const [acceptedWorkflowId, setAcceptedWorkflowId] = useState<string>();
  const workflowInsights = useWorkflowInsights();
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); localStorage.setItem("cowork-theme", theme); }, [theme]);
  const content = view === "sessions" ? <SessionsScreen /> : view === "settings" ? <SettingsView /> : view === "reports" ? <ReportsView /> : view === "preflight" ? <PreflightScreen /> : view === "tests" ? <TestsScreen /> : view === "skills" ? <div className="nocturne ron-web-shell"><div className="ronin-shell-body"><aside className="ronin-context-list"><SkillsContext /></aside><main className="ronin-workspace"><SkillsWorkspace /></main><aside className="ronin-inspector"><SkillsInspector /></aside></div></div> : <div className="nocturne ron-web-shell"><div className="ronin-shell-body"><aside className="ronin-context-list"><WorkflowContext /></aside><main className="ronin-workspace"><div className="ron-web-view-toggle"><button className={!workflowOverrides ? "active" : ""} onClick={() => setWorkflowOverrides(false)}>Catálogo</button><button className={workflowOverrides ? "active" : ""} onClick={() => setWorkflowOverrides(true)}>Overrides por repo</button></div>{workflowOverrides ? <WorkflowEditorScreen /> : <WorkflowWorkspace insights={workflowInsights} selectId={acceptedWorkflowId} onLaunch={() => setWorkflowLaunchOpen(true)} />}</main><aside className="ronin-inspector"><WorkflowInspector insights={workflowInsights} onAccepted={setAcceptedWorkflowId} /></aside></div>{workflowLaunchOpen && <NewSessionDialog onClose={() => setWorkflowLaunchOpen(false)} onCreated={() => setWorkflowLaunchOpen(false)} />}</div>;
  return <div className="app"><header className="bar"><span className="brand">Ronin</span><button className="refresh" onClick={() => setTheme((value) => value === "light" ? "dark" : "light")} title="cambiar tema">{theme === "light" ? "🌙" : "☀️"}</button><button className="refresh" onClick={() => setView("reports")}>📊</button><button className="refresh" onClick={() => setView("sessions")} title="sesiones tmux">⌘</button><button className="refresh" onClick={() => setView("preflight")}>⚙✓</button><button className="refresh" onClick={() => setView("workflow")}>🧭</button><button className="refresh" onClick={() => setView("skills")}>▤</button><button className="refresh" onClick={() => setView("tests")}>⚗</button><button className="refresh" onClick={() => setView("settings")}>⚙</button></header>{content}<StatusBar /></div>;
}
