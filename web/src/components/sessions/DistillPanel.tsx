import { useEffect, useRef, useState } from "react";
import { distillSession } from "../../api";
import type { DistillState, SessionMemoryInfo } from "../../types";
import { runExclusive } from "../in-flight";

export function distillLabel(state: DistillState | null): string {
  if (!state) return "Sin destilar";
  if (state.status === "running") return "Destilando aprendizajes…";
  if (state.status === "failed") return `Falló: ${state.error ?? "error desconocido"}`;
  if (state.status === "skipped") return `Omitida: ${state.reason ?? "sin motivo registrado"}`;
  const proposed = state.proposed ?? 0;
  if (!proposed) return "Sin aprendizajes nuevos";
  return `${proposed} ${proposed === 1 ? "propuesta" : "propuestas"} para revisar`;
}

/**
 * Estado de la destilación de la sesión y el botón para destilar o reintentar. El botón queda
 * deshabilitado mientras su POST está en curso; `initialBusy` sólo existe para las pruebas SSR.
 */
export function DistillPanel({ session, memory, initialBusy = false }: { session: string; memory: SessionMemoryInfo; initialBusy?: boolean }) {
  const [state, setState] = useState<DistillState | null>(memory.distill);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(initialBusy);
  const lock = useRef(false);
  useEffect(() => { setState(memory.distill); }, [session, memory.distill?.status, memory.distill?.at]);
  const run = async () => {
    try {
      await runExclusive(lock, setBusy, async () => {
        setError("");
        setState(await distillSession(session));
      });
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return <div className="ron-distill">
    <span className="ronin-eyebrow">memoria</span>
    <p className={`ron-distill-status ${state?.status ?? "none"}`}>{distillLabel(state)}</p>
    {memory.pending > 0 && <small>{`${memory.pending} ${memory.pending === 1 ? "pendiente" : "pendientes"} en ${memory.repo} · revísalas en Configuración`}</small>}
    <button type="button" className="n-btn n-btn-secondary" disabled={busy || state?.status === "running"} onClick={() => void run()}>{state?.status === "failed" ? "Reintentar" : "Destilar aprendizajes"}</button>
    {error && <p className="ronin-form-error">{error}</p>}
  </div>;
}
