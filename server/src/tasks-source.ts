import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchClickUpTasks } from "./clickup.js";
import { clickupToken } from "./settings.js";
import { fetchJiraTasks, jiraConfigured } from "./jira.js";
import { fetchGitLabTasks, gitlabConfigured } from "./gitlab.js";
import { MOCK_TASKS, setIntegrations, setLastSync, setTaskSource, setTasks } from "./state.js";
import type { Task, TaskSource } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

function loadSeed(file: string): Task[] {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
    return (raw.tasks ?? []) as Task[];
  } catch {
    return [];
  }
}

// ---- ClickUp ----
async function loadClickUp(): Promise<{ tasks: Task[]; source: TaskSource }> {
  if (clickupToken()) {
    try {
      const tasks = await fetchClickUpTasks();
      console.log(`[claude-cowork] ClickUp LIVE: ${tasks.length} tareas`);
      return { tasks, source: "clickup-live" };
    } catch (e) {
      console.warn(`[claude-cowork] ClickUp live falló (${(e as Error).message}) → seed`);
    }
  }
  const seed = loadSeed("clickup-seed.json");
  if (seed.length) {
    console.log(`[claude-cowork] ClickUp SEED: ${seed.length} tareas reales`);
    return { tasks: seed, source: "clickup-seed" };
  }
  console.log("[claude-cowork] ClickUp: MOCK");
  return { tasks: MOCK_TASKS, source: "mock" };
}

// ---- Jira ----
async function loadJira(): Promise<{ tasks: Task[]; live: boolean }> {
  if (jiraConfigured()) {
    try {
      const tasks = await fetchJiraTasks();
      console.log(`[claude-cowork] Jira LIVE: ${tasks.length} issues`);
      return { tasks, live: true };
    } catch (e) {
      console.warn(`[claude-cowork] Jira live falló (${(e as Error).message}) → seed`);
    }
  }
  const seed = loadSeed("jira-seed.json");
  if (seed.length) console.log(`[claude-cowork] Jira SEED: ${seed.length} issues reales`);
  return { tasks: seed, live: false };
}

// ---- GitLab ----
async function loadGitLab(): Promise<{ tasks: Task[]; live: boolean }> {
  if (gitlabConfigured()) {
    try {
      const tasks = await fetchGitLabTasks();
      console.log(`[claude-cowork] GitLab LIVE: ${tasks.length} items`);
      return { tasks, live: true };
    } catch (e) {
      console.warn(`[claude-cowork] GitLab live falló (${(e as Error).message}) → []`);
    }
  }
  return { tasks: [], live: false };
}

/** Load every source, merge, and reflect connection state in the integrations panel. */
async function loadAll(): Promise<TaskSource> {
  const [cu, jira, gitlab] = await Promise.all([loadClickUp(), loadJira(), loadGitLab()]);
  setTasks([...cu.tasks, ...jira.tasks, ...gitlab.tasks]);
  setTaskSource(cu.source);
  setIntegrations([
    { name: "ClickUp", status: cu.source === "mock" ? "pilot" : "connected" },
    { name: "Jira", status: jira.tasks.length ? "connected" : "pilot" },
    { name: "GitLab", status: gitlab.tasks.length ? "connected" : "pilot" },
  ]);
  setLastSync(Date.now());
  return cu.source;
}

export async function initTasks(): Promise<TaskSource> {
  return loadAll();
}

/** Re-sync on demand (button) or on a timer. Keeps the board on transient failure. */
export async function refreshTasks(): Promise<{ source: TaskSource; ok: boolean }> {
  try {
    const source = await loadAll();
    return { source, ok: true };
  } catch (e) {
    console.warn(`[claude-cowork] refresh falló: ${(e as Error).message} (mantengo tablero)`);
    setLastSync(Date.now());
    return { source: "clickup-seed", ok: false };
  }
}

export function startAutoRefresh(intervalMs: number): void {
  setInterval(() => {
    refreshTasks().catch(() => {});
  }, intervalMs);
}
