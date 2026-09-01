import { useEffect, useState, type FormEvent } from "react";
import { getRepos, getWorkflowCatalog, launchManagedTmuxSession } from "../api";
import type { WorkflowCatalogItem } from "../types";

type LaunchMode = "workflow" | "terminal";
type TerminalAgent = "claude" | "codex";

export function defaultSessionName(request: string): string {
  const ticket = request.match(/\b(?:CU-\w+|PW-\d+|[A-Z]+-\d+)\b/i)?.[0];
  const source = ticket ?? request.trim().split(/\s+/).slice(0, 4).join(" ");
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug ? `cowork-${slug}` : "cowork-";
}

export function NewSessionDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [repos, setRepos] = useState<string[]>(["monorepo"]);
  const [workflows, setWorkflows] = useState<WorkflowCatalogItem[]>([]);
  const [repo, setRepo] = useState("monorepo");
  const [workflowId, setWorkflowId] = useState("");
  const [mode, setMode] = useState<LaunchMode>("workflow");
  const [agent, setAgent] = useState<TerminalAgent>("claude");
  const [request, setRequest] = useState("");
  const [name, setName] = useState("cowork-");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRepos().then((nextRepos) => {
      setRepos(nextRepos);
      setRepo(nextRepos[0] ?? "monorepo");
    }).catch(() => setError("No se pudieron cargar los repositorios."));
    getWorkflowCatalog().then((catalog) => {
      const items = catalog?.items ?? [];
      setWorkflows(items);
      setWorkflowId(items[0]?.id ?? "");
    }).catch(() => setWorkflows([]));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!name.startsWith("cowork-")) return setError("El nombre debe iniciar con cowork-.");
    if (mode === "workflow" && !workflowId) return setError("Selecciona un workflow.");
    setBusy(true);
    try {
      const result = await launchManagedTmuxSession(mode === "workflow"
        ? { repo, workflowId, name, mode, request: request.trim() || undefined }
        : { repo, name, mode, agent });
      onCreated(result.name);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="ronin-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="ronin-new-session" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="ronin-eyebrow">tmux</span><h2>Nueva sesión</h2></div><button type="button" className="ronin-icon-button" onClick={onClose} aria-label="Cerrar">×</button></header>
        <div className="ronin-launch-mode"><span>Modo</span><div className="ronin-segment" role="group" aria-label="Modo de sesión"><button type="button" className={mode === "workflow" ? "active" : ""} data-testid="session-mode-workflow" aria-pressed={mode === "workflow"} onClick={() => setMode("workflow")}>Workflow</button><button type="button" className={mode === "terminal" ? "active" : ""} data-testid="session-mode-terminal" aria-pressed={mode === "terminal"} onClick={() => setMode("terminal")}>Terminal normal</button></div></div>
        {mode === "workflow" ? <label>Workflow<select data-testid="session-workflow" value={workflowId} onChange={(event) => setWorkflowId(event.target.value)}><option value="">Seleccionar workflow…</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select></label> : <label>Agente<select data-testid="session-agent" value={agent} onChange={(event) => setAgent(event.target.value as TerminalAgent)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label>}
        <label>Repositorio<select value={repo} onChange={(event) => setRepo(event.target.value)}>{repos.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        {mode === "workflow" && <label>Petición<textarea className="ronin-request-input" value={request} spellCheck={false} onChange={(event) => { const next = event.target.value; setRequest(next); if (name === "cowork-") setName(defaultSessionName(next)); }} placeholder="necesito que trabajes este ticket CU-86e2… — o pega aquí la descripción" rows={12} /></label>}
        <label>Nombre de sesión<input value={name} autoFocus spellCheck={false} onChange={(event) => setName(event.target.value)} placeholder="cowork-api-gateway" /></label>
        <p className="ronin-form-note">{mode === "workflow" ? <>{request.trim() ? "Claude recibirá el workflow y esta petición al arrancar." : "Sin petición: tendrás que instruir al worker en la terminal."} Se crea una rama <code>ronin/&lt;sesión&gt;</code> desde <code>main</code> y se congela el workflow elegido.</> : <>Se abre <code>{agent}</code> en la raíz del repositorio, sin crear rama, worktree ni workflow. Para copiar, usa Opción/Shift + arrastre.</>}</p>
        {error && <p className="ronin-form-error">{error}</p>}
        <footer><button type="button" className="n-btn n-btn-secondary" onClick={onClose}>Cancelar</button><button className="n-btn n-btn-primary" disabled={busy || (mode === "workflow" && !workflowId)}>{busy ? "Creando…" : "Crear sesión"}</button></footer>
      </form>
    </div>
  );
}
