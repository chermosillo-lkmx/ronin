import { useEffect, useState } from "react";
import { listSkillProposals } from "../../api";

export const SKILL_PROPOSALS_POLL_MS = 30_000;

/** "🧩 N" cuando hay propuestas pendientes; "" (sin badge) cuando no. */
export function skillsBadgeLabel(count: number): string {
  return count > 0 ? `🧩 ${count}` : "";
}

/** Cuenta de propuestas pendientes para el badge del botón ▤; se sondea cada 30 s. */
export function useSkillProposalCount(intervalMs = SKILL_PROPOSALS_POLL_MS): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const items = await listSkillProposals();
        if (alive) setCount(items.length);
      } catch {
        /* sin backend: el badge se queda como estaba */
      }
      if (alive) timer = window.setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [intervalMs]);
  return count;
}
