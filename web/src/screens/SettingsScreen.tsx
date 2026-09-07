import { useEffect, useMemo, useState } from "react";
import { generateRepoKnowledgeBase, getEngine, getPreflight, getRepoConfig, getRepoKnowledgeBase, getRepoKnowledgeBaseGeneration, getReposConfig, saveEngine, saveRepoKnowledgeBasePath, saveReposConfig, zipRepoKnowledgeBase } from "../api";
import type { EngineChoice, EngineTool, KnowledgeBaseGeneration, KnowledgeBaseInfo, PreflightCheck, RepoOverrideConfig, ReposConfig } from "../types";

const TOOLS: Array<{ tool: EngineTool; letter: string }> = [
  { tool: "claude", letter: "C" }, { tool: "codex", letter: "X" }, { tool: "agy", letter: "A" },
];

export interface SettingsScreenData {
  repos: ReposConfig;
  engine: EngineChoice;
  checks: PreflightCheck[];
  knowledgeBases: Record<string, KnowledgeBaseInfo>;
}

type Editor = { mode: "new" | "edit"; key: string; path: string; kbPath: string; scan: KnowledgeBaseInfo | null; creating: boolean };

const EMPTY_REPOS: ReposConfig = { defaultPath: "", repos: [] };
const EMPTY_ENGINE: EngineChoice = { tool: "claude" };

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function toolCheck(tool: EngineTool, checks: PreflightCheck[], engine: EngineChoice): PreflightCheck | undefined {
  return checks.find((check) => check.key === tool) ?? (engine.tool === tool ? checks.find((check) => check.key === "engine") : undefined);
}

function checkPath(check: PreflightCheck | undefined): string {
  if (!check) return "sin comprobar en preflight";
  return check.detail.split(" · ")[0] || "no encontrado";
}

export function SettingsScreen({ initial }: { initial?: SettingsScreenData }) {
  const [repos, setRepos] = useState(initial?.repos ?? EMPTY_REPOS);
  const [engine, setEngine] = useState(initial?.engine ?? EMPTY_ENGINE);
  const [checks, setChecks] = useState(initial?.checks ?? []);
  const [knowledgeBases, setKnowledgeBases] = useState(initial?.knowledgeBases ?? {});
  const [generations, setGenerations] = useState<Record<string, KnowledgeBaseGeneration | null>>({});
  const [note, setNote] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);

  const loadKb = async (repo: string) => {
    const [kb, generation] = await Promise.all([getRepoKnowledgeBase(repo), getRepoKnowledgeBaseGeneration(repo)]);
    if (kb) setKnowledgeBases((current) => ({ ...current, [repo]: kb }));
    setGenerations((current) => ({ ...current, [repo]: generation }));
    return kb;
  };
  const load = async () => {
    const [repoConfig, currentEngine, preflight] = await Promise.all([getReposConfig(), getEngine(), getPreflight()]);
    if (repoConfig) {
      setRepos(repoConfig);
      await Promise.all(repoConfig.repos.map((repo) => loadKb(repo.key)));
    }
    if (currentEngine) setEngine(currentEngine);
    if (preflight) setChecks(preflight);
  };

  useEffect(() => { if (!initial) void load(); }, []); // carga una vez; los estados de generación se sondean aparte
  useEffect(() => {
    const running = Object.entries(generations).filter(([, generation]) => generation?.status === "running").map(([repo]) => repo);
    if (!running.length) return;
    const timer = window.setTimeout(() => { void Promise.all(running.map(loadKb)); }, 1500);
    return () => window.clearTimeout(timer);
  }, [generations]);

  const toolStates = useMemo(() => TOOLS.map(({ tool, letter }) => {
    const check = toolCheck(tool, checks, engine);
    return { tool, letter, check, installed: check?.level === "ok" || check?.level === "warn" };
  }), [checks, engine]);

  const chooseTool = async (tool: EngineTool) => {
    const state = toolStates.find((candidate) => candidate.tool === tool);
    if (!state?.installed) return;
    try {
      const saved = await saveEngine({ tool, ...(engine.model ? { model: engine.model } : {}) });
      setEngine(saved); setNote("Motor guardado.");
    } catch (error) { setNote((error as Error).message); }
  };
  const saveModel = async () => {
    if (!toolStates.find((candidate) => candidate.tool === engine.tool)?.installed) {
      setNote("No se puede guardar un motor que no está instalado.");
      return;
    }
    try {
      const saved = await saveEngine({ tool: engine.tool, ...(engine.model?.trim() ? { model: engine.model.trim() } : {}) });
      setEngine(saved); setNote("Modelo guardado.");
    } catch (error) { setNote((error as Error).message); }
  };
  const share = async (repo: string) => {
    try { const result = await zipRepoKnowledgeBase(repo); setNote(`Archivo compartido: ${result.file}`); }
    catch (error) { setNote((error as Error).message); }
  };
  const create = async (repo: string) => {
    try { const generation = await generateRepoKnowledgeBase(repo); setGenerations((current) => ({ ...current, [repo]: generation })); setNote("Creando knowledge base…"); }
    catch (error) { setNote((error as Error).message); }
  };
  const openEditor = async (mode: Editor["mode"], repo?: { key: string; path: string }) => {
    const scan = repo ? knowledgeBases[repo.key] ?? await loadKb(repo.key) : null;
    setEditor({ mode, key: repo?.key ?? "", path: repo?.path ?? repos.defaultPath, kbPath: scan?.relativePath ?? scan?.candidates[0] ?? "knowledge-base", scan, creating: false });
  };
  const scanEditor = async () => {
    if (!editor?.key.trim()) return;
    const scan = await getRepoKnowledgeBase(editor.key.trim());
    setEditor((current) => current ? { ...current, scan, kbPath: current.kbPath || scan?.relativePath || scan?.candidates[0] || "knowledge-base" } : current);
  };
  const saveEditor = async (createKb = false) => {
    if (!editor || !editor.key.trim() || !editor.path.trim()) return;
    setEditor({ ...editor, creating: true });
    const key = editor.key.trim();
    const nextRepos: ReposConfig = {
      ...repos,
      repos: [...repos.repos.filter((repo) => repo.key !== key), { key, path: editor.path.trim() }],
    };
    try {
      const savedRepos = await saveReposConfig(nextRepos);
      setRepos(savedRepos);
      const config = await getRepoConfig(key);
      if (config) await saveRepoKnowledgeBasePath(key, config, editor.kbPath.trim());
      setEditor(null);
      setNote("Repositorio agregado.");
      if (createKb) await create(key);
      else void loadKb(key);
    } catch (error) {
      setEditor((current) => current ? { ...current, creating: false } : current);
      setNote((error as Error).message);
    }
  };

  const currentToolInstalled = toolStates.find((candidate) => candidate.tool === engine.tool)?.installed ?? false;
  return <section className="ron-cfg"><header className="ronin-view-header"><div><h1>Configuración</h1><p>Los cambios se guardan al salir de cada campo.</p></div></header><div className="ron-cfg-body">
    <section className="ron-cfg-section"><div className="ron-cfg-heading"><h2>Motor de Ronin</h2><span>Quién redacta los reportes y analiza tus flujos. No es lo que corre en tus sesiones.</span></div><div className="ron-cfg-engines">{toolStates.map(({ tool, letter, check, installed }) => <button key={tool} type="button" aria-label={`Elegir ${tool}`} className={`ron-cfg-engine ${engine.tool === tool ? "selected" : ""} ${!installed ? "unavailable" : ""}`} disabled={!installed} onClick={() => void chooseTool(tool)}><span><b className={`ron-cfg-tool ${tool}`}>{letter}</b><strong>{tool}</strong><em>{!installed ? "no instalado" : engine.tool === tool ? "en uso" : "instalado"}</em></span><code>{checkPath(check)}</code></button>)}</div><label className="ron-cfg-model">Modelo<input disabled={!currentToolInstalled} value={engine.model ?? ""} placeholder="predeterminado" onChange={(event) => setEngine({ ...engine, model: event.target.value })} onBlur={() => void saveModel()} /><small>Vacío = el modelo por defecto de la herramienta.</small></label></section>
    <section className="ron-cfg-section ron-cfg-repos"><div className="ron-cfg-heading"><h2>Repositorios</h2><span>Dónde arranca cada sesión y dónde vive su knowledge base.</span><button className="n-btn n-btn-primary" onClick={() => void openEditor("new")}>＋ Agregar repositorio</button></div><div className="ron-cfg-repo-list">{repos.repos.map((repo) => { const kb = knowledgeBases[repo.key]; const generation = generations[repo.key]; const running = generation?.status === "running"; return <article className="ron-cfg-repo" key={repo.key}><div><code>{repo.key}</code><small>{repo.path}</small></div><div className={`ron-cfg-kb ${kb?.exists ? "ok" : "missing"}`}><i /><span><code>{kb?.exists ? `${kb.relativePath}/` : "Sin knowledge base"}</code><small>{kb?.exists ? `${kb.files} archivos · ${bytes(kb.bytes)}` : generation?.status === "failed" ? generation.error || generation.output || "La creación falló" : kb?.candidates?.length ? `Encontré posibles carpetas: ${kb.candidates.join(", ")}` : "No se encontró ninguna carpeta conocida"}</small></span></div><div className="ron-cfg-actions">{kb?.exists ? <button className="n-btn n-btn-primary" onClick={() => void share(repo.key)}>Compartir zip</button> : <button className="n-btn n-btn-secondary ron-cfg-create" disabled={running} onClick={() => void create(repo.key)}>{running ? "Creando…" : "Crear"}</button>}<button className="n-btn n-btn-secondary" onClick={() => void openEditor("edit", repo)}>Editar</button></div></article>; })}</div><p className="ron-cfg-info">Varios repositorios pueden apuntar a la misma carpeta: es normal en un monorepo y cada uno conserva su propia knowledge base.</p></section>{note && <p className="ron-cfg-note" role="status">{note}</p>}</div>
    {editor && <RepoEditor editor={editor} onChange={setEditor} onScan={scanEditor} onClose={() => setEditor(null)} onSave={saveEditor} />}
  </section>;
}

function RepoEditor({ editor, onChange, onScan, onClose, onSave }: { editor: Editor; onChange: (editor: Editor) => void; onScan: () => void; onClose: () => void; onSave: (createKb?: boolean) => void }) {
  const lacksKb = editor.scan && !editor.scan.exists;
  return <div className="ron-cfg-backdrop" role="presentation"><section className="ron-cfg-dialog" role="dialog" aria-modal="true" aria-labelledby="ron-cfg-add-title"><header><div><h2 id="ron-cfg-add-title">{editor.mode === "new" ? "Agregar repositorio" : "Editar repositorio"}</h2><p>Ronin revisa la carpeta al salir del campo.</p></div><button className="ronin-icon-button" onClick={onClose} aria-label="Cerrar">×</button></header><div className="ron-cfg-fields"><label>Nombre<input value={editor.key} onChange={(event) => onChange({ ...editor, key: event.target.value })} /></label><label>Carpeta<input value={editor.path} onChange={(event) => onChange({ ...editor, path: event.target.value })} onBlur={onScan} /></label></div>{editor.scan && <div className="ron-cfg-findings"><b>Lo que encontré</b><p>{editor.scan.exists ? "Encontré una knowledge base." : "No encontré una knowledge base."}</p><small>{editor.scan.exists ? `${editor.scan.relativePath} · ${editor.scan.files} archivos · ${bytes(editor.scan.bytes)}` : editor.scan.candidates.length ? `Revisé candidatos: ${editor.scan.candidates.join(", ")}` : "No hubo carpetas conocidas para esta knowledge base."}</small></div>}{lacksKb && <div className="ron-cfg-kb-prompt"><strong>Este repositorio no tiene knowledge base</strong><p>Es la documentación de contexto que leen tus agentes antes de trabajar. Puedes crearla ahora o hacerlo después desde la lista.</p><button className="n-btn n-btn-primary" disabled={editor.creating} onClick={() => onSave(true)}>Crear knowledge base</button><button className="n-btn n-btn-secondary" disabled={editor.creating} onClick={() => onSave(false)}>Ahora no</button></div>}<label className="ron-cfg-kb-field">Carpeta de la knowledge base<input value={editor.kbPath} onChange={(event) => onChange({ ...editor, kbPath: event.target.value })} /></label><footer><button className="n-btn n-btn-secondary" onClick={onClose}>Cancelar</button><button className="n-btn n-btn-primary" disabled={editor.creating || !editor.key.trim() || !editor.path.trim()} onClick={() => onSave(false)}>{editor.mode === "new" ? "Agregar" : "Guardar"}</button></footer></section></div>;
}
