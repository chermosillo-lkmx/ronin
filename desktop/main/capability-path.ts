import { join } from "node:path";

// `desktop/` no puede importar `server/src/*` (tsconfig.desktop.json rootDir:"desktop"), así
// que esta función duplica DELIBERADAMENTE la resolución de `server/src/data-dir.ts`
// (resolveDataDirectory + BUNDLED_DATA_DIR) y el override forzado que `desktop/main/index.ts`
// ya construye para el env del backend forkeado. Las dos rutas DEBEN coincidir para que el
// proxy lea el mismo `capability-token` que el server escribió; capability-path.test.ts es
// la paridad — mismo patrón que el validador de nombre de T0.4.
export interface CapabilityPathOptions {
  root: string;
  isPackaged: boolean;
  userDataPath?: string;
  dataDirOverride?: string;
}

export function resolveCapabilityDataDir(options: CapabilityPathOptions): string {
  const override = options.dataDirOverride?.trim();
  if (options.isPackaged && options.userDataPath && !override) {
    return join(options.userDataPath, "data");
  }
  return override || join(options.root, "server", "data");
}

export function resolveCapabilityFile(options: CapabilityPathOptions): string {
  return join(resolveCapabilityDataDir(options), "capability-token");
}
