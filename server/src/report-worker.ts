import { readdirSync, statSync } from "node:fs";
import { readEvidence } from "./stages.js";
import { truncate } from "./history.js";

const TMP = "/tmp";
const FULL = "cowork-cycle-cowork-";   // prefijo completo: uniqueSession añade "cowork-" a sanitizeKey(key)

/** Igual que sanitizeKey (engine, privada): no-alnum/_/- → "-", cap 40, lowercase para comparar. */
function normKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40).toLowerCase();
}

/**
 * Evidencia de una tarea ya completada cuyo cycle dir sigue en /tmp (best-effort, nunca lanza).
 * Escanea /tmp/cowork-cycle-cowork-*, matchea el key sanitizado como SEGMENTO exacto (o segmento +
 * sufijo -research/-action-/-N), lee summary→verdict→research→curl del más reciente con contenido y
 * lo trunca en la fuente. Devuelve null si no hay nada.
 */
export function findCycleEvidence(key: string): string | null {
  const norm = normKey(key);
  if (!norm) return null;
  let names: string[] = [];
  try {
    names = readdirSync(TMP).filter((n) => {
      if (!n.startsWith(FULL)) return false;
      const seg = n.slice(FULL.length).toLowerCase();     // el dir puede traer mayúsculas → lowercase
      return seg === norm || seg.startsWith(norm + "-");  // key exacto, o key + -research/-action-…/-N
    });
  } catch {
    return null;
  }
  // más reciente primero (mtime)
  const cands = names
    .map((n) => {
      let mtime = 0;
      try { mtime = statSync(`${TMP}/${n}`).mtimeMs; } catch { /* ignora */ }
      return { cycle: `${TMP}/${n}`, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of cands) {
    try {
      const ev = readEvidence(c.cycle);
      const text = ev.summary ?? ev.verdict ?? ev.research ?? ev.curl;
      if (text) return truncate(text);   // prolijo: trunca en la fuente, como captureEvidence
    } catch {
      /* best-effort: siguiente candidato */
    }
  }
  return null;
}
