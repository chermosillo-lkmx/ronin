import { useEffect, useRef } from "react";
import type { WfStage } from "../types.js";
import { EMOJI_CHOICES } from "./StageEditor.js";

/** Full-height editor for the stage selected from an editable workflow graph. */
export function StageModal({
  stage,
  allowVerifyCmd,
  onChange,
  onClose,
  onDelete,
}: {
  stage: WfStage;
  allowVerifyCmd: boolean;
  onChange: (patch: Partial<WfStage>) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const labelRef = useRef<HTMLInputElement>(null);

  // Dos efectos separados a propósito. `onClose` llega como flecha inline desde
  // WorkflowWorkspace, así que cambia de identidad en cada render: si el enfoque inicial cuelga de
  // esa dependencia, cada tecla en la instrucción re-ejecuta el efecto y devuelve el foco al campo
  // Nombre. El listener de Escape sí necesita el `onClose` vigente; el enfoque, sólo el montaje.
  useEffect(() => {
    labelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="ronin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ronin-stage-modal" role="dialog" aria-modal="true" aria-label={`Editar etapa ${stage.label}`}>
        <header>
          <h2>Editar etapa</h2>
          <button className="ronin-icon-button" onClick={onClose} aria-label="Cerrar editor de etapa">×</button>
        </header>
        <div className="ronin-stage-modal-form">
          <label>Icono
            <select value={stage.icon} onChange={(event) => onChange({ icon: event.target.value })}>
              {!EMOJI_CHOICES.includes(stage.icon) && <option value={stage.icon}>{stage.icon}</option>}
              {EMOJI_CHOICES.map((emoji) => <option key={emoji} value={emoji}>{emoji}</option>)}
            </select>
          </label>
          <label>Key
            <input className="ronin-stage-modal-key" value={stage.key} placeholder="key (ej. security)" onChange={(event) => onChange({ key: event.target.value })} />
          </label>
          <label>Nombre
            <input ref={labelRef} value={stage.label} placeholder="label" onChange={(event) => onChange({ label: event.target.value })} />
          </label>
          <label className="ronin-stage-modal-instruction-label">Instrucción
            <textarea
              className="ronin-stage-modal-instruction"
              placeholder="instrucción para el worker (ej. Usa el skill /security-review; guarda hallazgos en {ev}/security.md.)"
              value={stage.instruction ?? ""}
              onChange={(event) => onChange({ instruction: event.target.value })}
            />
          </label>
          <div className="ronin-stage-modal-verify">
            <label>verifyCmd
              <input
                placeholder={allowVerifyCmd ? "verifyCmd (exit 0 = pass; ⚠️ ejecuta shell)" : "verifyCmd — sólo por-repo (ejecuta shell)"}
                value={stage.verifyCmd ?? ""}
                disabled={!allowVerifyCmd}
                title={allowVerifyCmd ? "Comando shell que corre en el cwd del worker; exit 0 avanza, ≠0 reintenta" : "Sólo editable en el override por-repo (gitignored). En el workflow global se ignora."}
                onChange={(event) => onChange({ verifyCmd: event.target.value })}
              />
            </label>
            <label>Reintentos
              <input
                className="ronin-stage-modal-key"
                type="number"
                min={0}
                max={10}
                placeholder="reintentos (2)"
                value={stage.maxRetries ?? ""}
                disabled={!allowVerifyCmd || !stage.verifyCmd}
                onChange={(event) => onChange({ maxRetries: event.target.value === "" ? undefined : Number(event.target.value) })}
              />
            </label>
          </div>
        </div>
        <footer>
          <button onClick={onDelete}>Eliminar etapa</button>
          <span />
          <button onClick={onClose}>Cerrar</button>
        </footer>
      </section>
    </div>
  );
}
