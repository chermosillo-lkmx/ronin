import { useEffect, useRef, useState } from "react";
import { proposeSessionSkill } from "../../api";
import type { SessionSkillInfo, SkillDistillState } from "../../types";
import { runExclusive } from "../in-flight";

export function skillStateLabel(state: SkillDistillState | null): string {
  if (!state) return "Sin proponer";
  if (state.status === "running") return "Redactando la skill…";
  if (state.status === "failed") return `Falló: ${state.error ?? "error desconocido"}`;
  if (state.status === "skipped") return `Omitida: ${state.reason ?? "sin motivo registrado"}`;
  return state.proposalId ? `Propuesta ${state.proposalId} lista para revisar en Skills → Propuestas` : "Propuesta lista para revisar en Skills → Propuestas";
}

/**
 * Parte de skill de la sesión: su estado y el botón para proponer (salta el triaje y el verifyCmd) o
 * reintentar. El botón queda deshabilitado mientras su POST está en curso; `initialBusy` es para SSR.
 */
export function SkillPanel({ session, skills, initialBusy = false }: { session: string; skills: SessionSkillInfo; initialBusy?: boolean }) {
  const [state, setState] = useState<SkillDistillState | null>(skills.state);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(initialBusy);
  const lock = useRef(false);
  useEffect(() => { setState(skills.state); }, [session, skills.state?.status, skills.state?.at]);
  const run = async () => {
    try {
      await runExclusive(lock, setBusy, async () => {
        setError("");
        setState(await proposeSessionSkill(session));
      });
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return <div className="ron-distill ron-skill-panel">
    <span className="ronin-eyebrow">skill</span>
    <p className={`ron-distill-status ${state?.status ?? "none"}`}>{skillStateLabel(state)}</p>
    <button type="button" className="n-btn n-btn-secondary" disabled={busy || state?.status === "running"} onClick={() => void run()}>{state?.status === "failed" ? "Reintentar" : "Proponer skill"}</button>
    {error && <p className="ronin-form-error">{error}</p>}
  </div>;
}
