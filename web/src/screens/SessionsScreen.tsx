import { useMemo, useState } from "react";
import { NewSessionDialog } from "../components/NewSessionDialog";
import { SessionPresentationDialog } from "../components/SessionPresentationDialog";
import { SessionContext } from "../components/sessions/SessionContext";
import { SessionInspector, SessionWorkspace } from "../components/sessions/SessionWorkspace";
import { useTmuxInventory } from "../components/sessions/useTmuxInventory";
import type { TmuxSessionInfo } from "../types";

export function SessionsScreen() {
  const { sessions, diagnostic, selectedSession, setSelectedSession, refreshInventory } = useTmuxInventory();
  const [filter, setFilter] = useState(""); const [terminals, setTerminals] = useState(false); const [newOpen, setNewOpen] = useState(false); const [presentation, setPresentation] = useState<TmuxSessionInfo | null>(null);
  const visible = useMemo(() => filter.trim() ? sessions.filter((x) => x.name.toLowerCase().includes(filter.trim().toLowerCase())) : sessions, [sessions, filter]); const current = sessions.find((x) => x.name === selectedSession) ?? null;
  return <div className="nocturne ron-web-shell"><div className="ronin-shell-body"><aside className="ronin-context-list"><SessionContext sessions={visible} selected={selectedSession} filter={filter} diagnostic={diagnostic} onFilter={setFilter} onSelect={setSelectedSession} onEditPresentation={setPresentation} onNew={() => setNewOpen(true)} /></aside><main className="ronin-workspace"><div className="ron-web-view-toggle"><button className={!terminals ? "active" : ""} onClick={() => setTerminals(false)}>Sesión</button><button className={terminals ? "active" : ""} onClick={() => setTerminals(true)}>Terminales</button></div><SessionWorkspace session={current} diagnostic={diagnostic} terminalGrid={terminals} onRefresh={refreshInventory} onNew={() => setNewOpen(true)} /></main><aside className="ronin-inspector"><SessionInspector session={current} diagnostic={diagnostic} /></aside></div>{newOpen && <NewSessionDialog onClose={() => setNewOpen(false)} onCreated={(name) => { setSelectedSession(name); void refreshInventory(); }} />}{presentation && <SessionPresentationDialog session={presentation} onCancel={() => setPresentation(null)} onSaved={() => { setPresentation(null); void refreshInventory(); }} />}</div>;
}
