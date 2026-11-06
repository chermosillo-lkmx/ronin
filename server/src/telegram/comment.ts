import { runClaudeP } from "../claude-p.js";
import { resolveCwd } from "../repos.js";
import { wrapThirdParty } from "./interpret.js";
import { redactSecrets } from "./outbound.js";

export const COMMENT_ARGS = [
  "-p", "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--disallowedTools",
  "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/*credentials*)", "Read(**/*secret*)",
];
const COMMENT_TIMEOUT_MS = 110_000;
/** `redactSecrets` no es idempotente con secretos muy cortos: se ignoran por debajo de este largo. */
const MIN_SECRET_LENGTH = 8;

export interface CommentDeps {
  run?: typeof runClaudeP;
  resolveCwd?: (repo: string) => { cwd: string; real: boolean };
  /** Token del bot, capability y valores de `vars` del repo. */
  secrets?: () => string[];
}

export async function draftCommentReply(
  input: { repo: string; comment: string; guidance?: string; previous?: string },
  deps: CommentDeps = {},
): Promise<string> {
  const run = deps.run ?? runClaudeP;
  const cwd = (deps.resolveCwd ?? resolveCwd)(input.repo).cwd;
  const prompt = [
    "Redacta una respuesta breve en español a un comentario sobre este repositorio.",
    "Puedes leer el código con Read, Grep y Glob; no puedes escribir ni ejecutar nada. No leas archivos de credenciales ni reproduzcas secretos.",
    "Responde solo con el texto de la respuesta.",
    input.guidance ? `Indicación de César para la respuesta: ${input.guidance}` : "",
    input.previous ? `Borrador anterior, que César quiere mejorar:\n${input.previous}` : "",
    "Comentario a responder:",
    wrapThirdParty(input.comment),
  ].filter(Boolean).join("\n\n");

  let out: string;
  try {
    out = await run(prompt, { command: "claude", args: COMMENT_ARGS, cwd, timeoutMs: COMMENT_TIMEOUT_MS });
  } catch (error) {
    // Nunca se reenvía el mensaje original: puede traer stderr, rutas o valores internos.
    const timedOut = error instanceof Error && /tiempo l[ií]mite/.test(error.message);
    throw new Error(timedOut
      ? "Claude excedió el tiempo para redactar la respuesta. Intenta de nuevo."
      : "No pude redactar la respuesta con Claude. Intenta de nuevo.");
  }
  const secrets = (deps.secrets?.() ?? []).filter((s) => s.length >= MIN_SECRET_LENGTH);
  return redactSecrets(out, secrets).trim();
}
