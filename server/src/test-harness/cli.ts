import { COMMAND_SUITES, isSuite, type Run, type RunSelection, type TestSuite } from "./model.js";

/**
 * CLI sin agente: mismas selecciones declaradas que la API, espera a que TODOS los hijos
 * lleguen a estado terminal y devuelve un código útil para CI:
 *   0 = todo pasó · 1 = failed/error/timeout/cancelled · 2 = blocked (config) · 64 = argumentos inválidos.
 * Nunca imprime valores de perfil: sólo ids, estados, conteos y cobertura.
 */

export interface CliStartOptions {
  /** Raíz alternativa del repo (el worktree de una sesión). El service la valida. */
  root?: string;
}

export interface CliHarness {
  start(selection: RunSelection, options: CliStartOptions): Promise<{ batchId?: string; runIds: string[] }>;
  waitForAll(runIds: string[]): Promise<void>;
  getRun(runId: string): Run | undefined;
}

export interface CliIo {
  log(line: string): void;
  error(line: string): void;
}

export const USAGE = `Uso: ronin-tests <verbo> [args] --profile <nombre>

Verbos:
  all                         todas las suites declaradas de todos los repos con el perfil
  failed                      sólo las suites cuya última corrida falló (perfil dado)
  repo <repo>                 todas las suites declaradas de un repo
  suite <repo> <suite>        una suite (${COMMAND_SUITES.join(" | ")})

Opciones:
  --profile <nombre>          perfil de entorno (obligatorio salvo --help)
  --root <ruta>               raíz alternativa del repo (p. ej. el worktree de una sesión);
                              debe caer dentro de una raíz confiable
  --json                      imprime el resumen como JSON
  -h, --help                  esta ayuda

Códigos de salida: 0 ok · 1 fallos · 2 bloqueado/config · 64 argumentos inválidos`;

interface ParsedArgs {
  verb?: string;
  positional: string[];
  profile?: string;
  root?: string;
  json: boolean;
  help: boolean;
}

/** Una bandera con valor nunca se traga la siguiente opción: sin valor real, error de argumentos. */
function valorDe(flag: string, raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || value.startsWith("-")) throw new Error(`${flag} requiere una ruta`);
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a.startsWith("--profile=")) out.profile = a.slice("--profile=".length);
    else if (a === "--root") out.root = valorDe("--root", argv[++i]);
    else if (a.startsWith("--root=")) out.root = valorDe("--root", a.slice("--root=".length));
    else if (a.startsWith("-")) throw new Error(`opción desconocida: ${a}`);
    else if (out.verb === undefined) out.verb = a;
    else out.positional.push(a);
  }
  return out;
}

export function buildSelection(args: ParsedArgs): RunSelection {
  const profile = args.profile?.trim();
  if (!profile) throw new Error("--profile es obligatorio");
  switch (args.verb) {
    case "all":
      return { kind: "all", profile };
    case "failed":
      return { kind: "failed", profile };
    case "repo": {
      const [repo] = args.positional;
      if (!repo) throw new Error("repo <repo> requiere el nombre del repo");
      return { kind: "suites", repo, profile, suites: [...COMMAND_SUITES] };
    }
    case "suite": {
      const [repo, suite] = args.positional;
      if (!repo || !suite) throw new Error("suite <repo> <suite> requiere ambos argumentos");
      if (!isSuite(suite) || !(COMMAND_SUITES as readonly string[]).includes(suite)) throw new Error(`suite inválida: ${suite} (${COMMAND_SUITES.join(" | ")})`);
      return { kind: "suites", repo, profile, suites: [suite as TestSuite] };
    }
    default:
      throw new Error(args.verb ? `verbo desconocido: ${args.verb}` : "falta el verbo");
  }
}

function fmtCoverage(run: Run): string {
  if (!run.coverage || run.coverage.status === "not_applicable") return "";
  if (run.coverage.status === "reported") return `cov ${run.coverage.lines}%`;
  return `cov ${run.coverage.status === "invalid" ? "inválida" : "no reportada"}`;
}

function fmtTotals(run: Run): string {
  if (!run.totals) return run.totalsReason ? `(${run.totalsReason})` : "";
  const t = run.totals;
  return `${t.passed}/${t.total} ok${t.failed ? ` ${t.failed} fail` : ""}${t.errors ? ` ${t.errors} err` : ""}${t.skipped ? ` ${t.skipped} skip` : ""}`;
}

export function exitCodeFor(runs: Run[]): number {
  if (runs.some((r) => ["failed", "error", "timeout", "cancelled"].includes(r.status))) return 1;
  if (runs.some((r) => r.status === "blocked")) return 2;
  return 0;
}

export async function runCli(argv: string[], harness: CliHarness, io: CliIo): Promise<number> {
  let args: ParsedArgs;
  let selection: RunSelection;
  try {
    args = parseArgs(argv);
    if (args.help) {
      io.log(USAGE);
      return 0;
    }
    selection = buildSelection(args);
  } catch (e) {
    io.error(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 64;
  }

  let started: { batchId?: string; runIds: string[] };
  try {
    started = await harness.start(selection, args.root === undefined ? {} : { root: args.root });
  } catch (e) {
    io.error(`error: ${(e as Error).message}`);
    return 2;
  }
  if (started.batchId) io.log(`lote ${started.batchId}: ${started.runIds.length} corrida(s)`);
  if (started.runIds.length === 0) {
    io.log("nada que ejecutar");
    return 0;
  }
  await harness.waitForAll(started.runIds);
  const runs = started.runIds.map((id) => harness.getRun(id)).filter((r): r is Run => r !== undefined);

  if (args.json) {
    io.log(JSON.stringify({ batchId: started.batchId, runs: runs.map(({ stdout: _o, stderr: _e, ...rest }) => rest) }, null, 2));
  } else {
    for (const r of runs) {
      const extra = [fmtTotals(r), fmtCoverage(r), r.reason ?? ""].filter(Boolean).join(" · ");
      io.log(`${r.repo.padEnd(28)} ${r.suite.padEnd(8)} ${r.status.padEnd(10)} ${r.runId}${extra ? `  ${extra}` : ""}`);
    }
  }
  return exitCodeFor(runs);
}
