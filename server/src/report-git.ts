import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCwd } from "./repos.js";

const pexec = promisify(execFile);

export interface Commit { hash: string; subject: string; author: string; ts: number; }

const SEP = "\x1f", REC = "\x1e"; // separadores seguros (subjects con | o saltos de línea)
const FMT = `%h${SEP}%s${SEP}%an${SEP}%ct${REC}`;

/**
 * Commits por repo en [from,to). Read-only (`git log`), best-effort: nunca lanza.
 * Dedup por carpeta resuelta (varios repos → mismo monorepo). Omite dir inexistente / no-git.
 * Devuelve mapa label→commits, donde label = los repo keys que comparten esa carpeta.
 */
export async function commitsFor(
  repos: string[], from: Date, to: Date
): Promise<Record<string, Commit[]>> {
  // agrupar keys por cwd real
  const byDir = new Map<string, string[]>();
  for (const repo of new Set(repos)) {
    if (!repo) continue;
    const { cwd, real } = resolveCwd(repo);
    if (!real || !existsSync(join(cwd, ".git"))) continue; // no existe / no es repo git → omite
    if (!byDir.has(cwd)) byDir.set(cwd, []);
    byDir.get(cwd)!.push(repo);
  }
  const out: Record<string, Commit[]> = {};
  for (const [cwd, keys] of byDir) {
    const args = [
      "-C", cwd, "-c", "gc.auto=0", "log", "--no-merges", "--max-count=500",
      "--since", from.toISOString(), "--until", to.toISOString(),
      `--pretty=format:${FMT}`,
    ];
    try {
      const { stdout } = await pexec("git", args, { timeout: 15000, maxBuffer: 4 << 20 });
      const commits = stdout.split(REC).map((s) => s.trim()).filter(Boolean).map((rec) => {
        const [hash, subject, author, ct] = rec.split(SEP);
        return { hash, subject, author, ts: (Number(ct) || 0) * 1000 };
      });
      if (commits.length) out[keys.sort().join(", ")] = commits;
    } catch {
      /* best-effort: omite este repo */
    }
  }
  return out;
}
