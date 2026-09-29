export interface McpCatalog { repos: string[]; workflows: Array<{ id: string; name: string; stages: string[] }> }
export interface McpLaunchInput { repo: string; workflowId: string; request: string; name?: string; origin?: string }
export interface McpLaunchResult { name: string; branch?: string; worktree?: string }
export interface McpSessionStatus {
  name: string;
  workflow: string | null;
  stage: string | null;
  stagesDone: number;
  stagesTotal: number;
  attention: "decision" | "working" | "idle" | "shell" | "gone" | null;
  needsInput: boolean;
  question?: string;
  /** Etiquetas del menú numerado, sólo cuando la decisión es un menú; se responde con su número (1..n). */
  options?: string[];
  gate: { stage: string; attempts?: number } | null;
}
export interface McpSessionPort {
  catalog(): Promise<McpCatalog>;
  launch(input: McpLaunchInput): Promise<McpLaunchResult>;
  status(names?: string[]): Promise<McpSessionStatus[]>;
  reply(name: string, text: string): Promise<void>;
}

/** Error esperado de una herramienta: viaja al cliente como `CODE: mensaje`, nunca como excepción. */
export class McpToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MAX_REQUEST_BYTES = 8 * 1024;

export const SESSION_TOOLS = [
  {
    name: "listar_repos_y_workflows",
    description: "Lista los repositorios configurados en Ronin y los workflows del catálogo (id, nombre y etapas).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "crear_sesion",
    description: "Crea una sesión gestionada con un workflow del catálogo en un repositorio configurado y le entrega la petición al agente.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        workflowId: { type: "string" },
        request: { type: "string", description: "Petición para el agente (máx. 8 KB)." },
        name: { type: "string", description: "Nombre de sesión; debe iniciar con cowork-. Si falta, se deriva de la petición." },
        origen: { type: "string", description: "Referencia externa, p. ej. clickup:<taskId>." },
      },
      required: ["repo", "workflowId", "request"],
      additionalProperties: false,
    },
  },
  {
    name: "estado_sesiones",
    description: "Estado de las sesiones gestionadas: etapa, avance, atención y pregunta pendiente.",
    inputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  },
  {
    name: "responder_sesion",
    description: "Envía texto al agente de una sesión gestionada que está esperando al usuario. Si espera en un menú numerado (ver options en estado_sesiones), responde sólo con el número de la opción.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, text: { type: "string" } },
      required: ["name", "text"],
      additionalProperties: false,
    },
  },
] as const;

export function isSessionTool(name: string): boolean {
  return SESSION_TOOLS.some((tool) => tool.name === name);
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new McpToolError("TOOL_INPUT_INVALID", `${key} debe ser una cadena no vacía`);
  return value;
}

function optionalStr(args: Record<string, unknown>, key: string): string | undefined {
  return args[key] === undefined ? undefined : str(args, key);
}

export async function callSessionTool(name: string, args: Record<string, unknown>, port: McpSessionPort): Promise<string> {
  if (name === "listar_repos_y_workflows") return JSON.stringify(await port.catalog());
  if (name === "crear_sesion") {
    // Misma normalización que POST /api/sessions: sin NUL y recortada ANTES de medir y de lanzar.
    const request = str(args, "request").replace(/\0/g, "").trim();
    if (!request) throw new McpToolError("TOOL_INPUT_INVALID", "request debe ser una cadena no vacía");
    if (Buffer.byteLength(request, "utf8") > MAX_REQUEST_BYTES) throw new McpToolError("REQUEST_TOO_LONG", "la petición no puede superar 8 KB");
    const input: McpLaunchInput = { repo: str(args, "repo"), workflowId: str(args, "workflowId"), request };
    const sessionName = optionalStr(args, "name");
    const origin = optionalStr(args, "origen");
    if (sessionName !== undefined) input.name = sessionName;
    if (origin !== undefined) input.origin = origin;
    return JSON.stringify(await port.launch(input));
  }
  if (name === "estado_sesiones") {
    const raw = args.names;
    if (raw !== undefined && (!Array.isArray(raw) || !raw.every((item) => typeof item === "string"))) {
      throw new McpToolError("TOOL_INPUT_INVALID", "names debe ser una lista de cadenas");
    }
    return JSON.stringify(await port.status(raw as string[] | undefined));
  }
  if (name === "responder_sesion") {
    await port.reply(str(args, "name"), str(args, "text"));
    return JSON.stringify({ ok: true });
  }
  throw new McpToolError("TOOL_UNKNOWN", `herramienta desconocida: ${name}`);
}
