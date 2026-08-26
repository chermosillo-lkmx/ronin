import { useEffect, useRef, useState } from "react";
import { getTmuxInventory } from "../api";

/**
 * Superficie 8. En F1 informa de lo único que se puede medir sin inventar nada: si el backend
 * responde y cuántas sesiones/panes ve. Los contadores de ciclo y gates entran en F3, cuando el
 * editor de workflows los produce.
 */
export function StatusBar() {
  const [stat, setStat] = useState<{ sessions: number; panes: number; error?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    // setTimeout recursivo, igual que el poller del engine (engine.ts:1794-1801): un poll lento
    // nunca se solapa con el siguiente. 15 s y no 5: la barra es un indicador de vida, no un
    // monitor, y golpea el mismo endpoint que la pantalla de Sesiones — a 5 s se duplicaba el
    // gasto de tmux por cada pestaña abierta.
    const tick = async () => {
      const inventory = await getTmuxInventory();
      if (!alive) return;
      setStat(inventory === null ? null : {
        sessions: inventory.sessions.length,
        panes: inventory.sessions.reduce((n, x) => n + x.panes.length, 0),
        error: inventory.diagnostic?.code,
      });
      timer.current = window.setTimeout(tick, 15000);
    };
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <footer className="ron-status">
      <span className="ron-status-item">
        <span className={`ron-status-dot ${stat ? "on" : "off"}`} />
        {stat ? (stat.error ? `tmux: ${stat.error}` : "server ok") : "server sin respuesta"}
      </span>
      {stat && (
        <span>
          {stat.sessions} sesión(es) · {stat.panes} panes
        </span>
      )}
      <span className="ron-status-spacer" />
      <span>Ronin</span>
    </footer>
  );
}
