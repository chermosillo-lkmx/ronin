import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic.js";
import { launchManagedSession as launchRealSession } from "../session-launch.js";
import { DEFAULT_MAIN_HEALTH_SETTINGS, type MainHealthSettings } from "../settings.js";
import { hasSession } from "../tmux.js";
import type { MainHealthAttribution } from "./attribution.js";

export interface Incident {
  id: string;
  repo: string;
  firstRedSha: string;
  openedAt: number;
  summary: string;
  attribution: MainHealthAttribution;
  remoteOwner?: string;
  claimSha?: string;
  claimBranch?: string;
  closedAt?: number;
}

export interface OpenIncidentInput {
  repo: string;
  firstRedSha: string;
  summary: string;
  attribution: MainHealthAttribution;
}

export interface IncidentOwner {
  session: string;
  pid: number;
  started: number;
  heartbeat: number;
}

export type ClaimOwnerResult =
  | { acquired: true; takeover: boolean; owner: IncidentOwner }
  | { acquired: false; takeover: false; owner: IncidentOwner | null };

export interface TmuxPort {
  hasSession(session: string): Promise<boolean>;
}

export interface IncidentGitRunOptions {
  input?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
}

export interface IncidentGitPort {
  run(args: string[], cwd: string, options?: IncidentGitRunOptions): Promise<string>;
}

export interface RemoteClaimResult {
  accepted: boolean;
  branch: string;
  claimSha: string;
  remoteOwner?: string;
}

export interface IncidentLaunchInput {
  repo: string;
  workflowId: "claude-plan-codex-impl";
  name: string;
  mode: "workflow";
  request: string;
}

export interface IncidentLaunchPort {
  launchManagedSession(input: IncidentLaunchInput): Promise<{ name: string }>;
}

export type EnsureFixerResult =
  | { status: "no-incident" | "disabled" | "busy"; session: null }
  | { status: "active" | "adopted" | "launched"; session: string }
  | { status: "remote-owned"; session: null; remoteOwner: string };

export interface IncidentFs {
  close: typeof closeSync;
  fsync: typeof fsyncSync;
  link: typeof linkSync;
  mkdir: typeof mkdirSync;
  open: typeof openSync;
  readdir: typeof readdirSync;
  readFile: typeof readFileSync;
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
  write: typeof writeSync;
}

export interface IncidentManagerDeps {
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: () => string;
  now?: () => number;
  pid?: () => number;
  pidAlive?: (pid: number) => boolean;
  mutexToken?: () => string;
  mutexLeaseMs?: number;
  leaseMin?: number;
  tmux?: TmuxPort;
  host?: () => string;
  git?: IncidentGitPort;
  gitEnv?: Readonly<NodeJS.ProcessEnv>;
  settings?: Partial<Pick<MainHealthSettings, "aliases" | "remoteClaim" | "autoFix" | "leaseMin">>;
  launch?: IncidentLaunchPort;
  fs?: Partial<IncidentFs>;
  atomicWrite?: (target: string, value: unknown) => void;
}

const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SHA = /^[A-Fa-f0-9]{7,64}$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ALIAS = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SAFE_MUTEX_TOKEN = /^[A-Za-z0-9-]{8,128}$/;

function safeRepo(repo: string): boolean {
  return repo.length <= 61
    && SAFE_REPO.test(repo)
    && !repo.includes("..")
    && !repo.endsWith(".")
    && !repo.toLowerCase().endsWith(".lock");
}

function assertRepo(repo: string): void {
  if (!safeRepo(repo)) throw new Error(`repo inválido: ${repo}`);
}

function assertSha(sha: string): void {
  if (!SAFE_SHA.test(sha)) throw new Error(`SHA inválido: ${sha}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIncident(value: unknown): value is Incident {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.repo === "string"
    && safeRepo(value.repo)
    && typeof value.firstRedSha === "string"
    && SAFE_SHA.test(value.firstRedSha)
    && typeof value.openedAt === "number"
    && Number.isFinite(value.openedAt)
    && typeof value.summary === "string"
    && isRecord(value.attribution)
    && value.id === `${value.repo}@${value.firstRedSha.slice(0, 7)}`
    && (value.remoteOwner === undefined || typeof value.remoteOwner === "string")
    && (value.claimSha === undefined || (typeof value.claimSha === "string" && SAFE_SHA.test(value.claimSha)))
    && (value.claimBranch === undefined || value.claimBranch === `fix/main-health-${value.repo}`)
    && ((value.claimSha === undefined) === (value.claimBranch === undefined))
    && (value.closedAt === undefined || (typeof value.closedAt === "number" && Number.isFinite(value.closedAt)));
}

function isOwner(value: unknown): value is IncidentOwner {
  return isRecord(value)
    && typeof value.session === "string"
    && SAFE_SESSION.test(value.session)
    && Number.isInteger(value.pid)
    && (value.pid as number) > 0
    && typeof value.started === "number"
    && Number.isFinite(value.started)
    && typeof value.heartbeat === "number"
    && Number.isFinite(value.heartbeat);
}

interface OwnerMutex {
  token: string;
  pid: number;
  createdAt: number;
}

interface OwnerRecoveryGuard {
  observed: OwnerMutex;
  recovery: OwnerMutex;
}

function isOwnerMutex(value: unknown): value is OwnerMutex {
  return isRecord(value)
    && typeof value.token === "string"
    && SAFE_MUTEX_TOKEN.test(value.token)
    && Number.isInteger(value.pid)
    && (value.pid as number) > 0
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt);
}

function isOwnerRecoveryGuard(value: unknown): value is OwnerRecoveryGuard {
  return isRecord(value)
    && isOwnerMutex(value.observed)
    && isOwnerMutex(value.recovery);
}

function processPidAlive(candidatePid: number): boolean {
  try {
    process.kill(candidatePid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface GitProcessError extends Error {
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

/** Ejecuta Git sin shell; input y entorno quedan visibles en el puerto para pruebas. */
export function createSpawnGitPort(): IncidentGitPort {
  return {
    run(args, cwd, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn("git", args, {
          cwd,
          env: { ...process.env, ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve(stdout);
          else {
            const error = new Error(stderr.trim() || `git terminó con código ${code}`) as GitProcessError;
            error.stderr = stderr;
            error.stdout = stdout;
            error.exitCode = code;
            reject(error);
          }
        });
        child.stdin.end(options.input ?? "");
      });
    },
  };
}

const defaultLaunchPort: IncidentLaunchPort = {
  async launchManagedSession(input) {
    // El puerto del manager usa el nombre lógico pedido; el launcher general exige prefijo cowork-.
    return launchRealSession({ ...input, name: `cowork-${input.name}` });
  },
};

function isRemoteClaimConflict(error: unknown): boolean {
  const candidate = error as Partial<GitProcessError> | undefined;
  const detail = `${candidate?.message ?? ""}\n${candidate?.stderr ?? ""}`;
  return /\[rejected\]|non-fast-forward|fetch first|already exists/i.test(detail);
}

export function createIncidentManager(deps: IncidentManagerDeps = {}) {
  const env = deps.env ?? process.env;
  const root = deps.root ?? env.MAIN_HEALTH_DIR ?? join((deps.home ?? homedir)(), ".cowork", "main-health");
  const incidentsRoot = join(root, "incidents");
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? (() => process.pid);
  const pidAlive = deps.pidAlive ?? processPidAlive;
  const mutexToken = deps.mutexToken ?? randomUUID;
  const mutexLeaseMs = deps.mutexLeaseMs ?? 30_000;
  const host = deps.host ?? hostname;
  const leaseMs = (deps.leaseMin ?? deps.settings?.leaseMin ?? DEFAULT_MAIN_HEALTH_SETTINGS.leaseMin) * 60_000;
  const tmux = deps.tmux ?? { hasSession };
  const git = deps.git ?? createSpawnGitPort();
  const gitEnv = deps.gitEnv ?? process.env;
  const launch = deps.launch ?? defaultLaunchPort;
  const aliases = deps.settings?.aliases ?? {};
  const remoteClaim = deps.settings?.remoteClaim ?? DEFAULT_MAIN_HEALTH_SETTINGS.remoteClaim;
  const autoFix = deps.settings?.autoFix ?? DEFAULT_MAIN_HEALTH_SETTINGS.autoFix;
  const fixerRuns = new Map<string, Promise<EnsureFixerResult>>();
  const atomicWrite = deps.atomicWrite ?? writeJsonAtomic;
  const fs: IncidentFs = {
    close: deps.fs?.close ?? closeSync,
    fsync: deps.fs?.fsync ?? fsyncSync,
    link: deps.fs?.link ?? linkSync,
    mkdir: deps.fs?.mkdir ?? mkdirSync,
    open: deps.fs?.open ?? openSync,
    readdir: deps.fs?.readdir ?? readdirSync,
    readFile: deps.fs?.readFile ?? readFileSync,
    rename: deps.fs?.rename ?? renameSync,
    unlink: deps.fs?.unlink ?? unlinkSync,
    write: deps.fs?.write ?? writeSync,
  };

  function incidentDir(repo: string): string {
    return join(incidentsRoot, repo);
  }

  function readIncident(repo: string): Incident | null {
    if (!safeRepo(repo)) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFile(join(incidentDir(repo), "incident.json"), "utf8") as string);
      return isIncident(parsed) && parsed.repo === repo ? clone(parsed) : null;
    } catch {
      return null;
    }
  }

  function ownerFile(repo: string): string {
    return join(incidentDir(repo), "owner.json");
  }

  function mutexFile(repo: string): string {
    return join(incidentDir(repo), "owner.mutex.json");
  }

  function parseOwner(text: string): IncidentOwner | null {
    try {
      const value: unknown = JSON.parse(text);
      return isOwner(value) ? clone(value) : null;
    } catch {
      return null;
    }
  }

  function readOwner(repo: string): IncidentOwner | null {
    if (!safeRepo(repo)) return null;
    try {
      return parseOwner(fs.readFile(ownerFile(repo), "utf8") as string);
    } catch {
      return null;
    }
  }

  function readOwnerMutex(repo: string): OwnerMutex | null {
    try {
      const value: unknown = JSON.parse(fs.readFile(mutexFile(repo), "utf8") as string);
      return isOwnerMutex(value) ? value : null;
    } catch {
      return null;
    }
  }

  function mutexRecoveryGuard(repo: string, observed: OwnerMutex, previous?: OwnerMutex): string {
    const digest = (value: unknown) => createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")
      .slice(0, 24);
    const observedHash = digest(observed);
    const generationHash = previous ? digest({ observed, previous }) : "root";
    return join(incidentDir(repo), `owner.mutex.recover-${observedHash}-${generationHash}`);
  }

  /** Prepara JSON completo fuera del destino y lo publica con link(2) exclusivo. */
  function publishJsonExclusive(target: string, temporary: string, value: unknown): boolean {
    let fd: number | undefined;
    let prepared = false;
    try {
      fd = fs.open(temporary, "wx");
      writeFully(fd, `${JSON.stringify(value)}\n`);
      fs.fsync(fd);
      prepared = true;
    } finally {
      try {
        if (fd !== undefined) fs.close(fd);
      } finally {
        if (!prepared) {
          try { fs.unlink(temporary); } catch { /* el mutex común nunca fue visible */ }
        }
      }
    }
    try {
      fs.link(temporary, target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return false;
    } finally {
      try { fs.unlink(temporary); } catch { /* el hardlink publicado conserva el inode completo */ }
    }
    return true;
  }

  function writeFully(fd: number, text: string): void {
    const data = Buffer.from(text, "utf8");
    let offset = 0;
    while (offset < data.byteLength) {
      const written = fs.write(fd, data, offset, data.byteLength - offset, offset);
      if (!Number.isInteger(written) || written <= 0) throw new Error("escritura incompleta en filesystem");
      offset += written;
    }
  }

  function publishOwnerMutex(repo: string, mutex: OwnerMutex): boolean {
    const temporary = join(incidentDir(repo), `owner.mutex.tmp-${mutex.pid}-${mutex.token}`);
    if (!publishJsonExclusive(mutexFile(repo), temporary, mutex)) return false;
    const verified = readOwnerMutex(repo);
    return verified?.token === mutex.token && verified.pid === mutex.pid;
  }

  function readRecoveryGuard(target: string): OwnerRecoveryGuard | null {
    try {
      const value: unknown = JSON.parse(fs.readFile(target, "utf8") as string);
      return isOwnerRecoveryGuard(value) ? value : null;
    } catch {
      return null;
    }
  }

  function publishRecoveryGuard(target: string, guard: OwnerRecoveryGuard): boolean {
    const temporary = `${target}.tmp-${guard.recovery.pid}-${guard.recovery.token}`;
    if (!publishJsonExclusive(target, temporary, guard)) return false;
    const verified = readRecoveryGuard(target);
    return verified?.observed.token === guard.observed.token
      && verified.observed.pid === guard.observed.pid
      && verified.recovery.token === guard.recovery.token
      && verified.recovery.pid === guard.recovery.pid;
  }

  function releaseOwnerMutex(repo: string, mutex: OwnerMutex): void {
    const current = readOwnerMutex(repo);
    if (!current || current.token !== mutex.token || current.pid !== mutex.pid) return;
    try {
      fs.unlink(mutexFile(repo));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  function acquireOwnerMutex(repo: string, ownerPid: number): OwnerMutex | null {
    const token = mutexToken();
    if (!SAFE_MUTEX_TOKEN.test(token)) throw new Error("token de mutex inválido");
    const candidate: OwnerMutex = { token, pid: ownerPid, createdAt: now() };
    if (publishOwnerMutex(repo, candidate)) return candidate;

    const occupied = readOwnerMutex(repo);
    // Un mutex publicado siempre es JSON completo. Algo ilegible falla cerrado.
    if (!occupied || mutexIsLive(occupied)) return null;

    let guardPath = mutexRecoveryGuard(repo, occupied);
    const candidateGuard: OwnerRecoveryGuard = { observed: occupied, recovery: candidate };
    const visitedPaths = new Set<string>();
    const visitedRecoveries = new Set<string>();
    while (true) {
      if (visitedPaths.has(guardPath)) throw new Error("ciclo detectado en guards de recovery");
      visitedPaths.add(guardPath);
      if (publishRecoveryGuard(guardPath, candidateGuard)) {
        const confirmed = readOwnerMutex(repo);
        if (!confirmed
          || confirmed.token !== occupied.token
          || confirmed.pid !== occupied.pid) return null;
        try {
          fs.unlink(mutexFile(repo));
        } catch (error) {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        }
        return publishOwnerMutex(repo, candidate) ? candidate : null;
      }

      const previous = readRecoveryGuard(guardPath);
      if (!previous
        || previous.observed.token !== occupied.token
        || previous.observed.pid !== occupied.pid) {
        throw new Error(`guard de recovery corrupto: ${guardPath}`);
      }
      const confirmed = readOwnerMutex(repo);
      if (!confirmed
        || confirmed.token !== occupied.token
        || confirmed.pid !== occupied.pid) return null;
      const recoveryIdentity = `${previous.recovery.pid}:${previous.recovery.token}`;
      if (visitedRecoveries.has(recoveryIdentity)) {
        throw new Error("ciclo detectado en identidades de recovery");
      }
      visitedRecoveries.add(recoveryIdentity);
      if (previous.recovery.pid !== candidate.pid && mutexIsLive(previous.recovery)) return null;
      guardPath = mutexRecoveryGuard(repo, occupied, previous.recovery);
    }
  }

  function mutexIsLive(mutex: OwnerMutex): boolean {
    return pidAlive(mutex.pid) && now() - mutex.createdAt < mutexLeaseMs;
  }

  function writeOwnerExclusive(repo: string, owner: IncidentOwner): void {
    const target = ownerFile(repo);
    const temporary = `${target}.tmp-${owner.pid}-${randomUUID()}`;
    if (!publishJsonExclusive(target, temporary, owner)) {
      const error = new Error(`owner ya existe: ${repo}`) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
  }

  function claimOwner(repo: string, session: string): ClaimOwnerResult {
    assertRepo(repo);
    if (!SAFE_SESSION.test(session)) throw new Error(`sesión inválida: ${session}`);
    if (!readIncident(repo)) throw new Error(`no hay incidente abierto: ${repo}`);
    const timestamp = now();
    const candidate: IncidentOwner = { session, pid: pid(), started: timestamp, heartbeat: timestamp };
    const mutex = acquireOwnerMutex(repo, candidate.pid);
    if (!mutex) return { acquired: false, takeover: false, owner: readOwner(repo) };
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = readOwner(repo);
        if (current?.pid === candidate.pid && current.session === session) {
          return { acquired: true, takeover: false, owner: current };
        }
        const age = current ? timestamp - current.heartbeat : Number.POSITIVE_INFINITY;
        if (current && age < leaseMs) return { acquired: false, takeover: false, owner: current };
        if (current) {
          const stale = join(incidentDir(repo), `owner.stale-${candidate.pid}-${timestamp}`);
          try {
            fs.rename(ownerFile(repo), stale);
          } catch (error) {
            if (errorCode(error) === "ENOENT" || errorCode(error) === "EEXIST") continue;
            throw error;
          }
          try {
            writeOwnerExclusive(repo, candidate);
            return { acquired: true, takeover: true, owner: clone(candidate) };
          } catch (error) {
            if (errorCode(error) === "EEXIST") continue;
            throw error;
          }
        }
        try {
          writeOwnerExclusive(repo, candidate);
          return { acquired: true, takeover: false, owner: clone(candidate) };
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      }
      return { acquired: false, takeover: false, owner: readOwner(repo) };
    } finally {
      releaseOwnerMutex(repo, mutex);
    }
  }

  async function heartbeatOwner(repo: string): Promise<boolean> {
    if (!safeRepo(repo)) return false;
    const expected = readOwner(repo);
    if (!expected || expected.pid !== pid() || !await tmux.hasSession(expected.session)) return false;
    const mutex = acquireOwnerMutex(repo, expected.pid);
    if (!mutex) return false;
    try {
      const current = readOwner(repo);
      if (!current
        || current.pid !== expected.pid
        || current.session !== expected.session
        || current.started !== expected.started) return false;
      const renewed: IncidentOwner = { ...current, heartbeat: now() };
      atomicWrite(ownerFile(repo), renewed);
      return true;
    } catch {
      return false;
    } finally {
      releaseOwnerMutex(repo, mutex);
    }
  }

  function storeIncident(incident: Incident): void {
    atomicWrite(join(incidentDir(incident.repo), "incident.json"), incident);
  }

  async function readRemoteClaim(repoDir: string, branch: string): Promise<string | null> {
    const output = (await git.run(
      ["ls-remote", "origin", `refs/heads/${branch}`],
      repoDir,
      { env: gitEnv },
    )).trim();
    if (!output) return null;
    const remoteSha = output.split(/\s+/, 1)[0] ?? "";
    if (!SAFE_SHA.test(remoteSha)) throw new Error("Git devolvió un owner remoto inválido");
    return remoteSha;
  }

  function persistOwnClaim(incident: Incident, claimSha: string, branch: string): Incident {
    const current = readIncident(incident.repo);
    if (!current || current.id !== incident.id) throw new Error(`el incidente cambió durante el claim: ${incident.repo}`);
    const stored: Incident = {
      ...current,
      claimSha,
      claimBranch: branch,
    };
    delete stored.remoteOwner;
    storeIncident(stored);
    return stored;
  }

  function persistRemoteOwner(incident: Incident, remoteOwner: string): void {
    const current = readIncident(incident.repo);
    if (!current || current.id !== incident.id) throw new Error(`el incidente cambió durante el claim: ${incident.repo}`);
    storeIncident({ ...current, remoteOwner });
  }

  function rewriteOwnedOwner(repo: string, expected: IncidentOwner, session: string): boolean {
    if (!SAFE_SESSION.test(session)) throw new Error(`sesión inválida devuelta por launch: ${session}`);
    const mutex = acquireOwnerMutex(repo, expected.pid);
    if (!mutex) return false;
    try {
      const current = readOwner(repo);
      if (!current
        || current.pid !== expected.pid
        || current.session !== expected.session
        || current.started !== expected.started) return false;
      const updated: IncidentOwner = { ...current, session, heartbeat: now() };
      atomicWrite(ownerFile(repo), updated);
      return true;
    } finally {
      releaseOwnerMutex(repo, mutex);
    }
  }

  function releaseOwnedOwner(repo: string, expected: IncidentOwner): void {
    const mutex = acquireOwnerMutex(repo, expected.pid);
    if (!mutex) return;
    try {
      const current = readOwner(repo);
      if (!current
        || current.pid !== expected.pid
        || current.session !== expected.session
        || current.started !== expected.started) return;
      try {
        fs.unlink(ownerFile(repo));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    } finally {
      releaseOwnerMutex(repo, mutex);
    }
  }

  async function claimRemote(repo: string, repoDir: string): Promise<RemoteClaimResult> {
    assertRepo(repo);
    const incident = readIncident(repo);
    if (!incident) throw new Error(`no hay incidente abierto: ${repo}`);
    const branch = `fix/main-health-${repo}`;
    if (incident.claimSha && incident.claimBranch) {
      const remoteOwner = await readRemoteClaim(repoDir, branch);
      if (remoteOwner === incident.claimSha) {
        if (incident.remoteOwner) persistOwnClaim(incident, incident.claimSha, branch);
        return { accepted: true, branch, claimSha: incident.claimSha };
      }
      if (remoteOwner) {
        persistRemoteOwner(incident, remoteOwner);
        return { accepted: false, branch, claimSha: incident.claimSha, remoteOwner };
      }
      try {
        await git.run(["push", "origin", `${incident.claimSha}:refs/heads/${branch}`], repoDir, { env: gitEnv });
        persistOwnClaim(incident, incident.claimSha, branch);
        return { accepted: true, branch, claimSha: incident.claimSha };
      } catch (error) {
        if (!isRemoteClaimConflict(error)) throw error;
        const winner = await readRemoteClaim(repoDir, branch);
        if (winner === incident.claimSha) {
          persistOwnClaim(incident, incident.claimSha, branch);
          return { accepted: true, branch, claimSha: incident.claimSha };
        }
        if (!winner) throw new Error("claim remoto rechazado sin owner resoluble");
        persistRemoteOwner(incident, winner);
        return { accepted: false, branch, claimSha: incident.claimSha, remoteOwner: winner };
      }
    }
    const timestamp = now();
    const isoDate = new Date(timestamp).toISOString();
    const tree = (await git.run(["rev-parse", `${incident.firstRedSha}^{tree}`], repoDir)).trim();
    if (!SAFE_SHA.test(tree)) throw new Error("Git devolvió un tree inválido para el claim");
    const identity = "Cowork Main Health";
    const email = "main-health@cowork.local";
    const claimEnv: NodeJS.ProcessEnv = {
      ...gitEnv,
      GIT_AUTHOR_NAME: identity,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: identity,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    };
    const message = [
      `main-health claim ${repo}`,
      "",
      `Host: ${host()}`,
      `PID: ${pid()}`,
      `Fecha: ${isoDate}`,
      "",
    ].join("\n");
    const claimSha = (await git.run(
      ["commit-tree", tree, "-p", incident.firstRedSha],
      repoDir,
      { input: message, env: claimEnv },
    )).trim();
    assertSha(claimSha);
    try {
      await git.run(["push", "origin", `${claimSha}:refs/heads/${branch}`], repoDir, { env: gitEnv });
      // El claim durable debe existir antes de que ensureFixer intente lanzar la sesión.
      persistOwnClaim(incident, claimSha, branch);
      return { accepted: true, branch, claimSha };
    } catch (error) {
      if (!isRemoteClaimConflict(error)) throw error;
      const remoteOwner = await readRemoteClaim(repoDir, branch);
      if (!remoteOwner) throw new Error("claim remoto rechazado sin owner resoluble");
      const current = readIncident(repo);
      if (current?.id === incident.id && current.claimSha === remoteOwner && current.claimBranch === branch) {
        persistOwnClaim(current, remoteOwner, branch);
        return { accepted: true, branch, claimSha: remoteOwner };
      }
      persistRemoteOwner(incident, remoteOwner);
      return { accepted: false, branch, claimSha, remoteOwner };
    }
  }

  function fixerRequest(incident: Incident, branch: string): string {
    return [
      "Atiende este incidente de main-health.",
      "",
      "Incidente:",
      JSON.stringify(incident, null, 2),
      "",
      `Rama claim: ${branch}`,
      "",
      "Atribución:",
      JSON.stringify(incident.attribution, null, 2),
    ].join("\n");
  }

  async function ensureFixerOnce(repo: string, repoDir: string): Promise<EnsureFixerResult> {
    assertRepo(repo);
    const incident = readIncident(repo);
    if (!incident) return { status: "no-incident", session: null };
    if (incident.remoteOwner) return { status: "remote-owned", session: null, remoteOwner: incident.remoteOwner };

    const currentOwner = readOwner(repo);
    if (currentOwner
      && now() - currentOwner.heartbeat < leaseMs
      && await tmux.hasSession(currentOwner.session)) {
      return { status: "active", session: currentOwner.session };
    }

    const configuredAlias = aliases[repo];
    const alias = configuredAlias && SAFE_ALIAS.test(configuredAlias) ? configuredAlias : repo;
    const candidates = [...new Set([`cowork-main-health-${repo}`, `cowork-main-health-${alias}`])];
    for (const session of candidates) {
      if (!await tmux.hasSession(session)) continue;
      const claimed = claimOwner(repo, session);
      if (claimed.acquired) return { status: "adopted", session };
      return claimed.owner
        ? { status: "active", session: claimed.owner.session }
        : { status: "busy", session: null };
    }
    if (!autoFix) return { status: "disabled", session: null };

    const logicalName = `main-health-${alias}`;
    const expectedSession = `cowork-${logicalName}`;
    const ownership = claimOwner(repo, expectedSession);
    if (!ownership.acquired) {
      return ownership.owner
        ? { status: "active", session: ownership.owner.session }
        : { status: "busy", session: null };
    }
    const branch = `fix/main-health-${repo}`;
    try {
      if (remoteClaim) {
        const claim = await claimRemote(repo, repoDir);
        if (!claim.accepted) {
          releaseOwnedOwner(repo, ownership.owner);
          return { status: "remote-owned", session: null, remoteOwner: claim.remoteOwner! };
        }
      }
      const launched = await launch.launchManagedSession({
        repo,
        workflowId: "claude-plan-codex-impl",
        name: logicalName,
        mode: "workflow",
        request: fixerRequest(readIncident(repo) ?? incident, branch),
      });
      if (!rewriteOwnedOwner(repo, ownership.owner, launched.name)) {
        throw new Error(`se perdió el owner antes de registrar la sesión ${launched.name}`);
      }
      return { status: "launched", session: launched.name };
    } catch (error) {
      releaseOwnedOwner(repo, ownership.owner);
      throw error;
    }
  }

  function ensureFixer(repo: string, repoDir: string): Promise<EnsureFixerResult> {
    const running = fixerRuns.get(repo);
    if (running) return running;
    const promise = ensureFixerOnce(repo, repoDir).finally(() => fixerRuns.delete(repo));
    fixerRuns.set(repo, promise);
    return promise;
  }

  function openIncident(input: OpenIncidentInput): Incident {
    assertRepo(input.repo);
    assertSha(input.firstRedSha);
    fs.mkdir(incidentsRoot, { recursive: true });
    try {
      fs.mkdir(incidentDir(input.repo));
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const current = readIncident(input.repo);
      if (current) return current;
      throw new Error(`incidente existente incompleto: ${input.repo}`);
    }
    const incident: Incident = {
      id: `${input.repo}@${input.firstRedSha.slice(0, 7)}`,
      repo: input.repo,
      firstRedSha: input.firstRedSha,
      openedAt: now(),
      summary: input.summary,
      attribution: clone(input.attribution),
    };
    atomicWrite(join(incidentDir(input.repo), "incident.json"), incident);
    return clone(incident);
  }

  function listIncidents(): Incident[] {
    let entries: string[];
    try {
      entries = fs.readdir(incidentsRoot, { encoding: "utf8" }) as string[];
    } catch {
      return [];
    }
    return entries
      .filter(safeRepo)
      .map(readIncident)
      .filter((incident): incident is Incident => incident !== null)
      .sort((left, right) => left.repo.localeCompare(right.repo));
  }

  async function closeIncident(repo: string, repoDir?: string): Promise<Incident | null> {
    if (!safeRepo(repo)) return null;
    const current = readIncident(repo);
    if (!current) return null;
    if (current.claimSha && current.claimBranch) {
      if (!repoDir) throw new Error(`repoDir es obligatorio para cerrar un claim propio: ${repo}`);
      const remoteOwner = await readRemoteClaim(repoDir, current.claimBranch);
      if (remoteOwner === current.claimSha) {
        const ref = `refs/heads/${current.claimBranch}`;
        try {
          await git.run([
            "push",
            `--force-with-lease=${ref}:${current.claimSha}`,
            "origin",
            `:${ref}`,
          ], repoDir, { env: gitEnv });
        } catch (error) {
          if (!isRemoteClaimConflict(error)) throw error;
          const afterConflict = await readRemoteClaim(repoDir, current.claimBranch);
          if (afterConflict === current.claimSha) throw error;
        }
      }
    }
    const closed: Incident = { ...current, closedAt: now() };
    atomicWrite(join(incidentDir(repo), "incident.json"), closed);
    const archiveParent = join(incidentsRoot, `${repo}.closed`);
    fs.mkdir(archiveParent, { recursive: true });
    const archiveId = `${repo}@${current.firstRedSha.slice(0, 7)}`;
    fs.rename(incidentDir(repo), join(archiveParent, `${archiveId}-${closed.closedAt}`));
    return clone(closed);
  }

  return {
    root,
    openIncident,
    readIncident,
    listIncidents,
    readOwner,
    claimOwner,
    heartbeatOwner,
    claimRemote,
    ensureFixer,
    closeIncident,
  };
}

export type IncidentManager = ReturnType<typeof createIncidentManager>;
