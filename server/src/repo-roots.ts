import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { LIEBRE_ROOT } from "./config.js";
import { readAllowedRoots } from "./settings.js";

/**
 * M1 (rev 3) — las raíces de confianza vienen de una POLÍTICA INDEPENDIENTE, nunca de las
 * entradas que se van a validar. Derivarlas de los valores de `repos.json` metía el destino
 * de un symlink en la propia raíz permitida, con lo que la comprobación no podía fallar
 * nunca (el Reviewer lo señaló y tenía razón). `repos.json` pasa a ser un conjunto de
 * CANDIDATOS que se validan contra estas raíces, calculadas aparte.
 */
function parseAllowedRoots(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function computeTrustedRoots(rawEnv: string | undefined, fallback: string): string[] {
  const configured = parseAllowedRoots(rawEnv);
  const candidates = configured.length > 0 ? configured : [fallback];
  return candidates.map((root) => realpathSync(root));
}

/**
 * Comprobación por SEGMENTO de ruta, no por prefijo de cadena: `/a/bc` no debe leerse como
 * "dentro de" `/a/b`. `realPath` debe llegar ya resuelto (`realpathSync`) — esta función no
 * toca el disco, así que un symlink sin resolver la evadiría trivialmente.
 */
export function isWithinTrustedRoot(realPath: string, roots: string[]): boolean {
  return roots.some((root) => realPath === root || realPath.startsWith(root + sep));
}

export function trustedRoots(options: { allowedRoots?: string[]; defaultRoot?: string } = {}): string[] {
  const fromEnv = process.env.COWORK_ALLOWED_ROOTS;
  const candidates = fromEnv !== undefined
    ? parseAllowedRoots(fromEnv)
    : [...(options.allowedRoots ?? readAllowedRoots()), options.defaultRoot ?? LIEBRE_ROOT];
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      // Una raíz guardada puede desaparecer entre ejecuciones; avisamos y arrancamos con las
      // demás para que un settings.json viejo no convierta el arranque en un bloqueo total.
      console.warn(`raíz de confianza omitida porque no existe: ${candidate}`);
    }
  }
  return roots;
}
