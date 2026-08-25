import type { Signals } from "./signals.js";

/**
 * Construye el prompt (en español) para el análisis headless de Claude (`claude -p`):
 * le da el rol de analista de flujo de trabajo, el catálogo de workflows existentes,
 * el esquema de etapa admitido (sin el campo de verificación por comando de shell: ese
 * campo solo se controla vía override de repo, nunca vía propuesta de un LLM), y las
 * señales recolectadas como JSON compacto.
 * Pide una respuesta envuelta en `<PROPOSALS>...</PROPOSALS>` para poder extraerla con
 * `extractProposalsJson` sin depender de que el resto de la salida sea JSON válido.
 */
export function buildPrompt(signals: Signals, catalogNames: string[]): string {
  const catalog = catalogNames.length > 0 ? catalogNames.join(", ") : "(ninguno)";
  const signalsJson = JSON.stringify(signals);

  return `Eres un analista de flujo de trabajo para un equipo de desarrollo que usa Ronin.

Workflows existentes: ${catalog}

Con base en las señales de trabajo reciente (tareas, commits y evidencia) que se te dan más abajo, propón entre 1 y 4 workflows NUEVOS que no dupliquen a los existentes. Cada propuesta debe capturar un patrón real observado en las señales, no un workflow genérico.

Cada propuesta debe tener:
- "name": un slug corto (minúsculas, guiones).
- "rationale": por qué este workflow tiene sentido, en 400 caracteres o menos.
- "evidence": una lista de claves de tarea o hashes de commit de las señales que respaldan la propuesta.
- "config": un objeto con:
  - "stages": entre 2 y 7 etapas, cada una con:
    - "key": identificador corto de la etapa.
    - "label": etiqueta breve para mostrar.
    - "icon": un ícono para la etapa.
    - "instruction" (opcional): qué debe hacer el worker en esta etapa.
    - "role" (opcional): solo puede ser "role": "impl", y debe aparecer en EXACTAMENTE una etapa de cada workflow propuesto (la etapa de implementación).
  - "verifyAfter": la "key" de la etapa después de la cual correr verificación, o null si no aplica.

No agregues ningún campo de verificación por comando de shell a las etapas: ese tipo de campo no se puede proponer, solo se configura manualmente por repo.

Responde SÓLO con el siguiente formato, sin texto antes ni después:
<PROPOSALS>{"proposals":[...]}</PROPOSALS>

Señales (JSON compacto):
\`\`\`json
${signalsJson}
\`\`\`
`;
}

const PROPOSALS_RE = /<PROPOSALS>([\s\S]*?)<\/PROPOSALS>/i;

/**
 * Extrae y parsea el bloque `<PROPOSALS>...</PROPOSALS>` de la salida de `claude -p`.
 * Lanza si falta el bloque o si su contenido no es JSON válido — nunca devuelve `undefined`
 * silenciosamente, para que el llamador nunca trate una salida rota como "sin propuestas".
 */
export function extractProposalsJson(stdout: string): unknown {
  const match = PROPOSALS_RE.exec(stdout);
  if (!match) throw new Error("salida sin JSON válido");
  try {
    return JSON.parse(match[1]);
  } catch {
    throw new Error("salida sin JSON válido");
  }
}
