import { useEffect, useState } from "react";
import { getPreflight } from "../api";
import type { PreflightCheck } from "../types";

/**
 * Superficie 6. Los checks son datos que llegan del server, no ramas de este componente:
 * `node-pty` y los binarios del entorno comparten el mismo registro y esta pantalla los pinta.
 *
 * No se pollea: cada llamada lanza 4 subprocesos. Se carga al montar y con un botón explícito.
 */
export function PreflightScreen() {
  const [checks, setChecks] = useState<PreflightCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [down, setDown] = useState(false);

  const load = () => {
    setBusy(true);
    getPreflight()
      .then((c) => {
        setDown(c === null);
        if (c) setChecks(c);
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    // `load` es estable en la práctica y sólo se quiere en el montaje; declararla como
    // dependencia obligaría a un useCallback que no aporta nada aquí.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const passed = checks.filter((c) => c.level === "ok").length;

  return (
    <div className="nocturne ron-preflight">
      <div className="ron-preflight-inner">
        <h2 className="ron-pf-title">
          {checks.length > 0 && passed === checks.length ? "Ronin listo" : "Ronin casi listo"}
        </h2>
        <p className="ron-pf-sub">
          {passed} de {checks.length} comprobaciones pasaron
        </p>

        {down && <p className="ron-msg err">No se pudo consultar el preflight. ¿Está el server arriba?</p>}

        <div className="ron-pf-list">
          {checks.map((c) => (
            <div key={c.key} className="card elev-sm">
              <div className="ron-pf-row">
                <span className={`ron-dot ${c.level}`} />
                <strong className="ron-pf-label">{c.label}</strong>
                <span className="ron-pf-spacer" />
                <span className="ron-pf-detail">{c.detail}</span>
              </div>
              {c.note && <p className="ron-pf-note">{c.note}</p>}
            </div>
          ))}
        </div>

        <button className="n-btn n-btn-secondary" onClick={load} disabled={busy}>
          {busy ? "Comprobando…" : "Volver a comprobar"}
        </button>
      </div>
    </div>
  );
}
