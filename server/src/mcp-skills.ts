import { LearnedSkillError, type LearnedSkillStore, type SkillProposalKind, type SkillWarning } from "./learned-skills.js";
import { McpToolError } from "./mcp-sessions.js";

/**
 * Herramientas MCP de las skills aprendidas (spec §9). Sólo existen en el scope completo: `mcp.ts`
 * nunca las lista ni las acepta con `scope=agent`, e `index.ts` no le pasa este puerto a ese scope.
 * Quien aprueba desde MCP también recibe el texto completo y debe devolver su hash.
 */

export interface McpSkillPending {
  id: string;
  kind: SkillProposalKind;
  name: string;
  repo: string;
  source: string;
  description: string;
  content: string;
  contentHash: string;
  diff: string | null;
  changes: string;
  warnings: SkillWarning[];
}

export type McpSkillAccion = "aprobar" | "descartar" | "editar";

export interface McpSkillResolution {
  id: string;
  name: string;
  resultado: "aprobada" | "descartada";
  version?: number;
}

export interface McpSkillPort {
  pending(repo?: string): Promise<McpSkillPending[]>;
  resolve(id: string, accion: McpSkillAccion, options: { hash?: string; contenido?: string }): Promise<McpSkillResolution>;
}

export const SKILL_TOOLS = [
  {
    name: "skills_pendientes",
    description: "Lista las skills que Ronin propone y esperan aprobación: SKILL.md completo, contentHash, diff si es una actualización y avisos.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "Limita la lista a un repositorio configurado." } },
      additionalProperties: false,
    },
  },
  {
    name: "resolver_skill",
    description: "Aprueba, descarta o edita (y aprueba) una skill propuesta. Aprobar exige el hash del texto que se mostró.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        accion: { type: "string", enum: ["aprobar", "descartar", "editar"] },
        hash: { type: "string", description: "contentHash que devolvió skills_pendientes; obligatorio con aprobar." },
        contenido: { type: "string", description: "SKILL.md completo; obligatorio con editar. Pasa por las mismas reglas." },
      },
      required: ["id", "accion"],
      additionalProperties: false,
    },
  },
] as const;

export function isSkillTool(name: string): boolean {
  return SKILL_TOOLS.some((tool) => tool.name === name);
}

const ACTIONS = { aprobar: "approve", descartar: "discard", editar: "edit" } as const;

function invalid(message: string): McpToolError {
  return new McpToolError("SKILL_INVALID", message);
}

export async function callSkillTool(name: string, args: Record<string, unknown>, port: McpSkillPort): Promise<string> {
  if (name === "skills_pendientes") {
    const { repo } = args;
    if (repo !== undefined && (typeof repo !== "string" || !repo.trim())) throw invalid("repo debe ser una cadena no vacía");
    return JSON.stringify(await port.pending(repo));
  }
  if (name === "resolver_skill") {
    const { id, accion, hash, contenido } = args;
    if (typeof id !== "string" || !id.trim()) throw invalid("id debe ser una cadena no vacía");
    if (accion !== "aprobar" && accion !== "descartar" && accion !== "editar") throw invalid("accion debe ser aprobar, descartar o editar");
    if (hash !== undefined && typeof hash !== "string") throw invalid("hash debe ser una cadena");
    if (contenido !== undefined && typeof contenido !== "string") throw invalid("contenido debe ser una cadena");
    if (accion === "aprobar" && !hash) throw invalid("hash es obligatorio para aprobar");
    if (accion === "editar" && contenido === undefined) throw invalid("contenido es obligatorio para editar");
    return JSON.stringify(await port.resolve(id, accion, { hash, contenido }));
  }
  throw new McpToolError("TOOL_UNKNOWN", `herramienta desconocida: ${name}`);
}

/** Un error del store viaja con su código si es NOT_FOUND o STALE; cualquier otro, como SKILL_INVALID. */
function toToolError(error: unknown): unknown {
  if (error instanceof LearnedSkillError) {
    const code = error.code === "SKILL_PROPOSAL_NOT_FOUND" || error.code === "SKILL_STALE" ? error.code : "SKILL_INVALID";
    return new McpToolError(code, error.message);
  }
  return error;
}

export function createSkillPort(store: Pick<LearnedSkillStore, "pending" | "detail" | "resolve">): McpSkillPort {
  return {
    async pending(repo) {
      try {
        return store.pending(repo).map((summary) => {
          const detail = store.detail(summary.id);
          return {
            id: detail.id,
            kind: detail.kind,
            name: detail.name,
            repo: detail.repo,
            source: detail.source,
            description: detail.description,
            content: detail.content,
            contentHash: detail.contentHash,
            diff: detail.diff ?? null,
            changes: detail.changes,
            warnings: detail.warnings,
          };
        });
      } catch (error) {
        throw toToolError(error);
      }
    },
    async resolve(id, accion, options) {
      try {
        const result = store.resolve(id, ACTIONS[accion], { contentHash: options.hash, content: options.contenido });
        return {
          id,
          name: result.proposal.name,
          resultado: result.proposal.status === "discarded" ? "descartada" : "aprobada",
          ...(result.skill ? { version: result.skill.version } : {}),
        };
      } catch (error) {
        throw toToolError(error);
      }
    },
  };
}
