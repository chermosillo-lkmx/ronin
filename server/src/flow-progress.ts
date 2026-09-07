import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFlow, readVerifyState } from "./stages.js";
import type { SessionFlow, FlowStageProgress } from "./types.js";

/**
 * Avance del flujo de una sesión, leído del cycle dir: NADA aquí se le pregunta al agente ni se
 * infiere de la pantalla.
 *
 *  · las etapas y su orden       → flow.json (lo escribe el lanzamiento)
 *  · las cumplidas               → el archivo centinela que el agente toca al cerrar cada etapa
 *  · el reloj                    → el mtime de ese centinela
 *  · la verificación fallida     → verify-<etapa>.json (P2)
 *
 * Se llama en el mismo barrido que ya arma el inventario, así que es de sólo lectura, síncrono y
 * nunca lanza: un ciclo a medio escribir devuelve null y el inspector se queda como estaba.
 */
export function readFlowProgress(cycle: string): SessionFlow | null {
  const flow = readFlow(cycle);
  if (!flow?.stages?.length) return null;

  // Sólo archivos regulares: `evidence/` es un subdirectorio y una etapa con esa clave se daría
  // por cumplida siempre (mismo cuidado que detectStage).
  let files: Set<string>;
  try {
    files = new Set(readdirSync(cycle, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return null;
  }

  // La etapa EN CURSO es la primera sin centinela después de la última que sí lo tiene. Una etapa
  // saltada (sin centinela, pero con etapas cumplidas después) se queda pendiente a propósito:
  // pintarla verde afirmaría que corrió, y de eso no hay constancia.
  const cumplidas = flow.stages.map((s) => files.has(s.key));
  const ultimaCumplida = cumplidas.lastIndexOf(true);
  const enCurso = cumplidas.indexOf(false, ultimaCumplida + 1);

  let previa: number | null = null;
  const stages: FlowStageProgress[] = flow.stages.map((stage, i) => {
    const at = cumplidas[i] ? mtimeOf(cycle, stage.key) : i === enCurso ? previa : null;
    if (cumplidas[i] && at !== null) previa = at;

    const verify = i === enCurso ? readVerifyState(cycle, stage.key) : null;
    const status: FlowStageProgress["status"] = cumplidas[i]
      ? "done"
      : i !== enCurso ? "pending"
      : verify?.status === "failed" ? "failed" : "current";

    return {
      key: stage.key,
      label: stage.label,
      ...(stage.icon ? { icon: stage.icon } : {}),
      ...(stage.executor ? { executor: stage.executor } : {}),
      status,
      ...(at !== null ? { at } : {}),
      ...(status === "failed" && verify ? { attempts: verify.attempts } : {}),
    };
  });

  const workflow = workflowName(cycle);
  return {
    ...(workflow ? { workflow } : {}),
    done: cumplidas.filter(Boolean).length,
    total: stages.length,
    stages,
  };
}

function mtimeOf(cycle: string, key: string): number | null {
  try {
    return statSync(join(cycle, key)).mtimeMs;
  } catch {
    return null;
  }
}

/** El nombre legible del workflow vive en el registro de lanzamiento, no en flow.json. */
function workflowName(cycle: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(cycle, "launch.json"), "utf8")) as { workflowName?: unknown };
    return typeof raw?.workflowName === "string" && raw.workflowName.trim() ? raw.workflowName : null;
  } catch {
    return null;
  }
}

/**
 * Lo que el cycle dir tiene REGISTRADO sobre una sesión: su avance, y si no hay nada anotado.
 *
 * `unrecorded` distingue dos ausencias que se ven igual desde fuera pero no lo son: una terminal
 * normal (launch.json con mode=terminal) NO tiene etapas por diseño, mientras que un dir vacío es
 * un lanzamiento que se cortó entre ensureCycleDir y writeFlow. La sesión sigue contando como
 * gestionada porque el dir existe, y sin esta marca la UI le esconde «Adoptar» — que es lo único
 * que le escribiría un flujo. Un dir inexistente no se marca: esa sesión ni siquiera es gestionada.
 */
export interface CycleRecord {
  flow: SessionFlow | null;
  unrecorded: boolean;
}

export function readCycleRecord(cycle: string): CycleRecord {
  const flow = readFlowProgress(cycle);
  if (flow) return { flow, unrecorded: false };
  const anotado = existsSync(join(cycle, "flow.json")) || existsSync(join(cycle, "launch.json"));
  return { flow: null, unrecorded: existsSync(cycle) && !anotado };
}
