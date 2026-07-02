import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "curl-env.json");

export interface ProjectCurl {
  devUrl: string;
  token: string;
  accountingFirm: string;
}

function load(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function getCurlEnv(project: string): ProjectCurl | null {
  const cfg = load()[project];
  if (cfg && typeof cfg === "object") {
    return { devUrl: cfg.devUrl ?? "", token: cfg.token ?? "", accountingFirm: cfg.accountingFirm ?? "" };
  }
  return null;
}

export function getBackupTester(): { url: string; ingestToken: string } {
  const bt = load()._backupTester ?? {};
  return { url: bt.url ?? "http://localhost:8011", ingestToken: bt.ingestToken ?? "" };
}

/**
 * Write a `curl.env` the worker can `source` for its curl tests, so the
 * per-project token / accounting_firm / dev URL never need to be re-entered.
 * `extra` merges per-repo vars on top (repo vars override the base creds, e.g. a
 * repo can point DEV_URL at its own test env). Returns the path, or null when
 * there is nothing to write (no creds AND no vars — identical to before).
 */
export function writeCurlEnv(project: string, dir: string, extra: Record<string, string> = {}): string | null {
  const c = getCurlEnv(project);
  const hasExtra = Object.keys(extra).length > 0;
  const path = join(dir, "curl.env");
  if (!c || (!c.devUrl && !c.token)) {
    if (!hasExtra) return null; // nothing to write (today's behavior)
    return write(path, extra);
  }
  const bt = getBackupTester();
  const base: Record<string, string> = {
    DEV_URL: c.devUrl,
    TOKEN: c.token,
    ACCOUNTING_FIRM: c.accountingFirm,
    BACKUP_TESTER_URL: bt.url,
    BACKUP_TESTER_INGEST_TOKEN: bt.ingestToken,
  };
  return write(path, { ...base, ...extra }); // repo vars win (later keys override)
}

function write(path: string, kv: Record<string, string>): string | null {
  try {
    // Single-quote every value (with the standard '\'' escape) so `source curl.env`
    // sets each var to the exact literal — no shell interpretation of &, ?, spaces,
    // $, backticks or $( ) in a dev URL/token. Applies to base creds + repo vars alike.
    const lines = Object.entries(kv).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`);
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  } catch {
    return null;
  }
}
