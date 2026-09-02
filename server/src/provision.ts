import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runVerify, type VerifyResult } from "./verify.js";

/**
 * Un worktree recién creado no trae entorno de dependencias: `.venv` y `node_modules` están
 * gitignorados, así que la copia de la sesión no puede correr sus propias pruebas. Sin esto, el
 * gate de una etapa saldría rojo por falta de entorno y no por tests rotos — una señal falsa que
 * además quedaría guardada en el histórico.
 *
 * El comando lo declara el override por-repo (`setupCommand`), gitignorado, el mismo trust
 * boundary que `startCommand` y `verifyCmd`.
 */

/** Crear un venv e instalar ~100 paquetes se va a varios minutos; el default de runVerify no da. */
export const PROVISION_TIMEOUT_MS = 1_800_000;

export type ProvisionStatus = "running" | "ok" | "failed";

export interface ProvisionState {
  status: ProvisionStatus;
  startedAt: number;
  finishedAt?: number;
  output?: string;
}

const FILE = "provision.json";

export function readProvisionState(cycle: string): ProvisionState | null {
  try {
    const raw = JSON.parse(readFileSync(join(cycle, FILE), "utf8"));
    if (raw && typeof raw.status === "string" && typeof raw.startedAt === "number") return raw as ProvisionState;
  } catch {
    /* ausente o ilegible */
  }
  return null;
}

export function writeProvisionState(cycle: string, state: ProvisionState): void {
  try {
    writeFileSync(join(cycle, FILE), JSON.stringify(state));
  } catch {
    /* best-effort: el estado es una comodidad, no puede tumbar un lanzamiento */
  }
}

export interface ProvisionDeps {
  run(cmd: string, cwd: string, timeoutMs: number): Promise<VerifyResult>;
  now?: () => number;
}

// Se reutiliza `runVerify` A PROPÓSITO: no es un verify, pero necesita exactamente su semántica
// —shell, cwd fijo, timeout que mata el GRUPO de procesos y nunca lanza—, y duplicarla sería
// mantener dos veces la misma trampa de procesos huérfanos.
const defaultDeps: ProvisionDeps = { run: runVerify };

/**
 * Provisiona el entorno del worktree. Deja el estado en disco ANTES de arrancar (un reinicio a
 * media instalación tiene que poder saber que había una en vuelo) y NUNCA lanza: un entorno que
 * no se pudo armar es un problema de setup que se reporta, no una excepción que rompe el
 * lanzamiento de la sesión.
 */
export async function provisionWorktree(
  cycle: string,
  cwd: string,
  cmd: string,
  deps: ProvisionDeps = defaultDeps,
): Promise<ProvisionState> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  writeProvisionState(cycle, { status: "running", startedAt });

  let result: VerifyResult;
  try {
    result = await deps.run(cmd, cwd, PROVISION_TIMEOUT_MS);
  } catch (error) {
    const failed: ProvisionState = { status: "failed", startedAt, finishedAt: now(), output: String(error) };
    writeProvisionState(cycle, failed);
    return failed;
  }

  const state: ProvisionState = {
    status: result.ok ? "ok" : "failed",
    startedAt,
    finishedAt: now(),
    output: result.output,
  };
  writeProvisionState(cycle, state);
  return state;
}
