import { readLaunchRecord, readTmuxInventory } from "./sessions.js";
import { cycleDirForSession, detectStage } from "./stages.js";
import { realGateDeps, type DriverDeps, type GateStage, type LaunchInfo } from "./verify-driver.js";
import { resolveFlow } from "./workflow.js";

type InventorySession = {
  name: string;
  kind: "managed" | "foreign";
  attention?: { level?: string };
};

export interface VerifyDriverDepSources {
  readTmuxInventory(): Promise<{ sessions: InventorySession[]; diagnostic: unknown | null }>;
  readLaunch(name: string): unknown | null | undefined;
  resolveFlow(stageKeys: undefined, repo: string): { stages: GateStage[]; verifyAfter: string | null };
  cycleDirForSession(name: string): string;
  detectStage(cycle: string, order: string[]): string | null;
}

function launchInfo(raw: unknown): LaunchInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const { mode, repo, worktree } = raw as { mode?: unknown; repo?: unknown; worktree?: unknown };
  if ((mode !== "workflow" && mode !== "terminal") || typeof repo !== "string") return null;
  return typeof worktree === "string" ? { mode, repo, worktree } : { mode, repo };
}

/** Arma el driver real, dejando las fronteras de tmux y disco inyectables para pruebas. */
export function createVerifyDriverDeps(sources: VerifyDriverDepSources): DriverDeps {
  return {
    listSessions: async () => {
      const inventory = await sources.readTmuxInventory();
      if (inventory.diagnostic) return [];
      return inventory.sessions
        .filter((session) => session.kind === "managed")
        .map((session) => ({ name: session.name, busy: session.attention?.level === "working" }));
    },
    launchOf: (session) => {
      try {
        return launchInfo(sources.readLaunch(session));
      } catch {
        return null;
      }
    },
    flowFor: (repo) => sources.resolveFlow(undefined, repo).stages,
    cycleFor: sources.cycleDirForSession,
    detect: sources.detectStage,
    ...realGateDeps,
    logError: (error) => console.error("[claude-cowork]", error),
  };
}

export const realVerifyDriverDeps = createVerifyDriverDeps({
  readTmuxInventory,
  readLaunch: readLaunchRecord,
  resolveFlow,
  cycleDirForSession,
  detectStage,
});
