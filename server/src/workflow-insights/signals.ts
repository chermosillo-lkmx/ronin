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

export interface SessionSignal {
  key: string;
  title: string;
  source: string;
  repo: string;
  launches: number;
  closes: number;
  adoptions: number;
  firstTs: number;
  lastTs: number;
  lastEvidence?: string;
  request?: string;
}

export interface EvidenceSignal {
  repo: string;
  file: string;
  mtime: number;
  excerpt: string;
}

export interface Signals {
  range: { from: string; to: string };
  tasks: SessionSignal[];
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

/**
 * Corta `buf` a lo sumo `maxBytes` sin partir una secuencia UTF-8 a la mitad (lo que
 * emitiría U+FFFD y podría hacer que `Buffer.byteLength(resultado)` exceda `maxBytes`).
 * Camina byte a byte desde el inicio calculando el largo de cada secuencia por su byte
 * líder; se detiene antes del primer carácter que no quepa completo.
 */
export function truncateUtf8Bytes(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  let i = 0;
  while (i < maxBytes) {
    const byte = buf[i];
    let len: number;
    if ((byte & 0x80) === 0x00) len = 1;
    else if ((byte & 0xe0) === 0xc0) len = 2;
    else if ((byte & 0xf0) === 0xe0) len = 3;
    else if ((byte & 0xf8) === 0xf0) len = 4;
    else {
      // byte de continuación huérfano / inválido: avanza uno para no trabarse
      i++;
      continue;
    }
    if (i + len > maxBytes) break; // el próximo carácter no cabe completo
    i += len;
  }
  return buf.subarray(0, i).toString("utf8");
}

function defaultReadFile(file: string, maxBytes: number): string {
  const buf = readFileSync(file);
  return truncateUtf8Bytes(buf, maxBytes);
}

export const defaultSignalDeps: SignalDeps = {
  history: readHistory,
  commits: commitsFor,
  repos: listRepos,
  resolveCwd,
  readDir: defaultReadDir,
  readFile: defaultReadFile,
};

function collectTasks(events: HistoryEvent[]): SessionSignal[] {
  const byKey = new Map<string, SessionSignal>();
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
        closes: 0,
        adoptions: 0,
        firstTs: ev.ts,
        lastTs: ev.ts,
      };
      byKey.set(ev.key, t);
    }
    if (ev.type === "launch") t.launches++;
    else if (ev.type === "close") t.closes++;
    else if (ev.type === "adopt") t.adoptions++;
    t.firstTs = Math.min(t.firstTs, ev.ts);
    t.lastTs = Math.max(t.lastTs, ev.ts);

    const prevBodyTs = bodyTs.get(ev.key);
    if (ev.request !== undefined && (prevBodyTs === undefined || ev.ts >= prevBodyTs)) {
      t.request = truncateChars(ev.request, BODY_MAX);
      bodyTs.set(ev.key, ev.ts);
    }
    const prevEvidenceTs = evidenceTs.get(ev.key);
    if (ev.evidence !== undefined && (prevEvidenceTs === undefined || ev.ts >= prevEvidenceTs)) {
      t.lastEvidence = truncateChars(ev.evidence, LAST_EVIDENCE_MAX);
      evidenceTs.set(ev.key, ev.ts);
    }
  }

  const tasks = [...byKey.values()];
  tasks.sort((a, b) => b.launches + b.closes + b.adoptions - (a.launches + a.closes + a.adoptions));
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

interface EvidenceCandidate {
  repo: string;
  cwd: string;
  name: string;
  mtime: number;
}

function collectEvidence(deps: SignalDeps, range: AnalysisRange): EvidenceSignal[] {
  const readDir = deps.readDir ?? defaultReadDir;
  const readFile = deps.readFile ?? defaultReadFile;
  const fromMs = range.from.getTime();
  const toMs = range.to.getTime();
  const seenCwd = new Set<string>();
  const candidates: EvidenceCandidate[] = [];

  // Paso 1: recolecta candidatos de TODOS los repos primero — LIMITS.evidenceFiles
  // es un tope global, no por repo (si se cortara dentro del loop, N repos con 15
  // archivos cada uno devolverían 15×N).
  for (const repo of deps.repos()) {
    try {
      const { cwd, real } = deps.resolveCwd(repo);
      if (!real || seenCwd.has(cwd)) continue;
      seenCwd.add(cwd);

      const entries = readDir(cwd).filter(
        (e) => EVIDENCE_NAME.test(e.name) && e.mtime >= fromMs && e.mtime < toMs, // [from,to), igual que readHistory
      );
      for (const e of entries) candidates.push({ repo, cwd, name: e.name, mtime: e.mtime });
    } catch {
      /* best-effort: omite este repo (carpeta faltante, sin permisos, etc.) */
    }
  }

  // Paso 2: UN solo orden global por mtime desc y UN solo corte a LIMITS.evidenceFiles,
  // y solo entonces se leen los archivos — nunca se lee más de LIMITS.evidenceFiles.
  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, LIMITS.evidenceFiles);

  const evidence: EvidenceSignal[] = [];
  for (const c of top) {
    try {
      const excerpt = readFile(join(c.cwd, c.name), LIMITS.evidenceBytes);
      evidence.push({ repo: c.repo, file: c.name, mtime: c.mtime, excerpt });
    } catch {
      /* best-effort: omite este archivo (borrado entre el listado y la lectura, etc.) */
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
