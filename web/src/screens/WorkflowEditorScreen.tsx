import { useEffect, useState } from "react";
import {
  getRepoConfig,
  getRepos,
  getWorkflow,
  saveRepoConfig2,
  saveWorkflow,
  validateRepoWorkflow,
  validateWorkflow,
  WorkflowSaveError,
} from "../api";
import {
  adoptServerConfig,
  cancel as cancelDraft,
  createWorkflowDraft,
  setFieldError,
  setJsonText,
  setStages,
  switchView,
  type DraftView,
  type WorkflowDraftState,
} from "../components/workflow-draft";
import { StageEditor } from "../components/StageEditor";
import { WorkflowGraph } from "../components/WorkflowGraph";
import { WorkflowJsonEditor } from "../components/WorkflowJsonEditor";
import type { RepoOverrideConfig } from "../types";

type Target = { kind: "global" } | { kind: "repo"; repo: string };

const VIEWS: { key: DraftView; label: string }[] = [
  { key: "stepper", label: "Stepper" },
  { key: "graph", label: "Grafo" },
  { key: "json", label: "JSON" },
];

/**
 * T14/T15: the three synchronized views (Stepper/Grafo/JSON) over one workflow-draft state
 * machine. Global workflow → `PUT /api/workflow` (verifyCmd rejected, T11-85). A repo override
 * → `PUT /api/repo-config/:repo` (verifyCmd honored — gitignored). Live edits get a
 * per-field check via `/validate` (never persists); the real save re-validates server-side
 * and either adopts the returned normalized config or surfaces {path, code, message}.
 */
export function WorkflowEditorScreen() {
  const [repos, setRepos] = useState<string[]>([]);
  const [target, setTarget] = useState<Target>({ kind: "global" });
  const [draft, setDraft] = useState<WorkflowDraftState | null>(null);
  const [repoEntry, setRepoEntry] = useState<RepoOverrideConfig | null>(null);
  const [inheritWorkflow, setInheritWorkflow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    getRepos().then(setRepos);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSaveNote(null);
    if (target.kind === "global") {
      getWorkflow().then((cfg) => {
        if (!cancelled && cfg) setDraft(createWorkflowDraft(cfg));
      });
    } else {
      Promise.all([getRepoConfig(target.repo), getWorkflow()]).then(([entry, globalCfg]) => {
        if (cancelled) return;
        setRepoEntry(entry);
        setInheritWorkflow(!entry?.workflow);
        const cfg = entry?.workflow ?? globalCfg;
        if (cfg) setDraft(createWorkflowDraft(cfg));
      });
    }
    return () => {
      cancelled = true;
    };
    // sólo se recarga al cambiar de destino — un guardado exitoso adopta la respuesta in-place
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, target.kind === "repo" ? target.repo : null]);

  // Chequeo en vivo por campo (T14) — nunca persiste; sólo alimenta draft.fieldError.
  useEffect(() => {
    if (!draft || draft.jsonError) return;
    const cfg = { stages: draft.stages, verifyAfter: draft.verifyAfter };
    let cancelled = false;
    const check = target.kind === "global" ? validateWorkflow(cfg) : validateRepoWorkflow(target.repo, cfg);
    check.then((result) => {
      if (cancelled) return;
      setDraft((prev) => (prev ? setFieldError(prev, result.ok ? null : result.error) : prev));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.stages, draft?.verifyAfter, draft?.jsonError]);

  if (!draft) return <div className="nocturne ron-wf-editor">cargando…</div>;

  const allowVerifyCmd = target.kind === "repo" && !inheritWorkflow;
  const canSave = !draft.jsonError && !saving;

  async function onSave() {
    setSaving(true);
    setSaveNote(null);
    try {
      if (target.kind === "global") {
        const saved = await saveWorkflow({ stages: draft!.stages, verifyAfter: draft!.verifyAfter });
        setDraft((prev) => (prev ? adoptServerConfig(prev, saved) : prev));
      } else {
        const full = await saveRepoConfig2(target.repo, {
          workflow: inheritWorkflow ? null : { stages: draft!.stages, verifyAfter: draft!.verifyAfter },
          vars: repoEntry?.vars ?? {},
          startCommand: repoEntry?.startCommand ?? "",
          plannerModel: repoEntry?.plannerModel ?? "",
          workerModel: repoEntry?.workerModel ?? "",
          inheritWorkflow,
        });
        setRepoEntry(full);
        const saved = full.workflow ?? (await getWorkflow())!;
        setDraft((prev) => (prev ? adoptServerConfig(prev, saved) : prev));
      }
      setSaveNote({ kind: "ok", text: "workflow guardado" });
    } catch (e) {
      const err = e as WorkflowSaveError;
      if (err.code === "STAGE_IN_FLIGHT") {
        setSaveNote({ kind: "err", text: `hay un worker en curso en una etapa que este cambio tocaría: ${err.message}` });
      } else {
        setDraft((prev) => (prev ? setFieldError(prev, { path: err.path ?? "", code: err.code ?? "SAVE_FAILED", message: err.message }) : prev));
        setSaveNote({ kind: "err", text: err.message });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="nocturne ron-wf-editor">
      <div className="ron-wf-editor-head">
        <h2>Workflow</h2>
        <select
          className="wf-target-select"
          value={target.kind === "global" ? "__global__" : target.repo}
          onChange={(e) => setTarget(e.target.value === "__global__" ? { kind: "global" } : { kind: "repo", repo: e.target.value })}
        >
          <option value="__global__">Global (default)</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {target.kind === "repo" && (
          <label className="wf-inherit-check">
            <input type="checkbox" checked={inheritWorkflow} onChange={(e) => setInheritWorkflow(e.target.checked)} />
            heredar el workflow default (sin override propio)
          </label>
        )}
      </div>

      <div className="wf-view-tabs">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            className={`n-btn n-btn-secondary${draft.view === v.key ? " wf-view-tab-active" : ""}`}
            onClick={() => setDraft(switchView(draft, v.key))}
          >
            {v.label}
          </button>
        ))}
      </div>

      {!inheritWorkflow && draft.view === "stepper" && (
        <StageEditor
          stages={draft.stages}
          verifyAfter={draft.verifyAfter}
          onStages={(next) => setDraft(setStages(draft, next, draft.verifyAfter))}
          onVerifyAfter={(va) => setDraft(setStages(draft, draft.stages, va))}
          allowVerifyCmd={allowVerifyCmd}
        />
      )}
      {!inheritWorkflow && draft.view === "graph" && <WorkflowGraph stages={draft.stages} verifyAfter={draft.verifyAfter} />}
      {!inheritWorkflow && draft.view === "json" && (
        <WorkflowJsonEditor jsonText={draft.jsonText} jsonError={draft.jsonError} onChange={(text) => setDraft(setJsonText(draft, text))} />
      )}
      {inheritWorkflow && <p className="ron-pf-note">este repo hereda el workflow global — desmarca "heredar" para editar su propio override.</p>}

      {draft.fieldError && (
        <p className="ron-msg err wf-field-error">
          {draft.fieldError.path && <code>{draft.fieldError.path}</code>} {draft.fieldError.message}
        </p>
      )}
      {saveNote && <p className={`ron-msg ${saveNote.kind === "err" ? "err" : "ok"}`}>{saveNote.text}</p>}

      <div className="wf-editor-actions">
        <button className="n-btn n-btn-secondary" onClick={() => setDraft(cancelDraft(draft))} disabled={saving}>
          Cancelar
        </button>
        <button className="n-btn n-btn-primary" onClick={onSave} disabled={!canSave}>
          {saving ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  );
}
