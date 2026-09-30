import { useEffect, useRef, useState } from "react";
import { getRepoSkillLearning, setRepoSkillLearning } from "../api";
import type { SkillLearningView } from "../types";
import { runExclusive } from "./in-flight";

const LOAD_ERROR = "No se pudo leer el aprendizaje de skills de este repo.";

/**
 * Interruptor "Aprender skills" de un repo, junto a Memoria. `initial` undefined = se carga solo;
 * `initialBusy` sólo existe para las pruebas SSR. Apagarlo sólo detiene el triaje de ese repo: la
 * propuesta manual desde el inspector sigue disponible.
 */
export function RepoSkillLearningToggle({ repo, initial, initialBusy = false }: { repo: string; initial?: SkillLearningView | null; initialBusy?: boolean }) {
  const [view, setView] = useState<SkillLearningView | null>(initial ?? null);
  const [busy, setBusy] = useState(initialBusy);
  const [error, setError] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    if (initial !== undefined) return;
    void getRepoSkillLearning(repo).then(
      (loaded) => { if (loaded) setView(loaded); else setError(LOAD_ERROR); },
      () => setError(LOAD_ERROR),
    );
  }, [repo]);
  const change = async (enabled: boolean) => {
    try {
      const next = await runExclusive(lock, setBusy, () => setRepoSkillLearning(repo, enabled));
      if (next) {
        setView(next);
        setError("");
      }
    } catch (failure) {
      setError((failure as Error).message);
    }
  };
  return <div className="ron-skill-learning">
    <label className="ron-mem-toggle">
      <input type="checkbox" checked={view?.enabled ?? false} disabled={!view || !view.globalEnabled || busy} onChange={(event) => void change(event.target.checked)} />
      <span>🧩 Aprender skills</span>
    </label>
    {view && !view.globalEnabled && <small>Desactivado en este equipo (COWORK_LEARNED_SKILLS=0).</small>}
    {view?.enabled && view.globalEnabled && <small>Al terminar un flujo con sus gates aprobados, Ronin puede proponer una skill; nada entra sin tu aprobación.</small>}
    {error && <p className="ron-mem-note error" role="alert">{error}</p>}
  </div>;
}
