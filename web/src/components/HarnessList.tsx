import type { WfStage } from "../types";
import { ExecutorPicker } from "./ExecutorPicker";
import {
  bands,
  coverage,
  instructionControls,
  parseMaxRetriesInput,
  stageControls,
  type BandId,
  type ControlId,
  type ControlValue,
} from "./harness-controls";

export interface HarnessListProps {
  stages: WfStage[];
  verifyAfter: string[];
  allowVerifyCmd: boolean;
  verifyGate: boolean | null;
  arming: { stageKey: string; id: ControlId } | null;
  openStage: string | null;
  onOpenStage: (stageKey: string | null) => void;
  onToggle: (stageKey: string, id: ControlId, on: boolean) => void;
  onEdit: (stageKey: string, value: ControlValue) => void;
  onBandToggle: (band: BandId, on: boolean) => void;
}

function executorLabel(stage: WfStage): string {
  if (!stage.executor) return "hereda del flujo";
  if (stage.executor === "claude" && !stage.model) return "claude · sin modelo = hereda";
  return `${stage.executor}${stage.model ? ` · ${stage.model}` : ""}`;
}

function retriesLabel(value: number | undefined): string {
  const retries = value ?? 2;
  return `${retries} ${retries === 1 ? "reintento" : "reintentos"}`;
}

function SwitchButton({
  stageKey,
  id,
  on,
  disabled = false,
  title,
  onToggle,
}: {
  stageKey: string;
  id: ControlId;
  on: boolean;
  disabled?: boolean;
  title?: string;
  onToggle: HarnessListProps["onToggle"];
}) {
  return (
    <button
      type="button"
      data-control={id}
      data-stage-key={stageKey}
      aria-pressed={on}
      className={`wf-harness-v2-switch ${on ? "on" : "off"}`}
      disabled={disabled}
      title={title}
      aria-label={`${on ? "Apagar" : "Encender"} ${id}`}
      onClick={(event) => { event.stopPropagation(); onToggle(stageKey, id, !on); }}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function InstructionSummary({ stage, on }: { stage: WfStage; on: boolean }) {
  const described = instructionControls(stage.instruction ?? "").map(({ id }) => id);
  return (
    <button
      type="button"
      data-control="instruction"
      data-stage-key={stage.key}
      aria-pressed={on}
      className="wf-harness-v2-instruction"
    >
      <span>{stage.instruction?.trim() || "sin instrucción"}</span>
      <small>{described.length ? `pide ${described.join(" · ")}` : "sin evidencia descrita"}</small>
    </button>
  );
}

function StageDetail({ stage, props }: { stage: WfStage; props: HarnessListProps }) {
  const controls = stageControls(stage, props.verifyAfter, props.allowVerifyCmd);
  const state = (id: ControlId) => controls.find((control) => control.id === id)?.on ?? false;
  const retries = stage.maxRetries ?? 2;
  const editGate = (verifyCmd: string, maxRetries = stage.maxRetries) =>
    props.onEdit(stage.key, { id: "verifyCmd", verifyCmd, maxRetries });

  return (
    <div className="wf-harness-v2-detail" data-stage-detail={stage.key} onClick={(event) => event.stopPropagation()}>
      <section>
        <header><span>Ejecutor · modelo</span><SwitchButton stageKey={stage.key} id="executor" on={state("executor")} onToggle={props.onToggle} /></header>
        <ExecutorPicker
          executor={stage.executor}
          model={stage.model}
          datalistId={`wf-harness-v2-model-${stage.key}`}
          onChange={(patch) => props.onEdit(stage.key, { id: "executor", ...patch })}
        />
      </section>
      <section>
        <header><span>Instrucción</span><SwitchButton stageKey={stage.key} id="instruction" on={state("instruction")} onToggle={props.onToggle} /></header>
        <textarea
          aria-label={`Instrucción de ${stage.label}`}
          value={stage.instruction ?? ""}
          placeholder="Qué debe hacer esta etapa"
          onChange={(event) => props.onEdit(stage.key, { id: "instruction", instruction: event.target.value })}
        />
      </section>
      <section>
        <header>
          <span>Gate por comando</span>
          <SwitchButton
            stageKey={stage.key}
            id="verifyCmd"
            on={state("verifyCmd")}
            disabled={!props.allowVerifyCmd}
            title={!props.allowVerifyCmd ? "sólo en el override por-repo, que está en el gitignore" : undefined}
            onToggle={props.onToggle}
          />
        </header>
        <label>Comando · exit 0 = pasa
          <input
            value={stage.verifyCmd ?? ""}
            disabled={!props.allowVerifyCmd}
            onChange={(event) => editGate(event.target.value)}
          />
        </label>
        <div className="wf-harness-v2-retries" data-retries-stepper={stage.key}>
          <span>Reintentos</span>
          <div>
            <button type="button" disabled={!props.allowVerifyCmd} onClick={() => editGate(stage.verifyCmd ?? "", Math.max(0, retries - 1))}>−</button>
            <input
              aria-label={`Reintentos de ${stage.label}`}
              type="number"
              min={0}
              max={10}
              value={retries}
              disabled={!props.allowVerifyCmd}
              onChange={(event) => editGate(stage.verifyCmd ?? "", parseMaxRetriesInput(event.target.value))}
            />
            <button type="button" disabled={!props.allowVerifyCmd} onClick={() => editGate(stage.verifyCmd ?? "", Math.min(10, retries + 1))}>+</button>
          </div>
        </div>
        <small>Corre en el worktree de la sesión cuando el worker marca la etapa.</small>
      </section>
      <section>
        <header><span>Revisión por modelo</span><SwitchButton stageKey={stage.key} id="verifier" on={state("verifier")} onToggle={props.onToggle} /></header>
        <p>Al terminar esta etapa, un modelo independiente da una segunda opinión.</p>
        <small>Es una opinión, no una comprobación: no cuenta en el medidor.</small>
      </section>
    </div>
  );
}

export function HarnessList(props: HarnessListProps) {
  const meter = coverage(props.stages);
  const railBands = bands(props.stages, props.verifyAfter, props.allowVerifyCmd);
  return (
    <div className="wf-harness-v2">
      <aside className="wf-harness-v2-rail">
        <section className="wf-harness-v2-meter" data-coverage={`${meter.covered}/${meter.total}`}>
          <header><span>Harness</span>{props.verifyGate === true && <em>gate corriendo</em>}</header>
          <strong>{meter.covered} / {meter.total}</strong>
          <div className="wf-harness-v2-meter-cells" aria-hidden="true">
            {props.stages.map((stage) => <span key={stage.key} className={stage.verifyCmd?.trim() ? "on" : "off"} />)}
          </div>
          <p>{meter.note}</p>
          {props.verifyGate === false && <p className="wf-harness-v2-warning">El gate no está corriendo</p>}
        </section>
        <section className="wf-harness-v2-bands">
          {railBands.map((band) => (
            <button
              type="button"
              key={band.id}
              data-band={band.id}
              aria-pressed={band.active > 0}
              disabled={band.disabled}
              title={band.disabledReason}
              onClick={() => props.onBandToggle(band.id, band.active === 0)}
            >
              <span className={`wf-harness-v2-switch ${band.active > 0 ? "on" : "off"}`} aria-hidden="true"><span /></span>
              <span><b>{band.label}</b><small>{band.note}</small></span>
              <code>{band.active}/{band.total}</code>
            </button>
          ))}
          <p>El interruptor cambia el control en todas las etapas; el texto guardado se conserva.</p>
        </section>
        <section className="wf-harness-v2-legend">
          <span><i className="gate" />Gate <small>exit code manda</small></span>
          <span><i className="verifier" />Verifier <small>un modelo opina</small></span>
          <span><i className="off" />Apagado <small>hereda del flujo</small></span>
        </section>
      </aside>
      <div className="wf-harness-rows">
        <div className="wf-harness-v2-head" aria-hidden="true">
          <span>Etapa</span><span>Ejecutor · modelo</span><span>Instrucción</span><span>Gate por comando</span><span>Revisión</span>
        </div>
        {props.stages.map((stage) => {
          const stageState = stageControls(stage, props.verifyAfter, props.allowVerifyCmd);
          const instruction = stageState.find(({ id }) => id === "instruction")!;
          const executor = stageState.find(({ id }) => id === "executor")!;
          const gate = stageState.find(({ id }) => id === "verifyCmd")!;
          const verifier = stageState.find(({ id }) => id === "verifier")!;
          const open = props.openStage === stage.key || props.arming?.stageKey === stage.key;
          return (
            <article
              key={stage.key}
              className="wf-harness-row"
              data-stage-key={stage.key}
              data-open={open || undefined}
              onClick={() => props.onOpenStage(open ? null : stage.key)}
            >
              <div className="wf-harness-v2-summary">
                <div className="wf-harness-v2-stage"><span>{stage.icon}</span><span><b>{stage.label}</b><code>{stage.key}{stage.role === "impl" ? " · impl" : ""}</code></span></div>
                <button type="button" data-control="executor" data-stage-key={stage.key} aria-pressed={executor.on} data-executor={stage.executor ?? "inherit"} className={`wf-harness-v2-executor${stage.executor === "claude" && !stage.model ? " warning" : ""}`}>
                  <span>{stage.executor === "codex" ? "X" : stage.executor === "agy" ? "A" : stage.executor === "claude" ? "C" : "·"}</span>
                  <span>{executorLabel(stage)}</span>
                </button>
                <InstructionSummary stage={stage} on={instruction.on} />
                <div className="wf-harness-v2-gate">
                  <SwitchButton stageKey={stage.key} id="verifyCmd" on={gate.on} disabled={gate.disabled} title={gate.disabledReason} onToggle={props.onToggle} />
                  <span>{stage.verifyCmd?.trim() ? <><code>{stage.verifyCmd}</code><small>{retriesLabel(stage.maxRetries)}</small></> : <small>{gate.disabledReason ?? "sin gate · avanza por autoreporte"}</small>}</span>
                </div>
                <div className="wf-harness-v2-verifier">
                  <SwitchButton stageKey={stage.key} id="verifier" on={verifier.on} onToggle={props.onToggle} />
                  <span>{verifier.on ? "sí" : "no"}</span>
                </div>
              </div>
              {open && <StageDetail stage={stage} props={props} />}
            </article>
          );
        })}
      </div>
    </div>
  );
}
