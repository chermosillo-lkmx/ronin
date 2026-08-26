import { useEffect, useRef, useState } from "react";
import { getTmuxInventory, releaseAdoptionRequest } from "../api";
import { AdoptDialog } from "../components/AdoptDialog";
import { NativeTerminal } from "../components/NativeTerminal";
import { PaneViewer } from "../components/PaneViewer";
import { SessionSidebar } from "../components/SessionSidebar";
import type { TmuxDiagnostic, TmuxSessionInfo } from "../types";

/**
 * Superficie 1. Muestra el inventario tmux completo (gestionadas + ajenas). El render por pane
 * (PaneViewer) es de sólo lectura por diseño y puede montarse solo (P4: capture-pane no muta).
 * La adopción (F2) exige un gesto explícito con confirmación (AdoptDialog); la ventana completa
 * (NativeTerminal, PTY crudo) TAMBIÉN exige gesto explícito — nunca se monta sola, porque sus
 * teclas van al pane ACTIVO de la ventana, no a uno concreto.
 */
export function SessionsScreen() {
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [down, setDown] = useState(false);
  const [diagnostic, setDiagnostic] = useState<TmuxDiagnostic | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    // setTimeout recursivo y NO setInterval: es el patrón del poller del engine
    // (engine.ts:1794-1801), y por la misma razón — un poll que tarde más que el intervalo
    // nunca se solapa con el siguiente tick. 6 s: esta pantalla es un inventario, no un monitor.
    const tick = async () => {
      const inventory = await getTmuxInventory();
      if (!alive) return;
      if (inventory === null) {
        setDown(true);
        setDiagnostic(null);
      } else {
        setDown(Boolean(inventory.diagnostic));
        setDiagnostic(inventory.diagnostic);
        setSessions(inventory.sessions);
        // Selección inicial: la primera gestionada, o la primera que haya. Se hace dentro del
        // updater para no depender de `selected` y re-suscribir el efecto en cada tick.
        setSelected((cur) => cur ?? inventory.sessions.find((x) => x.kind === "managed")?.name ?? inventory.sessions[0]?.name ?? null);
      }
      timer.current = window.setTimeout(tick, 6000);
    };
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const current = sessions.find((s) => s.name === selected) ?? null;

  return (
    <div className="nocturne ron-sessions">
      <SessionSidebar
        sessions={sessions}
        selected={selected}
        onSelect={setSelected}
        filter={filter}
        onFilter={setFilter}
      />
      <main className="ron-main">
        {down && (
          <p className="ron-msg err">
            {diagnostic
              ? `No se pudo leer tmux (${diagnostic.code}): ${diagnostic.detail}`
              : "No se pudo leer el inventario de tmux. ¿Está el server arriba?"}
          </p>
        )}
        {!current && !down && <p className="ron-msg">Ninguna sesión seleccionada.</p>}
        {current && <SessionDetail s={current} onChanged={() => { void getTmuxInventory().then((r) => r && setSessions(r.sessions)); }} />}
      </main>
    </div>
  );
}

function SessionDetail({ s, onChanged }: { s: TmuxSessionInfo; onChanged: () => void }) {
  const [paneId, setPaneId] = useState<string | undefined>(s.panes[0]?.id);
  const [showAdopt, setShowAdopt] = useState(false);
  const [showRawWindow, setShowRawWindow] = useState(false);
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    setPaneId((current) => current && s.panes.some((pane) => pane.id === current) ? current : s.panes[0]?.id);
    setShowRawWindow(false);
  }, [s.name, s.panes]);

  async function release() {
    setReleasing(true);
    await releaseAdoptionRequest(s.name);
    setReleasing(false);
    onChanged();
  }

  return (
    <>
      <header className="ron-detail-head">
        <h2>{s.name}</h2>
        <div className="ron-detail-meta">
          <span className={s.kind === "managed" ? "tag tag-accent" : "tag tag-neutral"}>
            {s.kind === "managed" ? "gestionada" : "ajena"}
          </span>{" "}
          · {s.windows} ventana(s) · creada {new Date(s.createdAt).toLocaleString("es-MX")}
        </div>
      </header>

      {s.kind === "foreign" && (
        <p className="ron-note">
          Ronin no escribe en una sesión ajena.{" "}
          <button type="button" className="ron-link-button" onClick={() => setShowAdopt(true)}>
            Adoptarla
          </button>{" "}
          crea su cycle dir y habilita el terminal gestionado.
        </p>
      )}
      {s.kind === "managed" && s.adopted && (
        <p className="ron-note">
          Sesión adoptada.{" "}
          <button type="button" className="ron-link-button" onClick={() => void release()} disabled={releasing}>
            {releasing ? "Soltando…" : "Soltar adopción"}
          </button>{" "}
          (no mata la sesión ni borra su cycle dir).
        </p>
      )}

      {showAdopt && (
        <AdoptDialog
          session={s}
          onCancel={() => setShowAdopt(false)}
          onAdopted={() => { setShowAdopt(false); onChanged(); }}
        />
      )}

      <table className="table">
        <thead>
          <tr>
            <th>pane</th>
            <th>win</th>
            <th>comando</th>
            <th>rol</th>
          </tr>
        </thead>
        <tbody>
          {s.panes.map((p) => (
            <tr key={p.id} className={paneId === p.id ? "ron-pane-selected" : undefined}>
              <td className="ron-mono">
                <button className="ron-pane-button" type="button" onClick={() => setPaneId(p.id)}>{p.id}</button>
              </td>
              <td>{p.windowIndex}</td>
              <td>{p.command || "—"}</td>
              <td>{p.role ?? "—"}</td>
            </tr>
          ))}
          {s.panes.length === 0 && (
            <tr>
              <td colSpan={4} className="ron-empty-cell">sin panes listados</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="ron-terminal-section">
        <header className="ron-detail-head ron-terminal-head">
          <div>
            <h3>Pane {paneId ?? ""}</h3>
            <div className="ron-detail-meta">
              render por pane · destino tmux estable por %N ·{" "}
              {s.kind === "managed" ? "escritura habilitada" : "sólo lectura (sesión ajena)"}
            </div>
          </div>
          <span className="tag tag-neutral">{s.kind === "foreign" ? "sesión ajena" : "escritura dirigida"}</span>
        </header>
        {paneId ? (
          <PaneViewer session={s.name} paneId={paneId} kind={s.kind} />
        ) : (
          <p className="ron-msg">No hay un pane disponible para abrir.</p>
        )}

        <div className="ron-raw-window">
          {!showRawWindow ? (
            <button type="button" onClick={() => setShowRawWindow(true)}>
              Abrir ventana completa (PTY crudo)
            </button>
          ) : (
            <>
              <p className="ron-note ron-warn">
                Ventana completa: las teclas van al pane ACTIVO de la ventana tmux, no a {paneId}.
                Úsala solo si sabes lo que estás mirando.
              </p>
              <NativeTerminal session={s.name} paneId={paneId} />
            </>
          )}
        </div>
      </section>
    </>
  );
}
