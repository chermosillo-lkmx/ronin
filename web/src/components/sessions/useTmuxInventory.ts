import { useCallback, useEffect, useRef, useState } from "react";
import { getTmuxInventory } from "../../api";
import type { TmuxDiagnostic, TmuxSessionInfo } from "../../types";

export function useTmuxInventory() {
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [diagnostic, setDiagnostic] = useState<TmuxDiagnostic | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const timer = useRef<number | undefined>();
  const refreshInventory = useCallback(async () => {
    const inventory = await getTmuxInventory();
    if (!inventory) { setDiagnostic({ code: "TMUX_INVENTORY_FAILED", detail: "El backend local no respondió." }); return; }
    setDiagnostic(inventory.diagnostic);
    if (!inventory.diagnostic) {
      setSessions(inventory.sessions);
      setSelectedSession((current) => current && inventory.sessions.some((item) => item.name === current) ? current : inventory.sessions.find((item) => item.kind === "managed")?.name ?? inventory.sessions[0]?.name ?? null);
    }
  }, []);
  useEffect(() => { let alive = true; const tick = async () => { await refreshInventory(); if (alive) timer.current = window.setTimeout(tick, 5000); }; void tick(); return () => { alive = false; window.clearTimeout(timer.current); }; }, [refreshInventory]);
  return { sessions, diagnostic, selectedSession, setSelectedSession, refreshInventory };
}
