import React from "react";
import type { SessionUsageLimit, TmuxDiagnostic, TmuxSessionInfo } from "../types";

export function usageLimitLabel(limit: SessionUsageLimit): string {
  const tool = limit.tool === "claude" ? "Claude" : "Codex";
  const state = limit.state === "reached" ? "límite alcanzado" : "cerca del límite";
  return `${limit.state === "reached" ? "⏳" : "⚠"} ${tool}: ${state}${limit.resetAt ? ` · reinicia ${limit.resetAt}` : ""}`;
}

/** The TUI warning is best-effort; neither CLI provides a local quota percentage to display. */
export function DesktopStatusBar({ current, diagnostic, decisions, usageLimit }: {
  current: TmuxSessionInfo | null;
  diagnostic: TmuxDiagnostic | null;
  decisions: number;
  usageLimit: SessionUsageLimit | null;
}) {
  return <footer className="ronin-statusbar"><span className="ronin-mark" /><strong>Ronin</strong><span className="ronin-title-context">{current?.presentation?.title || current?.name || "sin sesión"}</span><span className="ronin-title-spacer" />{decisions > 0 && <span className="ronin-attention-count">⚠ {decisions} esperando decisión</span>}{usageLimit && <span className="ronin-attention-count">{usageLimitLabel(usageLimit)}</span>}<span className={`ronin-health ${diagnostic ? "error" : ""}`}>{diagnostic ? diagnostic.code : "tmux listo"}</span></footer>;
}
