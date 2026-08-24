import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic.js";
import { dataPath } from "../data-dir.js";
import { listRepos } from "../repos.js";
import {
  clone,
  parseId,
  parseRepoHarnessConfig,
  type Batch,
  type RepoHarnessConfig,
  type Run,
  type SuiteConfig,
  type TestSuite,
} from "./model.js";

/**
 * Persistencia local del harness: `test-harness.json` (config + perfiles con SECRETOS, gitignored),
 * `test-runs.json` (journal de corridas y lotes) y `test-artifacts/<runId>/` (copias de JUnit/cobertura).
 * La configuración NO ejecuta nada: aquí sólo se lee, valida y escribe de forma atómica.
 */

export interface PublicProfile {
  name: string;
  /** Sólo los NOMBRES de variable; los valores nunca salen del server. */
  variables: string[];
  apiBaseUrl?: string;
  allowedOrigins: string[];
  allowMutations: boolean;
}

export interface PublicRepoHarness {
  repo: string;
  configured: boolean;
  profiles: PublicProfile[];
  suites: Partial<Record<TestSuite, SuiteConfig>>;
}

export interface RepoHarness {
  repo: string;
  configured: boolean;
  config: RepoHarnessConfig;
}

export interface HarnessStoreOptions {
  directory?: string;
  repos?: () => string[];
}

interface Journal {
  runs: Run[];
  batches: Batch[];
}

const EMPTY_CONFIG = (): RepoHarnessConfig => ({ profiles: [], suites: {} });

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Misma normalización de clave que repos.ts/workflow.ts (`slug`). */
export function repoKey(raw: string): string {
  return String(raw).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function createHarnessStore(options: HarnessStoreOptions = {}) {
  const directory = options.directory ?? dataPath("");
  const repos = options.repos ?? listRepos;
  const configFile = join(directory, "test-harness.json");
  const journalFile = join(directory, "test-runs.json");
  const artifactsRoot = join(directory, "test-artifacts");

  // El archivo local se valida entrada por entrada: una entrada corrupta se descarta, no tumba el resto.
  function loadConfig(): Record<string, RepoHarnessConfig> {
    const raw = readJson<Record<string, unknown>>(configFile, {});
    const out: Record<string, RepoHarnessConfig> = {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
      try {
        out[repoKey(key)] = parseRepoHarnessConfig(value, `test-harness.json[${key}]`);
      } catch {
        // Entrada inválida a mano: se ignora hasta que la UI la vuelva a guardar validada.
      }
    }
    return out;
  }

  function loadJournal(): Journal {
    const raw = readJson<Partial<Journal>>(journalFile, {});
    return {
      runs: Array.isArray(raw?.runs) ? raw.runs : [],
      batches: Array.isArray(raw?.batches) ? raw.batches : [],
    };
  }

  let config = loadConfig();
  let journal = loadJournal();

  function persistConfig(): void {
    mkdirSync(directory, { recursive: true });
    writeJsonAtomic(configFile, config);
  }

  function persistJournal(): void {
    mkdirSync(directory, { recursive: true });
    writeJsonAtomic(journalFile, journal);
  }

  function readRepo(repo: string): RepoHarness {
    const key = repoKey(repo);
    const cfg = config[key];
    return { repo: key, configured: cfg !== undefined, config: cfg ? clone(cfg) : EMPTY_CONFIG() };
  }

  function saveRepo(repo: string, input: unknown): RepoHarness {
    const key = parseId(repoKey(repo), "repo");
    const parsed = parseRepoHarnessConfig(input);
    const previous = config[key];
    config[key] = parsed;
    try {
      persistConfig();
    } catch (error) {
      if (previous) config[key] = previous;
      else delete config[key];
      throw error;
    }
    return readRepo(key);
  }

  function publicRepo(repo: string): PublicRepoHarness {
    const { repo: key, configured, config: cfg } = readRepo(repo);
    return {
      repo: key,
      configured,
      profiles: cfg.profiles.map((p) => ({
        name: p.name,
        variables: Object.keys(p.variables).sort(),
        ...(p.apiBaseUrl ? { apiBaseUrl: p.apiBaseUrl } : {}),
        allowedOrigins: [...p.allowedOrigins],
        allowMutations: p.allowMutations,
      })),
      suites: cfg.suites,
    };
  }

  /** Todos los repos de repos.json (filas virtuales) más los configurados que ya no estén ahí. */
  function listHarnessRepos(): string[] {
    const keys = new Set<string>();
    for (const r of repos()) keys.add(repoKey(r));
    for (const k of Object.keys(config)) keys.add(k);
    return [...keys].filter(Boolean).sort();
  }

  function readPublicConfig(): PublicRepoHarness[] {
    return listHarnessRepos().map(publicRepo);
  }

  function listRuns(): Run[] {
    return clone(journal.runs);
  }

  function getRun(runId: string): Run | undefined {
    const run = journal.runs.find((r) => r.runId === runId);
    return run ? clone(run) : undefined;
  }

  function upsertRun(run: Run): void {
    const copy = clone(run);
    const i = journal.runs.findIndex((r) => r.runId === run.runId);
    if (i >= 0) journal.runs[i] = copy;
    else journal.runs.push(copy);
    persistJournal();
  }

  function getBatch(batchId: string): Batch | undefined {
    const batch = journal.batches.find((b) => b.batchId === batchId);
    return batch ? clone(batch) : undefined;
  }

  function listBatches(): Batch[] {
    return clone(journal.batches);
  }

  function upsertBatch(batch: Batch): void {
    const copy = clone(batch);
    const i = journal.batches.findIndex((b) => b.batchId === batch.batchId);
    if (i >= 0) journal.batches[i] = copy;
    else journal.batches.push(copy);
    persistJournal();
  }

  function artifactsDir(runId: string): string {
    const dir = join(artifactsRoot, parseId(runId, "runId"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Re-lee disco (tests / edición manual). */
  function reload(): void {
    config = loadConfig();
    journal = loadJournal();
  }

  return {
    directory,
    readRepo,
    saveRepo,
    publicRepo,
    readPublicConfig,
    listHarnessRepos,
    listRuns,
    getRun,
    upsertRun,
    getBatch,
    listBatches,
    upsertBatch,
    artifactsDir,
    reload,
    hasArtifactsDir: (runId: string) => existsSync(join(artifactsRoot, runId)),
  };
}

export type HarnessStore = ReturnType<typeof createHarnessStore>;
