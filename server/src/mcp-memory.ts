import { MemoryError, type MemoryAction, type MemoryKind, type MemoryStore } from "./memory.js";
import { McpToolError } from "./mcp-sessions.js";

/**
 * Herramientas MCP de la memoria por repo (spec §9). Sólo existen en el scope completo: `mcp.ts`
 * nunca las lista ni las acepta con `scope=agent`, e `index.ts` no le pasa este puerto a ese scope.
 */

export interface McpMemoryPending {
  id: string;
  repo: string;
  text: string;
  kind: MemoryKind;
  source: string;
}

export type McpMemoryAccion = "aprobar" | "descartar" | "editar";

export interface McpMemoryResolution {
  id: string;
  repo: string;
  resultado: "activa" | "descartada" | "sugerencia_kb";
}

export interface McpMemoryPort {
  pending(repo?: string): Promise<McpMemoryPending[]>;
  resolve(id: string, accion: McpMemoryAccion, texto?: string): Promise<McpMemoryResolution>;
}

export const MEMORY_TOOLS = [
  {
    name: "memoria_pendiente",
    description: "Lista los aprendizajes que Ronin destiló y esperan aprobación: id, repo, texto, tipo y sesión de origen.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Limita la lista a un repositorio configurado." } },
      additionalProperties: false,
    },
  },
  {
    name: "resolver_memoria",
    description: "Aprueba, descarta o edita (y aprueba) un aprendizaje pendiente. Los de arquitectura pasan a sugerencias para la knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        accion: { type: "string", enum: ["aprobar", "descartar", "editar"] },
        texto: { type: "string", description: "Texto nuevo de 1 a 200 caracteres; obligatorio con editar." },
      },
      required: ["id", "accion"],
      additionalProperties: false,
    },
  },
] as const;

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOLS.some((tool) => tool.name === name);
}

const ACTIONS: Record<McpMemoryAccion, MemoryAction> = { aprobar: "approve", descartar: "discard", editar: "edit" };

function invalid(message: string): McpToolError {
  return new McpToolError("MEMORY_INVALID", message);
}

export async function callMemoryTool(name: string, args: Record<string, unknown>, port: McpMemoryPort): Promise<string> {
  if (name === "memoria_pendiente") {
    const { repo } = args;
    if (repo !== undefined && (typeof repo !== "string" || !repo.trim())) throw invalid("repo debe ser una cadena no vacía");
    return JSON.stringify(await port.pending(repo));
  }
  if (name === "resolver_memoria") {
    const { id, accion, texto } = args;
    if (typeof id !== "string" || !id.trim()) throw invalid("id debe ser una cadena no vacía");
    if (accion !== "aprobar" && accion !== "descartar" && accion !== "editar") throw invalid("accion debe ser aprobar, descartar o editar");
    if (texto !== undefined && typeof texto !== "string") throw invalid("texto debe ser una cadena");
    if (accion === "editar" && texto === undefined) throw invalid("texto es obligatorio para editar");
    return JSON.stringify(await port.resolve(id, accion, texto));
  }
  throw new McpToolError("TOOL_UNKNOWN", `herramienta desconocida: ${name}`);
}

/** Un error del store viaja como MEMORY_NOT_FOUND o, cualquier otro, como MEMORY_INVALID. */
function toToolError(error: unknown): unknown {
  if (error instanceof MemoryError) return new McpToolError(error.code === "MEMORY_NOT_FOUND" ? "MEMORY_NOT_FOUND" : "MEMORY_INVALID", error.message);
  return error;
}

export function createMemoryPort(store: MemoryStore): McpMemoryPort {
  return {
    async pending(repo) {
      try {
        return store.pending(repo);
      } catch (error) {
        throw toToolError(error);
      }
    },
    async resolve(id, accion, texto) {
      try {
        const repo = store.locate(id);
        if (!repo) throw new McpToolError("MEMORY_NOT_FOUND", `no existe el aprendizaje ${id}`);
        const memory = store.resolve(repo, id, ACTIONS[accion], texto);
        const entry = memory.entries.find((item) => item.id === id);
        // Aprobada de arquitectura: salió de entries y vive como sugerencia para la KB.
        const resultado = !entry ? "sugerencia_kb" : entry.status === "discarded" ? "descartada" : "activa";
        return { id, repo, resultado };
      } catch (error) {
        throw toToolError(error);
      }
    },
  };
}
