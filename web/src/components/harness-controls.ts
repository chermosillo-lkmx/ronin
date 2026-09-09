import type { WfStage } from "../types";

/**
 * Pure derivation and patching for the Harness view. Validation remains server-owned in
 * server/src/workflow.ts, while session edit state remains in workflow-draft.ts.
 *
 * `verifyCmd` and `maxRetries` deliberately stay paired exactly as normalized by
 * server/src/workflow.ts:266-276. Do not turn maxRetries into a separate toggle: it is a
 * parameter of verifyCmd and cannot persist independently.
 */

export type ControlId = "instruction" | "executor" | "verifyCmd" | "verifier";
export type Axis = "guide" | "sensor";
export type Kind = "deterministic" | "inferential";
export type BandId = "guides" | "deterministic-sensors" | "inferential-sensors" | "gates";

export interface Band {
  id: BandId;
  label: string;
  note: string;
  active: number;
  total: number;
  mixed: boolean;
  disabled: boolean;
  disabledReason?: string;
  disabledReasonId?: StageIdentityReasonId;
}

export interface HarnessStash {
  instruction?: string;
  verifyCmd?: string;
  maxRetries?: number;
  executor?: "claude" | "codex" | "agy";
  model?: string;
  verifier?: true;
}

export type ControlValue =
  | { id: "instruction"; instruction: string }
  | { id: "verifyCmd"; verifyCmd: string; maxRetries?: number }
  | { id: "executor"; executor?: "claude" | "codex" | "agy"; model?: string };

function hasText(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

export function isPersistable(value: ControlValue): boolean {
  if (value.id === "instruction") return hasText(value.instruction);
  if (value.id === "verifyCmd") return hasText(value.verifyCmd);
  return value.executor !== undefined;
}

export function valuePatch(value: ControlValue): Partial<WfStage> {
  if (value.id === "instruction") return { instruction: value.instruction };
  if (value.id === "executor") return { executor: value.executor, model: value.model };
  return {
    verifyCmd: value.verifyCmd,
    maxRetries: value.maxRetries ?? 2,
  };
}

export function parseMaxRetriesInput(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

export interface HarnessControl {
  id: ControlId | string;
  source: "field" | "instruction";
  axis: Axis;
  kind: Kind;
  on: boolean;
  disabled: boolean;
  disabledReason?: string;
  warning?: string;
  note: string;
  loss: string;
}

export type StageIdentityReasonId = "empty-key" | "duplicate-key";

export interface StageIdentityReason {
  id: StageIdentityReasonId;
  label: string;
}

const STAGE_IDENTITY_LABELS: Record<StageIdentityReasonId, string> = {
  "empty-key": "Esta etapa necesita una key antes de configurar su harness.",
  "duplicate-key": "Esta key identifica más de una etapa; corrígela antes de configurar su harness.",
};

function identityReason(id: StageIdentityReasonId): StageIdentityReason {
  return { id, label: STAGE_IDENTITY_LABELS[id] };
}

const COVERAGE_NOTES = [
  "Ninguna etapa deja evidencia verificable: el loop entero corre sobre lo que el agente dice de sí mismo.",
  "Una sola etapa deja artefacto. Todo lo demás es autoreporte.",
  "Las demás etapas se apoyan en texto. Sólo donde hay artefacto hay evidencia.",
  "Tres o más etapas dejan artefacto: el avance deja de depender de lo que el agente afirma.",
] as const;

const INSTRUCTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; id: string; axis: Axis; kind: Kind }> = [
  { pattern: /junit/i, id: "junit.xml", axis: "sensor", kind: "deterministic" },
  { pattern: /coverage|cobertura|lcov/i, id: "coverage.xml", axis: "sensor", kind: "deterministic" },
  { pattern: /reportar_pruebas|backup-tester|ingesta/i, id: "ingesta", axis: "sensor", kind: "deterministic" },
  { pattern: /plan\.md/i, id: "plan.md", axis: "guide", kind: "inferential" },
  { pattern: /EVIDENCIA|\{ev\}/i, id: "evidencia", axis: "guide", kind: "inferential" },
];

const BAND_LABELS: Record<BandId, string> = {
  guides: "Guías",
  "deterministic-sensors": "Sensores deterministas",
  "inferential-sensors": "Sensores inferenciales",
  gates: "Gates de avance",
};

function fieldControl(
  control: Omit<HarnessControl, "source" | "disabled"> & { disabled?: boolean },
): HarnessControl {
  return { source: "field", disabled: false, ...control };
}

function makeBand(
  id: BandId,
  note: string,
  active: number,
  total: number,
  disabled = false,
  disabledReason?: string,
  disabledReasonId?: StageIdentityReasonId,
): Band {
  return { id, label: BAND_LABELS[id], note, active, total, mixed: active > 0 && active < total, disabled, disabledReason, disabledReasonId };
}

export function stageIdentityReason(stages: WfStage[], index: number): StageIdentityReason | null {
  const key = stages[index]?.key;
  if (!key?.trim()) return identityReason("empty-key");
  const duplicate = stages.some((stage, candidateIndex) => candidateIndex !== index && stage.key === key);
  return duplicate ? identityReason("duplicate-key") : null;
}

export function stageIdentityProblem(stages: WfStage[]): StageIdentityReason | null {
  return stages
    .map((_, index) => stageIdentityReason(stages, index))
    .find((reason) => reason !== null) ?? null;
}

export function stageControls(
  stage: WfStage,
  verifyAfter: string | null,
  allowVerifyCmd: boolean,
): HarnessControl[] {
  return [
    fieldControl({
      id: "instruction",
      axis: "guide",
      kind: "inferential",
      on: hasText(stage.instruction),
      note: "qué debe hacer esta etapa",
      loss: "el paso queda anunciado y numerado, sin ninguna instrucción detrás",
    }),
    fieldControl({
      id: "executor",
      axis: "guide",
      kind: "deterministic",
      on: stage.executor !== undefined,
      ...(stage.executor === "claude" && !hasText(stage.model)
        ? { warning: "igual que heredar: no cambia el prompt" }
        : {}),
      note: "qué herramienta ejecuta la etapa",
      loss: "hereda del flujo",
    }),
    fieldControl({
      id: "verifyCmd",
      axis: "sensor",
      kind: "deterministic",
      on: allowVerifyCmd && hasText(stage.verifyCmd),
      disabled: !allowVerifyCmd,
      ...(!allowVerifyCmd ? { disabledReason: "sólo en el override por-repo, que está en el gitignore" } : {}),
      note: "exit code manda",
      loss: "el avance vuelve a depender del autoreporte",
    }),
    fieldControl({
      id: "verifier",
      axis: "sensor",
      kind: "inferential",
      on: verifyAfter === stage.key,
      note: "un modelo juzga después del hecho",
      loss: "ningún verificador independiente revisa la etapa",
    }),
    ...instructionControls(stage.instruction ?? ""),
  ];
}

export function instructionControls(instruction: string): HarnessControl[] {
  return INSTRUCTION_PATTERNS
    .filter(({ pattern }) => pattern.test(instruction))
    .map(({ id, axis, kind }) => ({
      id,
      source: "instruction" as const,
      axis,
      kind,
      on: true,
      disabled: true,
      disabledReason: "descrito en la instrucción; nadie lo comprueba",
      note: "descrito en la instrucción; nadie lo comprueba",
      loss: "sólo puede cambiarse editando la instrucción",
    }));
}

export function controlPatch(
  stage: WfStage,
  id: ControlId,
  on: boolean,
  stash: HarnessStash,
): { patch: Partial<WfStage>; stash: HarnessStash } {
  if (id === "verifyCmd" && !on) {
    return {
      patch: { verifyCmd: undefined, maxRetries: undefined },
      stash: {
        ...stash,
        ...(stage.verifyCmd !== undefined ? { verifyCmd: stage.verifyCmd } : {}),
        ...(stage.maxRetries !== undefined ? { maxRetries: stage.maxRetries } : {}),
      },
    };
  }
  if (id === "executor" && !on) {
    return {
      patch: { executor: undefined, model: undefined },
      stash: {
        ...stash,
        ...(stage.executor !== undefined ? { executor: stage.executor } : {}),
        ...(stage.model !== undefined ? { model: stage.model } : {}),
      },
    };
  }
  if (id === "instruction" && !on) {
    return {
      patch: { instruction: "" },
      stash: {
        ...stash,
        ...(stage.instruction !== undefined ? { instruction: stage.instruction } : {}),
      },
    };
  }
  return { patch: {}, stash };
}

export function coverage(stages: WfStage[]): { covered: number; total: number; note: string } {
  const covered = stages.filter((stage) => hasText(stage.verifyCmd)).length;
  return { covered, total: stages.length, note: COVERAGE_NOTES[Math.min(covered, 3)] };
}

export function bands(
  stages: WfStage[],
  verifyAfter: string | null,
  allowVerifyCmd: boolean,
): Band[] {
  const identityProblem = stageIdentityProblem(stages);
  const totalStages = stages.length;
  const guidesActive = stages.reduce(
    (sum, stage) => sum + Number(hasText(stage.instruction)) + Number(stage.executor !== undefined),
    0,
  );
  const inferentialActive = stages.some((stage) => stage.key === verifyAfter) ? 1 : 0;
  const gatesActive = allowVerifyCmd
    ? stages.filter((stage) => hasText(stage.verifyCmd)).length
    : 0;
  return [
    makeBand(
      "guides",
      "el texto que dice qué hacer, antes de actuar",
      guidesActive,
      totalStages * 2,
      identityProblem !== null,
      identityProblem?.label,
      identityProblem?.id,
    ),
    makeBand(
      "deterministic-sensors",
      "artefactos que Ronin lee, no resúmenes",
      0,
      0,
      true,
      "nada aquí es configuración: son artefactos que la instrucción pide y que nadie lo comprueba",
    ),
    makeBand(
      "inferential-sensors",
      "un modelo juzgando después del hecho",
      inferentialActive,
      totalStages,
      identityProblem !== null,
      identityProblem?.label,
      identityProblem?.id,
    ),
    makeBand(
      "gates",
      "verifyCmd y maxRetries: exit code manda",
      gatesActive,
      totalStages,
      identityProblem !== null || !allowVerifyCmd,
      identityProblem?.label ?? (!allowVerifyCmd ? "sólo en el override por-repo, que está en el gitignore" : undefined),
      identityProblem?.id,
    ),
  ];
}

export function pendingDiscards(
  stages: WfStage[],
  stash: Record<string, HarnessStash>,
): Array<{ stageKey: string; id: Exclude<ControlId, "verifier"> }> {
  const result: Array<{ stageKey: string; id: Exclude<ControlId, "verifier"> }> = [];
  for (const stage of stages) {
    const saved = stash[stage.key];
    if (!saved) continue;
    if (hasText(saved.instruction) && !hasText(stage.instruction)) result.push({ stageKey: stage.key, id: "instruction" });
    if (saved.executor !== undefined && stage.executor === undefined) result.push({ stageKey: stage.key, id: "executor" });
    if (hasText(saved.verifyCmd) && !hasText(stage.verifyCmd)) result.push({ stageKey: stage.key, id: "verifyCmd" });
  }
  return result;
}
