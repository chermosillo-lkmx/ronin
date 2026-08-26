import type { WfStage } from "../types.js";

export const EMOJI_CHOICES = ["📋", "⌨️", "🌐", "🔎", "✓", "💬", "🔒", "🧪", "🧹", "📦", "🚀", "🛠️", "🔥", "📝", "⚙️", "⚡"];

/** Controlled stage editor (etapas + verificador). Reused by the global workflow and per-repo overrides. */
export function StageEditor({
  stages,
  verifyAfter,
  onStages,
  onVerifyAfter,
  allowVerifyCmd = false,
}: {
  stages: WfStage[];
  verifyAfter: string | null;
  onStages: (next: WfStage[]) => void;
  onVerifyAfter: (va: string | null) => void;
  allowVerifyCmd?: boolean; // verifyCmd sólo tiene efecto en el override por-repo (gitignored)
}) {
  function patch(i: number, p: Partial<WfStage>) {
    onStages(stages.map((s, idx) => (idx === i ? { ...s, ...p } : s)));
  }
  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= stages.length) return;
    const next = [...stages];
    [next[i], next[j]] = [next[j], next[i]];
    onStages(next);
  }
  function remove(i: number) {
    onStages(stages.filter((_, idx) => idx !== i));
  }
  function add() {
    onStages([...stages, { key: "", label: "Nueva etapa", icon: "•", instruction: "" }]);
  }

  return (
    <>
      <div className="wf-editor">
        {stages.map((s, i) => (
          <div key={i} className="wf-row">
            <div className="wf-move">
              <button className="btn move" onClick={() => move(i, -1)} disabled={i === 0}>▲</button>
              <button className="btn move" onClick={() => move(i, 1)} disabled={i === stages.length - 1}>▼</button>
            </div>
            <select className="wf-icon" value={s.icon} onChange={(e) => patch(i, { icon: e.target.value })}>
              {!EMOJI_CHOICES.includes(s.icon) && <option value={s.icon}>{s.icon}</option>}
              {EMOJI_CHOICES.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <div className="wf-fields">
              <div className="wf-line">
                <input className="wf-key" placeholder="key (ej. security)" value={s.key} onChange={(e) => patch(i, { key: e.target.value })} />
                <input className="wf-label" placeholder="label" value={s.label} onChange={(e) => patch(i, { label: e.target.value })} />
                <button className="btn stop" onClick={() => remove(i)} title="eliminar etapa">✕</button>
              </div>
              <textarea
                className="wf-instr"
                placeholder="instrucción para el worker (ej. Usa el skill /security-review; guarda hallazgos en {ev}/security.md.)"
                value={s.instruction ?? ""}
                onChange={(e) => patch(i, { instruction: e.target.value })}
              />
              <div className="wf-line">
                <input
                  className="wf-label"
                  placeholder={allowVerifyCmd ? "verifyCmd (exit 0 = pass; ⚠️ ejecuta shell)" : "verifyCmd — sólo por-repo (ejecuta shell)"}
                  value={s.verifyCmd ?? ""}
                  disabled={!allowVerifyCmd}
                  title={allowVerifyCmd ? "Comando shell que corre en el cwd del worker; exit 0 avanza, ≠0 reintenta" : "Sólo editable en el override por-repo (gitignored). En el workflow global se ignora."}
                  onChange={(e) => patch(i, { verifyCmd: e.target.value })}
                />
                <input
                  className="wf-key"
                  type="number"
                  min={0}
                  max={10}
                  placeholder="reintentos (2)"
                  value={s.maxRetries ?? ""}
                  disabled={!allowVerifyCmd || !s.verifyCmd}
                  onChange={(e) => patch(i, { maxRetries: e.target.value === "" ? undefined : Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        ))}
        <button className="btn add-stage" onClick={add}>＋ agregar etapa</button>
      </div>

      <div className="wf-verify">
        <span>🔎 Verificador independiente tras la etapa:</span>
        <select value={verifyAfter ?? ""} onChange={(e) => onVerifyAfter(e.target.value || null)}>
          <option value="">(ninguno)</option>
          {stages.filter((s) => s.key).map((s) => (
            <option key={s.key} value={s.key}>{s.icon} {s.label}</option>
          ))}
        </select>
      </div>
    </>
  );
}
