import { deliverPromptWhenReady } from "./engine.js";
import { getRepoGate, type RepoGate } from "./repo-config.js";
import { readLaunchRecord, readTmuxInventory } from "./sessions.js";
import { readGateSettings, type GateSettings } from "./settings.js";
import { cycleDirForSession, detectStage, readFlow } from "./stages.js";
import { realGateDeps, type DriverDeps, type GateStage, type LaunchInfo } from "./verify-driver.js";
import { resolveFlow } from "./workflow.js";

type InventorySession = {
  name: string;
  kind: "managed" | "foreign";
  attention?: { level?: string };
  panes?: Array<{ id: string; windowIndex: number; role: string | null }>;
};

/**
 * El pane conductor de una sesión, como `%N`: el `driver` del arreglo de 4 panes si existe; si no,
 * el ÚNICO pane de la ventana 0 (la que creó Ronin; las demás las abre el conductor para delegar).
 * `%N` es estable mientras el pane viva y tmux no lo reutiliza; `-t <sesión>` iría al pane activo,
 * que puede ser otro agente. null si no hay uno inequívoco.
 */
export function conductorPane(session: InventorySession | undefined): string | null {
  const panes = session?.panes ?? [];
  const driver = panes.filter((pane) => pane.role === "driver");
  if (driver.length === 1) return driver[0]!.id;
  const ventana0 = panes.filter((pane) => pane.windowIndex === 0);
  return ventana0.length === 1 ? ventana0[0]!.id : null;
}

export interface VerifyDriverDepSources {
  readTmuxInventory(): Promise<{ sessions: InventorySession[]; diagnostic: unknown | null }>;
  readLaunch(name: string): unknown | null | undefined;
  readFlow(cycle: string): { stages: GateStage[] } | null;
  resolveFlow(stageKeys: undefined, repo: string): { stages: GateStage[]; verifyAfter: string[] };
  cycleDirForSession(name: string): string;
  detectStage(cycle: string, order: string[]): string | null;
  gateSettings(): GateSettings;
  repoGate(repo: string): RepoGate;
  /** Escribe un prompt en ese pane (`%N`) cuando su CLI está lista; false/throw = no llegó. */
  deliverPrompt(target: string, text: string): Promise<boolean>;
}

/** Carpeta propia de reportes del gate de Ronin, relativa al worktree (la lee unit-gate.sh). */
export const GATE_REPORTS_DIR = "reports/ronin-gate";

/** Timeout y entorno del gate: el override del repo gana al global; xdist sólo si el repo lo declara. */
export function gateConfigFrom(global: GateSettings, repo: RepoGate): { timeoutMs: number; env: Record<string, string> } {
  return {
    timeoutMs: (repo.timeoutMin ?? global.timeoutMin) * 60_000,
    env: { UNIT_GATE_REPORTS_DIR: GATE_REPORTS_DIR, ...(repo.xdist ? { UNIT_GATE_XDIST: String(repo.xdist) } : {}) },
  };
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
    flowFor: (session, repo) => sources.readFlow(sources.cycleDirForSession(session))?.stages ?? sources.resolveFlow(undefined, repo).stages,
    cycleFor: sources.cycleDirForSession,
    detect: sources.detectStage,
    ...realGateDeps,
    // Se lee en cada llamada: un cambio en settings.json o repo-config.json aplica sin reiniciar.
    gateConfig: (repo) => gateConfigFrom(sources.gateSettings(), sources.repoGate(repo)),
    maxConcurrent: () => sources.gateSettings().maxConcurrent,
    // El veredicto del gate de merge al pane conductor, resuelto en vivo. Cualquier fallo —sin
    // conductor inequívoco, tmux ilegible, CLI ausente— es `false`: el driver lo anota como
    // `notify: "failed"` y no reintenta. Nunca cae al pane activo de la sesión.
    notify: async (session, text) => {
      try {
        const inventory = await sources.readTmuxInventory();
        if (inventory.diagnostic) return false;
        const target = conductorPane(inventory.sessions.find((entry) => entry.name === session && entry.kind === "managed"));
        if (!target) return false;
        return (await sources.deliverPrompt(target, text)) === true;
      } catch {
        return false;
      }
    },
    logError: (error) => console.error("[claude-cowork]", error),
  };
}

export const realVerifyDriverDeps = createVerifyDriverDeps({
  readTmuxInventory,
  readLaunch: readLaunchRecord,
  readFlow,
  resolveFlow,
  cycleDirForSession,
  detectStage,
  gateSettings: () => readGateSettings(),
  repoGate: getRepoGate,
  // Captura y envío usan el mismo `%N`: deliverPromptWhenReady apunta todo a ese target.
  deliverPrompt: (target, text) => deliverPromptWhenReady(target, text),
});
