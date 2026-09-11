import type { CSSProperties } from "react";
import type { WfStage } from "../types.js";
import { ExecutorPicker } from "./ExecutorPicker.js";
import { bands, coverage, parseMaxRetriesInput, stageControls, stageIdentityReason, type Band, type BandId, type ControlId, type ControlValue, type HarnessControl, type StageIdentityReason } from "./harness-controls.js";
import { GAP_X, NODE_H, NODE_W, ROW_Y, VERIFY_ROW_Y } from "./workflow-layout.js";

export interface HarnessViewProps {
  stages: WfStage[];
  verifyAfter: string | null;
  allowVerifyCmd: boolean;
  arming: { stageKey: string; id: ControlId } | null;
  verifyGate: boolean | null;
  onToggle: (stageKey: string, id: ControlId, on: boolean) => void;
  onEdit: (stageKey: string, value: ControlValue) => void;
  onBandToggle: (band: BandId, on: boolean) => void;
}

const GATE_DISABLED_DETAIL = "El servidor arrancó con COWORK_VERIFY_GATE=0, así que ningún verifyCmd se ejecuta. Este número cuenta sensores declarados, no comprobaciones hechas.";
const EXECUTOR_INITIALS = { claude: "C", codex: "X", agy: "A" } as const;
const LEGEND = [
  { id: "guide", label: "Guía", hint: "antes de actuar" },
  { id: "sensor", label: "Sensor", hint: "después del hecho" },
  { id: "deterministic", label: "Determinista", hint: "exit code, artefacto" },
  { id: "inferential", label: "Inferencial", hint: "un modelo opina" },
  { id: "source", label: "campo · instrucción", hint: "de dónde sale el control" },
] as const;

function controlOpen(
  stageKey: string,
  id: ControlId,
  on: boolean,
  arming: HarnessViewProps["arming"],
): boolean {
  return on || (arming?.stageKey === stageKey && arming.id === id);
}

function ControlCopy({ control, on }: { control: HarnessControl; on: boolean }) {
  return (
    <>
      <span className="wf-harness-control-name"><span>{control.id}</span><small>campo</small></span>
      <small>{control.note}</small>
      {!on && <small className="wf-harness-control-loss">{control.loss}</small>}
    </>
  );
}

function ControlToggle({ stageKey, control, on, open, disabled = false, identityReason, onClick }: {
  stageKey: string;
  control: HarnessControl;
  on: boolean;
  open: boolean;
  disabled?: boolean;
  identityReason?: StageIdentityReason | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-control={control.id}
      data-stage-key={stageKey}
      aria-pressed={on}
      aria-expanded={open}
      data-axis={control.axis}
      data-kind={control.kind}
      data-identity-reason={identityReason?.id}
      className={`wf-harness-control wf-harness-control-${on ? "on" : "off"}`}
      disabled={disabled || Boolean(identityReason)}
      onClick={onClick}
    >
      <ControlCopy control={control} on={on} />
    </button>
  );
}

function executorValue(
  stage: WfStage,
  patch: { executor?: WfStage["executor"]; model?: string },
): ControlValue {
  return {
    id: "executor",
    executor: "executor" in patch ? patch.executor : stage.executor,
    model: "model" in patch ? patch.model : stage.model,
  };
}

function bandPressed(band: Band): boolean | "mixed" {
  return band.mixed ? "mixed" : band.active > 0;
}

function CoverageCells({ covered, total }: { covered: number; total: number }) {
  return (
    <span className="wf-harness-coverage-cells" aria-hidden="true">
      {Array.from({ length: total }, (_, index) => (
        <span
          className="wf-harness-coverage-cell"
          data-coverage-cell={index < covered ? "on" : "off"}
          key={index}
        />
      ))}
    </span>
  );
}

function CoverageMeter({
  stages,
  allowVerifyCmd,
  verifyGate,
}: Pick<HarnessViewProps, "stages" | "allowVerifyCmd" | "verifyGate">) {
  const result = coverage(stages);
  return (
    <section
      className={`wf-harness-coverage wf-harness-coverage-${Math.min(result.covered, 3)}`}
      data-coverage={`${result.covered}/${result.total}`}
    >
      <strong>{result.covered} / {result.total}</strong>
      <CoverageCells covered={result.covered} total={result.total} />
      <p>{result.note}</p>
      {!allowVerifyCmd && <p>workflow global: los sensores deterministas sólo viven en el override por-repo</p>}
      {verifyGate === false && (
        <p className="wf-harness-gate-warning">
          <strong>El gate no está corriendo.</strong> {GATE_DISABLED_DETAIL}
        </p>
      )}
    </section>
  );
}

function ProseChip({ control }: { control: HarnessControl }) {
  return (
    <span
      className="wf-harness-instruction-chip"
      data-instruction-control={control.id}
      aria-disabled="true"
    >
      <span>{control.id}</span>
      <small>instrucción · {control.note}</small>
    </span>
  );
}

function ExecutorSummary({ stage, warning }: { stage: WfStage; warning?: string }) {
  const tone = stage.executor ?? "inherit";
  const initial = stage.executor ? EXECUTOR_INITIALS[stage.executor] : "·";
  const label = stage.executor
    ? `${stage.executor}${stage.model ? ` · ${stage.model}` : ""}`
    : "hereda del flujo";
  return (
    <span className="wf-harness-executor-summary">
      <span className={`ron-exec-badge ron-exec-badge-${tone}`}>{initial}</span>
      <span>{label}</span>
      {warning && <small>{warning}</small>}
    </span>
  );
}

function StageNode({ stage, executorWarning, gateOn }: {
  stage: WfStage;
  executorWarning?: string;
  gateOn: boolean;
}) {
  return (
    <div className="wf-harness-node">
      <span className="wf-harness-node-title"><span>{stage.icon}</span><span>{stage.label}</span></span>
      <ExecutorSummary stage={stage} warning={executorWarning} />
      {gateOn && <span className="wf-harness-gate-dot" aria-label="gate determinista activo" />}
    </div>
  );
}

function layoutVariables(verifierIndex: number): CSSProperties {
  return {
    "--wf-harness-node-width": `${NODE_W}px`,
    "--wf-harness-node-height": `${NODE_H}px`,
    "--wf-harness-gap": `${GAP_X}px`,
    "--wf-harness-row-y": `${ROW_Y}px`,
    "--wf-harness-verify-y": `${VERIFY_ROW_Y}px`,
    "--wf-harness-verify-x": `${Math.max(verifierIndex, 0) * (NODE_W + GAP_X)}px`,
  } as CSSProperties;
}

export function HarnessView({
  stages,
  verifyAfter,
  allowVerifyCmd,
  arming,
  verifyGate,
  onToggle,
  onEdit,
  onBandToggle,
}: HarnessViewProps) {
  const sectionBands = bands(stages, verifyAfter, allowVerifyCmd);
  const verifierIndex = stages.findIndex((stage) => stage.key === verifyAfter);
  const verifierStage = verifierIndex >= 0 ? stages[verifierIndex] : undefined;
  return (
    <div className="wf-harness">
      <aside className="wf-harness-rail">
        {sectionBands.map((band) => (
          <section className="wf-harness-band" key={band.id}>
            <button
              type="button"
              data-band={band.id}
              data-identity-reason={band.disabledReasonId}
              disabled={band.disabled}
              aria-pressed={bandPressed(band)}
              onClick={() => onBandToggle(band.id, band.active === 0)}
            >
              <span>{band.label}</span>
              <span>{band.active}/{band.total}</span>
            </button>
            <small>{band.note}</small>
            {band.disabledReason && <small>{band.disabledReason}</small>}
          </section>
        ))}
        <CoverageMeter stages={stages} allowVerifyCmd={allowVerifyCmd} verifyGate={verifyGate} />
        <ul className="wf-harness-legend" aria-label="Leyenda del harness">
          {LEGEND.map((entry) => (
            <li key={entry.id} data-legend={entry.id}>
              <span>{entry.label}</span>
              <small>{entry.hint}</small>
            </li>
          ))}
        </ul>
      </aside>
      <div
        className="wf-harness-loop"
        style={layoutVariables(verifierIndex)}
      >
      <div className="wf-harness-track">
      {stages.map((stage, index) => {
        const controls = stageControls(stage, verifyAfter, allowVerifyCmd);
        const identityReason = stageIdentityReason(stages, index);
        const stageDisabled = identityReason !== null;
        const instructionControl = controls.find((control) => control.id === "instruction")!;
        const executorControl = controls.find((control) => control.id === "executor")!;
        const verifyControl = controls.find((control) => control.id === "verifyCmd")!;
        const verifierControl = controls.find((control) => control.id === "verifier")!;
        const proseControls = controls.filter((control) => control.source === "instruction");
        const instructionOn = Boolean(stage.instruction?.trim());
        const instructionOpen = !stageDisabled && controlOpen(stage.key, "instruction", instructionOn, arming);
        const executorOn = stage.executor !== undefined;
        const executorOpen = !stageDisabled && controlOpen(stage.key, "executor", executorOn, arming);
        const verifyOn = verifyControl.on;
        const verifyOpen = !stageDisabled && !verifyControl.disabled && controlOpen(stage.key, "verifyCmd", verifyOn, arming);
        const verifierOn = verifyAfter === stage.key;
        return (
          <div className="wf-harness-stage-run" key={`${stage.key}-${index}`}>
          <div className="wf-harness-stage-column" data-harness-stage={stage.key}>
          <div className="wf-harness-controls" data-stage-key={stage.key}>
            <ControlToggle
              stageKey={stage.key}
              control={instructionControl}
              on={instructionOn}
              open={instructionOpen}
              identityReason={identityReason}
              onClick={() => onToggle(stage.key, "instruction", !instructionOn)}
            />
            {instructionOpen && (
              <div className="wf-harness-editor" data-editor="instruction">
                <textarea
                  autoFocus
                  value={stage.instruction ?? ""}
                  onChange={(event) => onEdit(stage.key, { id: "instruction", instruction: event.target.value })}
                />
              </div>
            )}
            <ControlToggle
              stageKey={stage.key}
              control={executorControl}
              on={executorOn}
              open={executorOpen}
              identityReason={identityReason}
              onClick={() => onToggle(stage.key, "executor", !executorOn)}
            />
            {executorOpen && (
              <div className="wf-harness-editor" data-editor="executor">
                <ExecutorPicker
                  executor={stage.executor}
                  model={stage.model}
                  datalistId={`ronin-harness-model-${stage.key}`}
                  onChange={(patch) => onEdit(stage.key, executorValue(stage, patch))}
                />
              </div>
            )}
            <ControlToggle
              stageKey={stage.key}
              control={verifyControl}
              on={verifyOn}
              open={verifyOpen}
              disabled={verifyControl.disabled}
              identityReason={identityReason}
              onClick={() => onToggle(stage.key, "verifyCmd", !verifyOn)}
            />
            {verifyControl.disabledReason && <small>{verifyControl.disabledReason}</small>}
            {verifyOpen && (
              <div className="wf-harness-editor" data-editor="verifyCmd">
                <input
                  data-verify-command=""
                  autoFocus
                  value={stage.verifyCmd ?? ""}
                  onChange={(event) => onEdit(stage.key, {
                    id: "verifyCmd",
                    verifyCmd: event.target.value,
                    maxRetries: stage.maxRetries ?? 2,
                  })}
                />
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={stage.maxRetries ?? 2}
                  onChange={(event) => onEdit(stage.key, {
                    id: "verifyCmd",
                    verifyCmd: stage.verifyCmd ?? "",
                    maxRetries: parseMaxRetriesInput(event.target.value),
                  })}
                />
              </div>
            )}
            <ControlToggle
              stageKey={stage.key}
              control={verifierControl}
              on={verifierOn}
              open={false}
              identityReason={identityReason}
              onClick={() => onToggle(stage.key, "verifier", !verifierOn)}
            />
            {proseControls.map((control) => (
              <ProseChip key={control.id} control={control} />
            ))}
            {identityReason && (
              <small className="wf-harness-identity-warning" data-identity-warning={identityReason.id}>
                {identityReason.label}
              </small>
            )}
          </div>
          <StageNode stage={stage} executorWarning={executorControl.warning} gateOn={verifyOn} />
          <span className="wf-harness-stage-key">{stage.key}</span>
          </div>
          {index < stages.length - 1 && (
            <span className="wf-harness-edge" data-harness-edge={`${stage.key}:${stages[index + 1].key}`} aria-hidden="true" />
          )}
          </div>
        );
      })}
      </div>
      {verifierStage && (
        <div className="wf-harness-verify-branch" data-verify-branch={verifierStage.key}>
          <div className="wf-harness-verify-node">
            <span><span>🔎</span><span>Verify</span></span>
            <small>verificador independiente</small>
          </div>
          <p>verifyAfter abre un verificador con contexto propio. Es una segunda opinión, no una comprobación: sigue siendo un modelo.</p>
        </div>
      )}
      </div>
    </div>
  );
}
