import { join } from "node:path";

// Duplicación deliberada de `server/src/data-dir.ts` (resolveDataDirectory + BUNDLED_DATA_DIR)
// y de `server/src/capability.ts` (dataPath("capability-token")): el cargador de config de
// Vite/esbuild no puede importar `server/src/*.ts` de forma fiable, así que esta función
// recalcula la misma ruta a partir del directorio de trabajo del proceso de Vite (que es
// `web/`, un nivel por debajo de la raíz del repo). `capability-path.test.ts` (12f) es la
// paridad obligatoria contra `CAPABILITY_FILE` real — mismo patrón que el validador de
// nombre duplicado en T0.4.
export function resolveWebCapabilityFile(webPackageDir: string, dataDirOverride: string | undefined): string {
  const dir = dataDirOverride?.trim() || join(webPackageDir, "..", "server", "data");
  return join(dir, "capability-token");
}
