import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic.js";

export interface MainHealthMeasurement {
  sha: string;
  repo: string;
  status: "green" | "red";
  tests: number;
  total: number | null;
  floor: number | null;
  failed: string[];
  errors: string[];
  skipped: number;
  skipped_by_reason: Record<string, number>;
  uncovered_by_file: Record<string, number[]>;
  duration: number;
  at: number;
  gate_rc: number;
}

export interface MainHealthError {
  sha: string;
  reason: string;
  at: number;
  log_tail: string;
}

export interface MainHealthStoreDeps {
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
  home?: () => string;
  now?: () => number;
  atomicWrite?: (target: string, value: unknown) => void;
}

const SAFE_REPO = /^[A-Za-z0-9._-]+$/;
const SAFE_SHA = /^[A-Fa-f0-9]{7,64}$/;
const MEASUREMENT_KEYS = [
  "sha", "repo", "status", "tests", "total", "floor", "failed", "errors", "skipped",
  "skipped_by_reason", "uncovered_by_file", "duration", "at", "gate_rc",
] as const;
const ERROR_KEYS = ["sha", "reason", "at", "log_tail"] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function defaultRoot(deps: MainHealthStoreDeps): string {
  const env = deps.env ?? process.env;
  return deps.root ?? env.MAIN_HEALTH_DIR ?? join((deps.home ?? homedir)(), ".cowork", "main-health");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCountRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isCount);
}

function isUncoveredRecord(value: unknown): value is Record<string, number[]> {
  return isRecord(value) && Object.values(value).every(
    (lines) => Array.isArray(lines) && lines.every((line) => Number.isInteger(line) && line > 0),
  );
}

export function isMainHealthMeasurement(value: unknown): value is MainHealthMeasurement {
  if (!isRecord(value) || !hasExactKeys(value, MEASUREMENT_KEYS)) return false;
  return typeof value.sha === "string"
    && typeof value.repo === "string"
    && (value.status === "green" || value.status === "red")
    && isCount(value.tests)
    && (value.total === null || isFiniteNumber(value.total))
    && (value.floor === null || isFiniteNumber(value.floor))
    && isStringList(value.failed)
    && isStringList(value.errors)
    && isCount(value.skipped)
    && isCountRecord(value.skipped_by_reason)
    && isUncoveredRecord(value.uncovered_by_file)
    && isCount(value.duration)
    && isCount(value.at)
    && Number.isInteger(value.gate_rc);
}

export function isMainHealthError(value: unknown): value is MainHealthError {
  return isRecord(value)
    && hasExactKeys(value, ERROR_KEYS)
    && typeof value.sha === "string"
    && typeof value.reason === "string"
    && isCount(value.at)
    && typeof value.log_tail === "string";
}

function safeRepo(repo: string): boolean {
  return repo !== "." && repo !== ".." && SAFE_REPO.test(repo);
}

function assertRepo(repo: string): void {
  if (!safeRepo(repo)) throw new Error(`repo inválido: ${repo}`);
}

function assertSha(sha: string): void {
  if (!SAFE_SHA.test(sha)) throw new Error(`SHA inválido: ${sha}`);
}

export function createMainHealthStore(deps: MainHealthStoreDeps = {}) {
  const root = defaultRoot(deps);
  const atomicWrite = deps.atomicWrite ?? writeJsonAtomic;
  const now = deps.now ?? Date.now;

  function readJson<T>(target: string, validate: (value: unknown) => value is T): T | null {
    try {
      const value: unknown = JSON.parse(readFileSync(target, "utf8"));
      return validate(value) ? clone(value) : null;
    } catch {
      return null;
    }
  }

  function readMeasurement(repo: string, sha: string): MainHealthMeasurement | null {
    if (!safeRepo(repo) || !SAFE_SHA.test(sha)) return null;
    const value = readJson(join(root, repo, `${sha}.json`), isMainHealthMeasurement);
    return value?.repo === repo && value.sha === sha ? value : null;
  }

  function readError(repo: string, sha: string): MainHealthError | null {
    if (!safeRepo(repo) || !SAFE_SHA.test(sha)) return null;
    const value = readJson(join(root, repo, `${sha}.error.json`), isMainHealthError);
    return value?.sha === sha ? value : null;
  }

  function listMeasurements(repo: string): MainHealthMeasurement[] {
    if (!safeRepo(repo)) return [];
    let names: string[];
    try {
      names = readdirSync(join(root, repo));
    } catch {
      return [];
    }
    const measurements: MainHealthMeasurement[] = [];
    for (const name of names) {
      const match = /^([A-Fa-f0-9]{7,64})\.json$/.exec(name);
      if (!match) continue;
      const value = readMeasurement(repo, match[1]);
      if (value) measurements.push(value);
    }
    return measurements.sort((left, right) => right.at - left.at || right.sha.localeCompare(left.sha));
  }

  function latestMeasurement(repo: string): MainHealthMeasurement | null {
    return listMeasurements(repo)[0] ?? null;
  }

  function hasRecentError(repo: string, sha: string): boolean {
    const error = readError(repo, sha);
    if (!error) return false;
    const age = now() - error.at;
    return age >= 0 && age < 60 * 60 * 1_000;
  }

  function writeMeasurement(value: MainHealthMeasurement): void {
    assertRepo(value.repo);
    assertSha(value.sha);
    if (!isMainHealthMeasurement(value)) throw new Error("medición main-health inválida");
    const directory = join(root, value.repo);
    mkdirSync(directory, { recursive: true });
    atomicWrite(join(directory, `${value.sha}.json`), clone(value));
  }

  function writeError(value: MainHealthError, repo: string): void {
    assertRepo(repo);
    assertSha(value.sha);
    if (!isMainHealthError(value)) throw new Error("error main-health inválido");
    const directory = join(root, repo);
    mkdirSync(directory, { recursive: true });
    atomicWrite(join(directory, `${value.sha}.error.json`), clone(value));
  }

  return { root, readMeasurement, readError, hasRecentError, listMeasurements, latestMeasurement, writeMeasurement, writeError };
}

export type MainHealthStore = ReturnType<typeof createMainHealthStore>;
