import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HistoryEvent } from "../history.js";
import { readHistory } from "../history.js";
import type { Commit } from "../report-git.js";
import { commitsFor } from "../report-git.js";
import { listRepos, resolveCwd } from "../repos.js";
import type { AnalysisRange } from "./model.js";

/**
 * Recolección de señales acotadas para proponer workflows: agrupa `history()` por
 * task key, cortes de git commits por repo, y evidencia (EVIDENCIA-*.md / research.md)
 * modificada dentro del rango. Todo pasa por `deps` (puro, sin I/O directo salvo en
 * `defaultSignalDeps`) para poder testear con fakes.
 */

export interface TaskSignal {
  key: string;
  title: string;
  source: string;
  repo: string;
  launches: number;
  stops: number;
  completes: number;
  firstTs: number;
  lastTs: number;
  lastEvidence?: string;
  body?: string;
}

export interface EvidenceSignal {
  repo: string;
  file: string;
  mtime: number;
  excerpt: string;
}

export interface Signals {
  range: { from: string; to: string };
  tasks: TaskSignal[];
  commits: Record<string, { hash: string; subject: string; ts: number }[]>;
  evidence: EvidenceSignal[];
}

export interface SignalDeps {
  history: (from: number, to: number) => HistoryEvent[]; // default readHistory
  commits: (repos: string[], from: Date, to: Date) => Promise<Record<string, Commit[]>>; // default commitsFor
  repos: () => string[]; // default listRepos
  resolveCwd: (repo: string) => { cwd: string; real: boolean };
  readDir?: (dir: string) => { name: string; mtime: number }[]; // default readdirSync+statSync
  readFile?: (file: string, maxBytes: number) => string;
}

export const LIMITS = { tasks: 80, commitsPerRepo: 60, evidenceFiles: 15, evidenceBytes: 3072 };

const EVIDENCE_NAME = /^EVIDENCIA-.*\.md$|^research\.md$/i;
const BODY_MAX = 300;
const LAST_EVIDENCE_MAX = 500;

function truncateChars(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function defaultReadDir(dir: string): { name: string; mtime: number }[] {
  return readdirSync(dir).map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }));
}

function defaultReadFile(file: string, maxBytes: number): string {
  const buf = readFileSync(file);
  return buf.subarray(0, maxBytes).toString("utf8");
}

export const defaultSignalDeps: SignalDeps = {
  history: readHistory,
  commits: commitsFor,
  repos: listRepos,
  resolveCwd,
  readDir: defaultReadDir,
  readFile: defaultReadFile,
};

function collectTasks(events: HistoryEvent[]): TaskSignal[] {
  const byKey = new Map<string, TaskSignal>();
  const bodyTs = new Map<string, number>();
  const evidenceTs = new Map<string, number>();

  for (const ev of events) {
    let t = byKey.get(ev.key);
    if (!t) {
      t = {
        key: ev.key,
        title: ev.title,
        source: ev.source,
        repo: ev.repo,
        launches: 0,
        stops: 0,
        completes: 0,
        firstTs: ev.ts,
        lastTs: ev.ts,
      };
      byKey.set(ev.key, t);
    }
    if (ev.type === "launch") t.launches++;
    else if (ev.type === "stop") t.stops++;
    else if (ev.type === "complete") t.completes++;
    t.firstTs = Math.min(t.firstTs, ev.ts);
    t.lastTs = Math.max(t.lastTs, ev.ts);

    const prevBodyTs = bodyTs.get(ev.key);
    if (ev.body !== undefined && (prevBodyTs === undefined || ev.ts >= prevBodyTs)) {
      t.body = truncateChars(ev.body, BODY_MAX);
      bodyTs.set(ev.key, ev.ts);
    }
    const prevEvidenceTs = evidenceTs.get(ev.key);
    if (ev.evidence !== undefined && (prevEvidenceTs === undefined || ev.ts >= prevEvidenceTs)) {
      t.lastEvidence = truncateChars(ev.evidence, LAST_EVIDENCE_MAX);
      evidenceTs.set(ev.key, ev.ts);
    }
  }

  const tasks = [...byKey.values()];
  tasks.sort((a, b) => b.launches + b.stops + b.completes - (a.launches + a.stops + a.completes));
  return tasks.slice(0, LIMITS.tasks);
}

async function collectCommits(deps: SignalDeps, range: AnalysisRange): Promise<Signals["commits"]> {
  const raw = await deps.commits(deps.repos(), range.from, range.to);
  const out: Signals["commits"] = {};
  for (const [label, commits] of Object.entries(raw)) {
    out[label] = commits.slice(0, LIMITS.commitsPerRepo).map((c) => ({ hash: c.hash, subject: c.subject, ts: c.ts }));
  }
  return out;
}

function collectEvidence(deps: SignalDeps, range: AnalysisRange): EvidenceSignal[] {
  const readDir = deps.readDir ?? defaultReadDir;
  const readFile = deps.readFile ?? defaultReadFile;
  const fromMs = range.from.getTime();
  const toMs = range.to.getTime();
  const seenCwd = new Set<string>();
  const evidence: EvidenceSignal[] = [];

  for (const repo of deps.repos()) {
    try {
      const { cwd, real } = deps.resolveCwd(repo);
      if (!real || seenCwd.has(cwd)) continue;
      seenCwd.add(cwd);

      const entries = readDir(cwd)
        .filter((e) => EVIDENCE_NAME.test(e.name) && e.mtime >= fromMs && e.mtime <= toMs)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, LIMITS.evidenceFiles);

      for (const entry of entries) {
        const excerpt = readFile(join(cwd, entry.name), LIMITS.evidenceBytes);
        evidence.push({ repo, file: entry.name, mtime: entry.mtime, excerpt });
      }
    } catch {
      /* best-effort: omite este repo (carpeta faltante, sin permisos, etc.) */
    }
  }

  return evidence;
}

export async function collectSignals(range: AnalysisRange, deps: SignalDeps): Promise<Signals> {
  const events = deps.history(range.from.getTime(), range.to.getTime());
  const tasks = collectTasks(events);
  const commits = await collectCommits(deps, range);
  const evidence = collectEvidence(deps, range);

  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    tasks,
    commits,
    evidence,
  };
}
