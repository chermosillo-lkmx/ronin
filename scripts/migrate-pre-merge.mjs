#!/usr/bin/env node
// Migra un workflows.json (catálogo de flujos de Ronin) al esquema "una corrida":
// el gate de unitarias pasa de tests/arreglar a una etapa `pre-merge` justo antes del merge y
// se quitan las instrucciones de re-correr la suite. Idempotente: si el workflow ya tiene una
// etapa `pre-merge`, no se toca. Uso: node scripts/migrate-pre-merge.mjs <workflows.json>
// Deja `<archivo>.bak-<YYYYMMDD-HHMMSS>` (hora local) sólo cuando algo cambia.
import { copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// unit-gate.sh como segmento de ruta o palabra suelta, con o sin argumentos (también dentro de un wrapper).
const GATE_SCRIPT = /(^|[\s/])unit-gate\.sh(\s|$)/;
const isGate = (s) => GATE_SCRIPT.test(s?.verifyCmd ?? "");
const GATED_KEYS = ["tests", "arreglar"];

export const TESTS_INSTRUCTION =
  "Repara fixtures rotos antes de escribir tests nuevos. Corre SÓLO tests dirigidos (los archivos o casos que tocaste o que cubren el cambio) generando JUnit: pytest -q <archivos> --junitxml=reports/junit.xml --cov=src --cov-report=xml:reports/coverage.xml (o vitest run <archivos> --reporter=junit --outputFile=reports/junit.xml). Repórtalo a Ronin con mcp__ronin__reportar_pruebas pasando repo, suite y la ruta ABSOLUTA del junit.xml (y del coverage.xml si lo hay); necesita el junit de esa corrida dirigida, y los conteos los extrae Ronin del artefacto, no de tu resumen, así que no los transcribas. Guarda además el resumen exacto (passed/failed/cobertura) en {ev}/tests.md; no avances con fallos nuevos. REGLA DE PRUEBAS UNITARIAS (obligatoria antes de cualquier merge): todo cambio en src/ trae sus pruebas unitarias en el mismo PR y las pruebas nuevas se ejecutan y pasan. NO corras la suite completa ni `unit-gate.sh` en esta etapa: Ronin corre el gate de unitarias una sola vez, en la etapa pre-merge. No se «arregla» un gate quitando, saltando (skip/xfail) o debilitando pruebas.";

export const PRE_MERGE_INSTRUCTION =
  "Asegúrate de que todo está commiteado, toca el sentinela de `pre-merge` y termina tu turno. **No corras la suite ni `unit-gate.sh`.** Ronin corre el gate y te escribe el veredicto: `UNIT-GATE: PASS` o `UNIT-GATE: FAIL`; el veredicto queda en {cycle}/verify-pre-merge.json y la salida del gate en {cycle}/verify-pre-merge.log. Con `UNIT-GATE: PASS` sigue a la siguiente etapa. Con `UNIT-GATE: FAIL`, lee esa salida, arregla con tests dirigidos, commitea y vuelve a tocar el sentinela; si dice que los intentos se agotaron, para y pide intervención humana. Si Ronin responde `UNIT-GATE: SIN-GATE`, sigue con la siguiente etapa.";

const PR_BASE =
  "Abre el PR con un cuerpo que explique el porqué, no sólo el qué, y enlaza el ticket. Espera a que los checks terminen. Haz el merge SÓLO si está mergeable de verdad; si no, arregla lo que falte antes. Nunca fuerces el merge.";

const MERGE_ADDITION =
  "Antes de mergear confirma en {cycle}/verify-pre-merge.json que `status` sea `passed` (un FAIL también guarda `shas`) y que el HEAD que vas a mergear sea el SHA que aprobó el gate (campo `shas`). Si difiere, mira `git diff --name-only <sha aprobado> HEAD`: si toca algo fuera de las rutas e2e (`e2e_dev/`), vuelve a la etapa pre-merge; si sólo toca e2e, el PASS sigue vigente. Sin `UNIT-GATE: PASS` vigente no hay merge, aunque los checks de GitHub estén en verde. Sólo si Ronin respondió `UNIT-GATE: SIN-GATE` (el flujo no tiene gate de unitarias) no hay veredicto que comprobar.";

const ARREGLAR_RULE =
  "REGLA DE PRUEBAS UNITARIAS (obligatoria antes de cualquier merge): todo cambio en src/ trae sus pruebas unitarias en el mismo PR y las pruebas nuevas se ejecutan y pasan. Verifica con tests dirigidos; NO corras la suite completa ni `unit-gate.sh` aquí: Ronin corre el gate de unitarias una sola vez, en la etapa pre-merge. No se «arregla» un gate quitando, saltando (skip/xfail) o debilitando pruebas.";

// Quita desde `marca` hasta el final y añade `texto`.
const reemplazarCola = (instruction, marca, texto) => {
  const i = instruction.indexOf(marca);
  const base = (i >= 0 ? instruction.slice(0, i) : instruction).trimEnd();
  return `${base} ${texto}`;
};

const withMergeRule = (instruction) => reemplazarCola(instruction, "Antes de mergear vuelve a correr", MERGE_ADDITION);

function preMergeStage(verifyCmd) {
  const s = { key: "pre-merge", label: "Gate pre-merge", icon: "🛡", instruction: PRE_MERGE_INSTRUCTION };
  if (verifyCmd) {
    s.verifyCmd = verifyCmd;
    s.maxRetries = 3;
    s.mergeGate = true;
  }
  return s;
}

const prStage = () => ({ key: "pr", label: "PR y merge", icon: "⤵️", executor: "claude", instruction: withMergeRule(PR_BASE) });

/** Migra un workflow en sitio. Devuelve true si cambió algo. */
export function migrateWorkflow(w, archivoTieneGate = false) {
  const stages = w.config?.stages;
  if (!Array.isArray(stages)) return false;
  if (stages.some((s) => s.key === "pre-merge")) {
    if (stages.some((s) => GATED_KEYS.includes(s.key) && isGate(s))) {
      throw new Error(`el workflow «${w.name}» ya tiene pre-merge pero tests/arreglar aún llevan el verifyCmd de unit-gate: migración a medias, revísalo a mano. No se escribió nada.`);
    }
    return false;
  }
  const idxMerge = stages.findIndex((s) => s.key === "pr" || s.key === "merge");
  const idxTests = stages.findIndex((s) => s.key === "tests");
  const idxCurl = stages.findIndex((s) => s.key === "curl");
  if (idxMerge < 0 && !(idxTests >= 0 && idxCurl > idxTests)) return false;

  // El verifyCmd del gate de unitarias se mueve de tests/arreglar a pre-merge.
  let verifyCmd;
  for (const s of stages) {
    if (GATED_KEYS.includes(s.key) && isGate(s)) {
      verifyCmd ??= s.verifyCmd;
      delete s.verifyCmd;
      delete s.maxRetries;
    }
  }

  for (const s of stages) {
    if (s.key === "tests") s.instruction = TESTS_INSTRUCTION;
    else if (s.key === "arreglar") s.instruction = reemplazarCola(s.instruction, "REGLA DE PRUEBAS UNITARIAS", ARREGLAR_RULE);
    else if (s.key === "pr" || s.key === "merge") s.instruction = withMergeRule(s.instruction);
    else if (s.key === "curl" || s.key === "pruebas-dev") s.instruction = s.instruction.replaceAll(" (con su unit-gate)", " (exento del gate de unitarias)");
  }

  if (!verifyCmd && archivoTieneGate) {
    throw new Error(`el workflow «${w.name}» mergea pero no se reconoció su gate de unit-gate en tests/arreglar, y el archivo tiene unit-gate en otros workflows: se perdería el gate. No se escribió nada.`);
  }
  if (idxMerge >= 0) stages.splice(idxMerge, 0, preMergeStage(verifyCmd));
  else stages.splice(idxTests + 1, 0, preMergeStage(verifyCmd), prStage());
  return true;
}

export function migrateCatalog(data) {
  let changed = false;
  const tieneGate = (data.items ?? []).some((w) => (w.config?.stages ?? []).some(isGate));
  for (const w of data.items ?? []) if (migrateWorkflow(w, tieneGate)) changed = true;
  return changed;
}

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function main(file) {
  if (!file) { console.error("uso: migrate-pre-merge.mjs <workflows.json>"); return 2; }
  const raw = readFileSync(file, "utf8");
  const data = JSON.parse(raw);
  let changed;
  try { changed = migrateCatalog(data); } catch (e) { console.error(`migrate-pre-merge: ${e.message}`); return 1; }
  if (!changed) { console.log(`sin cambios: ${file}`); return 0; }
  const bak = `${file}.bak-${stamp()}`;
  copyFileSync(file, bak);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
  console.log(`migrado: ${file}\nrespaldo: ${bak}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv[2]));
