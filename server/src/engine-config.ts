import { sanitizeModel } from "./models.js";

export type EngineTool = "claude" | "codex" | "agy";

export interface EngineChoice {
  tool: EngineTool;
  model?: string;
}

export const DEFAULT_ENGINE: EngineChoice = { tool: "claude" };

const INVOCATIONS: Record<EngineTool, { command: string; args: string[] }> = {
  claude: { command: "claude", args: ["-p"] },
  codex: { command: "codex", args: ["exec"] },
  agy: { command: "agy", args: ["-p"] },
};

export function sanitizeEngine(raw: unknown): EngineChoice {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_ENGINE };
  const input = raw as { tool?: unknown; model?: unknown };
  if (input.tool !== "claude" && input.tool !== "codex" && input.tool !== "agy") return { ...DEFAULT_ENGINE };
  const model = sanitizeModel(typeof input.model === "string" ? input.model : "");
  return model ? { tool: input.tool, model } : { tool: input.tool };
}

export function engineInvocation(engine: EngineChoice): { command: string; args: string[] } {
  const choice = sanitizeEngine(engine);
  const invocation = INVOCATIONS[choice.tool];
  return { command: invocation.command, args: [...invocation.args, ...(choice.model ? ["--model", choice.model] : [])] };
}
