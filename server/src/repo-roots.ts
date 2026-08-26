import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { LIEBRE_ROOT } from "./config.js";

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

// `COWORK_ALLOWED_ROOTS`: rutas absolutas separadas por `:`. Sin ella, cae a `[LIEBRE_ROOT]`.
// Se resuelve UNA VEZ al cargar (falla ruidoso al arrancar si una raíz no existe — mejor un
// crash explicable que una comprobación de seguridad que no se puede confiar en que corrió).
export const TRUSTED_ROOTS = computeTrustedRoots(process.env.COWORK_ALLOWED_ROOTS, LIEBRE_ROOT);
