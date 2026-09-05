import { HarnessError, type TestHarnessService } from "./test-harness/service.js";
import { isSuite, type Coverage, type Run, type TestSuite } from "./test-harness/model.js";

export const MCP_SERVER_VERSION = "0.1.0";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number | null;

export interface McpDependencies {
  harness: TestHarnessService;
  version?: string;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): McpResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResult(text: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: true } {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true as const } : {}) };
}

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "Repositorio configurado en Ronin." },
    suite: { type: "string", enum: ["unit", "e2e", "api", "browser"] },
    junitPath: { type: "string", description: "Ruta absoluta al junit.xml generado por la suite." },
    coberturaPath: { type: "string", description: "Ruta absoluta opcional a cobertura Cobertura XML." },
    profile: { type: "string", description: "Perfil con el que el agente ejecutó la suite." },
  },
  required: ["repo", "suite", "junitPath"],
  additionalProperties: false,
} as const;

const STATUS_SCHEMA = {
  type: "object",
  properties: { repo: { type: "string", description: "Limita el resumen a un repositorio." } },
  additionalProperties: false,
} as const;

export const MCP_TOOLS = [
  {
    name: "reportar_pruebas",
    description: "Registra una suite ya ejecutada leyendo sus artefactos JUnit y Cobertura. No acepta conteos declarados por el agente.",
    inputSchema: REPORT_SCHEMA,
  },
  {
    name: "estado_pruebas",
    description: "Resume la última corrida de cada suite, incluida su procedencia.",
    inputSchema: STATUS_SCHEMA,
  },
] as const;

function requiredString(args: JsonRecord, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new HarnessError(`${key} debe ser una cadena no vacía`, "TOOL_INPUT_INVALID", 400);
  return value;
}

function coverageText(coverage: Coverage | undefined): string {
  return coverage?.status === "reported" && coverage.lines !== undefined ? `${coverage.lines}%` : "no reportada";
}

function sourceOf(run: Run): "harness" | "agent" {
  return run.source ?? "harness";
}

/** Un resumen intencionalmente pequeño: sin stdout/stderr ni detalles de cada fallo. */
function statusText(harness: TestHarnessService, repoFilter?: string): string {
  const repos = harness.readPublicConfig().map((repo) => repo.repo);
  if (repoFilter !== undefined && !repos.includes(repoFilter)) {
    throw new HarnessError(`repo desconocido: ${repoFilter}`, "REPO_NOT_FOUND", 404);
  }
  const wanted = repoFilter === undefined ? repos : [repoFilter];
  const latest = new Map<string, Run>();
  for (const run of harness.listRuns({ limit: 100_000 })) {
    if (!wanted.includes(run.repo)) continue;
    const key = `${run.repo}\u0000${run.suite}`;
    const previous = latest.get(key);
    if (!previous || previous.createdAt < run.createdAt) latest.set(key, run);
  }
  const lines: string[] = [];
  for (const repo of wanted) {
    const runs = [...latest.values()].filter((run) => run.repo === repo).sort((a, b) => a.suite.localeCompare(b.suite));
    if (runs.length === 0) {
      lines.push(`${repo}: sin corridas registradas`);
      continue;
    }
    for (const run of runs) {
      const totals = run.totals
        ? `${run.totals.total} total, ${run.totals.passed} pasaron, ${run.totals.failed + run.totals.errors} fallaron, ${run.totals.skipped} omitidas`
        : "sin totales";
      const failures = Math.max(run.failures?.length ?? 0, (run.totals?.failed ?? 0) + (run.totals?.errors ?? 0));
      lines.push(`${repo}/${run.suite}: ${run.status}; ${run.finishedAt ?? run.createdAt}; ${totals}; cobertura ${coverageText(run.coverage)}; fallos: ${failures}; procedencia: ${sourceOf(run)}`);
    }
  }
  // 200 filas sigue muy por debajo de 25k tokens; este corte conserva esa cota
  // incluso si el journal contiene una cantidad anómala de repositorios configurados.
  const visible = lines.slice(0, 200);
  if (lines.length > visible.length) visible.push(`… ${lines.length - visible.length} corridas omitidas para mantener el resumen compacto`);
  return visible.join("\n") || "sin corridas registradas";
}

function report(args: JsonRecord, harness: TestHarnessService): string {
  const repo = requiredString(args, "repo");
  const suite = args.suite;
  if (!isSuite(suite)) throw new HarnessError("suite debe ser unit, e2e, api o browser", "TOOL_INPUT_INVALID", 400);
  const junitPath = requiredString(args, "junitPath");
  const coberturaPath = args.coberturaPath === undefined ? undefined : requiredString(args, "coberturaPath");
  const profile = args.profile === undefined ? undefined : requiredString(args, "profile");
  const run = harness.recordAgentRun({ repo, suite: suite as TestSuite, junitPath, ...(coberturaPath ? { coberturaPath } : {}), ...(profile ? { profile } : {}) });
  const totals = run.totals!;
  return `registrado ${run.runId}: ${totals.passed} pasaron, ${totals.failed + totals.errors} fallaron, cobertura ${coverageText(run.coverage)}`;
}

/** Adaptador JSON-RPC puro: no toca HTTP, sólo usa las dependencias inyectadas. */
export async function handleMcp(message: unknown, deps: McpDependencies): Promise<McpResponse | null> {
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(null, -32600, "Solicitud JSON-RPC inválida");
  }
  // Por JSON-RPC toda petición sin id es notificación; MCP reserva este espacio para notifications/*.
  if (!("id" in message)) return null;
  if (typeof message.id !== "string" && typeof message.id !== "number" && message.id !== null) {
    return jsonRpcError(null, -32600, "Solicitud JSON-RPC inválida: id debe ser string, número o null");
  }
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};

  if (message.method === "initialize") {
    const protocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return {
      jsonrpc: "2.0",
      id,
      result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ronin", version: deps.version ?? MCP_SERVER_VERSION } },
    };
  }
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  if (message.method !== "tools/call") return jsonRpcError(id, -32601, `Método no encontrado: ${message.method}`);

  try {
    const name = requiredString(params, "name");
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (name === "reportar_pruebas") return { jsonrpc: "2.0", id, result: toolResult(report(args, deps.harness)) };
    if (name === "estado_pruebas") {
      const repo = params.arguments !== undefined ? (args.repo === undefined ? undefined : requiredString(args, "repo")) : undefined;
      return { jsonrpc: "2.0", id, result: toolResult(statusText(deps.harness, repo)) };
    }
    return { jsonrpc: "2.0", id, result: toolResult(`Herramienta desconocida: ${name}. Usa tools/list para ver las disponibles.`, true) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo registrar la corrida";
    return { jsonrpc: "2.0", id, result: toolResult(message, true) };
  }
}
