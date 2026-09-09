import type { WfStage } from "../types.js";

type StageExecutor = NonNullable<WfStage["executor"]>;

export const EXECUTOR_OPTIONS: Array<{ value: StageExecutor | undefined; name: string; initial: string; tone: string; hint: string }> = [
  { value: "claude", name: "claude", initial: "C", tone: "claude", hint: "opus · sonnet · haiku" },
  { value: "codex", name: "codex", initial: "X", tone: "codex", hint: "modelo libre" },
  { value: "agy", name: "agy", initial: "A", tone: "agy", hint: "modelo libre" },
  { value: undefined, name: "hereda", initial: "·", tone: "inherit", hint: "el del flujo" },
];

function executorCommandPreview(executor: StageExecutor | undefined, model: string): string {
  if (!executor) return "hereda del flujo";
  return executor === "codex" && model ? `codex --model ${model}` : executor;
}

export function ExecutorPicker({
  executor,
  model,
  datalistId,
  onChange,
}: {
  executor?: StageExecutor;
  model?: string;
  datalistId: string;
  onChange: (patch: { executor?: StageExecutor; model?: string }) => void;
}) {
  const modelValue = model ?? "";
  return (
    <section className="ron-exec-stage-picker" aria-label="Quién ejecuta esta etapa">
      <div className="ron-exec-stage-picker-title">
        <span>Quién ejecuta esta etapa</span>
        <small>se escribe solo en el prompt del worker</small>
      </div>
      <div className="ron-exec-tool-options">
        {EXECUTOR_OPTIONS.map((option) => (
          <button
            key={option.name}
            type="button"
            data-executor-option={option.name}
            className={`ron-exec-tool-option${executor === option.value ? " ron-exec-tool-option-selected" : ""}`}
            aria-pressed={executor === option.value}
            onClick={() => onChange(option.value ? { executor: option.value } : { executor: undefined, model: undefined })}
          >
            <span className={`ron-exec-badge ron-exec-badge-${option.tone}`}>{option.initial}</span>
            <span><b>{option.name}</b><small>{option.hint}</small></span>
          </button>
        ))}
      </div>
      <div className="ron-exec-model-command">
        <label>Modelo
          <input
            list={datalistId}
            value={modelValue}
            placeholder={executor === "claude" ? "opus, sonnet o haiku" : "se usará el modelo por defecto de la herramienta"}
            onChange={(event) => onChange({ model: event.target.value || undefined })}
          />
          <datalist id={datalistId}>
            {executor === "claude" && <>
              <option value="opus" />
              <option value="sonnet" />
              <option value="haiku" />
            </>}
          </datalist>
        </label>
        <div className="ron-exec-command"><span>Comando resultante</span><code>{executorCommandPreview(executor, modelValue)}</code></div>
      </div>
    </section>
  );
}
