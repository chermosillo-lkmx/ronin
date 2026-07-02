import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

export interface DMClassification {
  isTask: boolean;
  complexity: "simple" | "complex";
  task: string;
}

/**
 * Classify a direct message via headless Claude Code (`claude -p`) — uses the
 * user's subscription, no API key, no interactive session.
 */
export async function classifyDM(text: string): Promise<DMClassification> {
  const prompt =
    `Eres un clasificador. Analiza este mensaje directo de chat y decide si contiene una ` +
    `SOLICITUD DE TAREA TÉCNICA ACCIONABLE para un dev (ej. "¿tienes un script para X?", ` +
    `"puedes ajustar Y?", "necesito que implementes Z, aquí el ticket ..."). NO es tarea: saludos, ` +
    `agradecimientos, charla, confirmaciones, o solo compartir info/un link SIN pedir una acción. ` +
    `Clasifica la complejidad: "simple" = verificar/revisar algo en la plataforma o una pregunta puntual ` +
    `(sin implementar); "complex" = implementar/construir/arreglar algo nuevo (puede traer un link de ticket para contexto). ` +
    `Responde EXCLUSIVAMENTE con JSON en una línea, sin texto extra: ` +
    `{"isTask": true|false, "complexity": "simple"|"complex", "task": "<descripción concisa y accionable, o cadena vacía>"}.\n\n` +
    `MENSAJE:\n${text}`;
  try {
    const { stdout } = await pexec("claude", ["-p", prompt], { timeout: 45000, maxBuffer: 1 << 20 });
    const json = extractJson(stdout);
    if (json && typeof json.isTask === "boolean") {
      return {
        isTask: json.isTask,
        complexity: json.complexity === "complex" ? "complex" : "simple",
        task: typeof json.task === "string" ? json.task : "",
      };
    }
  } catch (e) {
    console.warn(`[claude-cowork] clasificación DM falló: ${(e as Error).message}`);
  }
  return { isTask: false, complexity: "simple", task: "" };
}

function extractJson(s: string): any {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
