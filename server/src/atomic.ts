import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";

export interface WriteJsonAtomicOverrides {
  rename?: (tmp: string, target: string) => void;
}

/**
 * Escritura atómica que LANZA (B4/T2): `adopted.json` y `flow.json` no siguen el patrón
 * best-effort de stages.ts (markModelSwitched, etc.) — ahí perder la escritura sólo repite
 * trabajo; aquí perderla en silencio rompería la garantía de "sin adopción parcial". El
 * llamador decide el rollback; esta función nunca traga el error.
 */
export function writeJsonAtomic(target: string, value: unknown, overrides: WriteJsonAtomicOverrides = {}): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    (overrides.rename ?? renameSync)(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // El temporal es diagnóstico en el peor caso; el destino sigue íntegro, que es la garantía.
    }
    throw error;
  }
}
