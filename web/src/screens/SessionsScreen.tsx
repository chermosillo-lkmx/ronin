import { useEffect, useRef, useState } from "react";
import { getSessions } from "../api";
import { SessionSidebar } from "../components/SessionSidebar";
import type { TmuxSessionInfo } from "../types";

/**
 * Superficie 1 del mockup. En F1 muestra el inventario y el detalle de panes en SÓLO LECTURA;
 * el stepper, la terminal y la adopción llegan en F2/F3. Ninguna acción de esta pantalla escribe
 * en tmux.
 */
export function SessionsScreen() {
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [down, setDown] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    // setTimeout recursivo y NO setInterval: es el patrón del poller del engine
    // (engine.ts:1794-1801), y por la misma razón — un poll que tarde más que el intervalo
    // nunca se solapa con el siguiente tick. 6 s: esta pantalla es un inventario, no un monitor.
    const tick = async () => {
      const s = await getSessions();
      if (!alive) return;
      if (s === null) {
        setDown(true);
      } else {
        setDown(false);
        setSessions(s);
        // Selección inicial: la primera gestionada, o la primera que haya. Se hace dentro del
        // updater para no depender de `selected` y re-suscribir el efecto en cada tick.
        setSelected((cur) => cur ?? s.find((x) => x.kind === "managed")?.name ?? s[0]?.name ?? null);
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
          <p className="ron-msg err">No se pudo leer el inventario de tmux. ¿Está el server arriba?</p>
        )}
        {!current && !down && <p className="ron-msg">Ninguna sesión seleccionada.</p>}
        {current && <SessionDetail s={current} />}
      </main>
    </div>
  );
}

function SessionDetail({ s }: { s: TmuxSessionInfo }) {
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
          Ronin no escribe en una sesión ajena. Adoptarla (F2) crea su cycle dir y le da stepper.
        </p>
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
            <tr key={p.id}>
              <td className="ron-mono">{p.id}</td>
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
    </>
  );
}
