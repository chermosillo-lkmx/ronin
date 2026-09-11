import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readLaunchRecord } from "./sessions.js";
import { cycleDirForSession, removeCycleDir } from "./stages.js";
import { removeWorktree } from "./worktree.js";

/**
 * Limpieza de lo que una sesión GESTIONADA creó al lanzarse: contenedores etiquetados con la
 * sesión, su worktree + rama efímera (sólo si no guardan trabajo sin integrar — la guarda vive
 * en worktree.removeWorktree) y su cycle dir. Una sesión ajena/terminal no tiene worktree
 * propio (su cwd es el repo del usuario) y sólo pierde el cycle dir. Nunca lanza: cada paso
 * deja su resultado en el reporte y el cierre de tmux ya ocurrió antes.
 */
export interface CleanupReport {
  kind: "managed" | "foreign";
  worktree: { status: "removed" | "kept" | "none"; path?: string; branch?: string; reason?: string };
  cycleDir: { status: "removed" | "kept" | "none"; path?: string };
  containers: { removed: string[]; failed: string[]; skipped?: string };
}

export interface CleanupDeps {
  readLaunch(name: string): unknown | null;
  cycleFor(name: string): string;
  removeWorktree(repoRoot: string, path: string, branch: string): Promise<{ removed: boolean; kept: boolean }>;
  removeCycleDir(cycle: string): void;
  listContainers(session: string): Promise<string[]>;
  removeContainer(id: string): Promise<void>;
}

interface ManagedLaunch {
  mode: "workflow";
  cwd: string;
  worktree: string;
  branch: string;
}

function managedLaunch(value: unknown): ManagedLaunch | null {
  if (!value || typeof value !== "object") return null;
  const launch = value as Partial<ManagedLaunch>;
  return launch.mode === "workflow" && typeof launch.cwd === "string" && !!launch.cwd
    && typeof launch.worktree === "string" && !!launch.worktree
    && typeof launch.branch === "string" && !!launch.branch
    ? launch as ManagedLaunch
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "fallo desconocido";
}

function isMissingExecutable(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function matchesSession(name: string, containerName: string): boolean {
  return containerName === name || containerName.startsWith(`${name}-`) || containerName.startsWith(`${name}_`);
}

export async function cleanupSession(name: string, deps: CleanupDeps): Promise<CleanupReport> {
  const launch = managedLaunch(deps.readLaunch(name));
  const cycle = deps.cycleFor(name);
  const cycleExists = existsSync(cycle);
  const report: CleanupReport = {
    kind: launch ? "managed" : "foreign",
    worktree: { status: "none" },
    cycleDir: { status: "none" },
    containers: { removed: [], failed: [] },
  };

  if (launch) {
    try {
      const ids = await deps.listContainers(name);
      for (const id of ids) {
        try {
          await deps.removeContainer(id);
          report.containers.removed.push(id);
        } catch {
          report.containers.failed.push(id);
        }
      }
    } catch (error) {
      report.containers.skipped = isMissingExecutable(error) ? "docker no disponible" : errorMessage(error);
    }

    try {
      const result = await deps.removeWorktree(launch.cwd, launch.worktree, launch.branch);
      report.worktree = result.removed
        ? { status: "removed", path: launch.worktree, branch: launch.branch }
        : { status: "kept", path: launch.worktree, branch: launch.branch, reason: result.kept ? "tiene trabajo sin integrar" : "no se pudo eliminar" };
    } catch (error) {
      report.worktree = { status: "kept", path: launch.worktree, branch: launch.branch, reason: errorMessage(error) };
    }
  }

  if (!cycleExists) return report;
  if (report.worktree.status === "kept") {
    report.cycleDir = { status: "kept", path: cycle };
    return report;
  }
  try {
    deps.removeCycleDir(cycle);
    report.cycleDir = { status: "removed", path: cycle };
  } catch {
    report.cycleDir = { status: "kept", path: cycle };
  }
  return report;
}

function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 15_000, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function containerRows(output: string): Array<{ id: string; name: string }> {
  return output.split("\n").map((line) => {
    const [id = "", name = ""] = line.trim().split("\t", 2);
    return { id, name };
  }).filter((row) => !!row.id && !!row.name);
}

export const realCleanupDeps: CleanupDeps = {
  readLaunch: readLaunchRecord,
  cycleFor: cycleDirForSession,
  removeWorktree,
  removeCycleDir,
  listContainers: async (session) => {
    const format = "{{.ID}}\t{{.Names}}";
    const [labeled, named] = await Promise.all([
      runDocker(["ps", "-a", "--format", format, "--filter", `label=cowork.session=${session}`]),
      runDocker(["ps", "-a", "--format", format, "--filter", `name=${session}`]),
    ]);
    const ids = new Set(containerRows(labeled).map((row) => row.id));
    for (const row of containerRows(named)) {
      if (matchesSession(session, row.name)) ids.add(row.id);
    }
    return [...ids];
  },
  removeContainer: async (id) => { await runDocker(["rm", "-f", id]); },
};
