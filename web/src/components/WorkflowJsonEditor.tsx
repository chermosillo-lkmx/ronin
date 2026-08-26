import type { JsonError } from "./workflow-draft";

/** T14: raw JSON view of the draft — syntax errors show line/column; "aplicar" queda a cargo
 *  del padre (WorkflowEditorScreen), que deshabilita Guardar mientras jsonError no sea null. */
export function WorkflowJsonEditor({
  jsonText,
  jsonError,
  onChange,
}: {
  jsonText: string;
  jsonError: JsonError | null;
  onChange: (text: string) => void;
}) {
  return (
    <div className="wf-json-editor">
      <textarea
        className="wf-json-textarea"
        spellCheck={false}
        value={jsonText}
        onChange={(e) => onChange(e.target.value)}
        rows={20}
      />
      {jsonError && (
        <p className="ron-msg err wf-json-error">
          {jsonError.line !== undefined
            ? `línea ${jsonError.line}, columna ${jsonError.column}: ${jsonError.message}`
            : jsonError.path
              ? `campo "${jsonError.path}": ${jsonError.message}`
              : jsonError.message}
        </p>
      )}
    </div>
  );
}
