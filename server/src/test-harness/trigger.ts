import type { TestTrigger } from "./model.js";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

export interface LaunchRecord {
  session: string;
  worktree?: string;
  cwd?: string;
  inputs?: Record<string, string>;
  request?: string;
}

export interface TriggerDeps {
  git(dir: string, args: string[]): Promise<string>;
  listLaunches(): LaunchRecord[];
}

const execFileAsync = promisify(execFile);
const TICKET_RE = /(?:CU-)?86[a-z0-9]{7}/i;

function normalizedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function presentExplicit(explicit: Partial<TestTrigger> | undefined): Partial<TestTrigger> {
  if (!explicit) return {};
  return Object.fromEntries(Object.entries(explicit).filter(([key, value]) => key !== "source" && typeof value === "string" && value.trim())) as Partial<TestTrigger>;
}

export async function deriveTrigger(input: { explicit?: Partial<TestTrigger>; dir: string }, deps: TriggerDeps): Promise<TestTrigger> {
  const dir = normalizedPath(input.dir);
  const launch = deps.listLaunches()
    .flatMap((item) => {
      const location = item.worktree ?? item.cwd;
      return location ? [{ item, location: normalizedPath(location) }] : [];
    })
    .filter(({ location }) => contains(location, dir))
    .sort((a, b) => b.location.length - a.location.length)[0];

  const derived: Partial<TestTrigger> = {};
  if (launch) {
    derived.session = launch.item.session;
    derived.worktree = launch.location;
    const ticket = launch.item.inputs?.ticket?.trim() || `${launch.item.session}\n${launch.item.request ?? ""}`.match(TICKET_RE)?.[0];
    if (ticket) derived.ticket = ticket;
  }
  try {
    const commit = (await deps.git(dir, ["rev-parse", "--short", "HEAD"])).trim();
    if (commit) derived.commit = commit;
  } catch {
    // A JUnit folder need not be a git repository.
  }
  try {
    const branch = (await deps.git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch) derived.branch = branch;
  } catch {
    // Same tolerance as commit derivation.
  }

  const explicit = presentExplicit(input.explicit);
  const hasExplicit = Object.keys(explicit).length > 0;
  const hasDerived = Object.keys(derived).length > 0;
  return {
    ...derived,
    ...explicit,
    source: hasExplicit ? (hasDerived ? "mixed" : "explicit") : "derived",
  };
}

export async function gitText(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout;
}

/** Reads managed launch records without depending on the stages write module. */
export function listLaunches(): LaunchRecord[] {
  const root = "/tmp";
  let entries: string[];
  try {
    entries = readdirSync(root).filter((entry) => entry.startsWith("cowork-cycle-"));
  } catch {
    return [];
  }
  const launches: LaunchRecord[] = [];
  for (const entry of entries) {
    try {
      const value = JSON.parse(readFileSync(join(root, entry, "launch.json"), "utf8")) as Partial<LaunchRecord>;
      const fallbackSession = entry.slice("cowork-cycle-".length);
      if (typeof value.session === "string" || fallbackSession) launches.push({ ...value, session: typeof value.session === "string" ? value.session : fallbackSession });
    } catch {
      // Missing and malformed historical launch records are ignored.
    }
  }
  return launches;
}
