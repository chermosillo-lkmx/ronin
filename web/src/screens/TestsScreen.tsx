import { useEffect, useRef, useState } from "react";
import { cancelTestRun, getTestsConfig, getTestsMatrix, getTestsRuns, retryTestRun, saveTestsConfig, startTests } from "../api";
import type { TestCoverage, TestMatrixCell, TestMatrixRow, TestRepoConfig, TestRun, TestSuite, TestSuiteConfig, TestTotals } from "../types";

/**
 * Superficie Pruebas (test harness). Matriz repo × suite construida SÓLO con lo que el server
 * persistió: una celda sin configurar dice "sin configurar", la cobertura ausente dice
 * "no reportada" — nunca un 0% inventado. El renderer manda identificadores (repo/perfil/
 * suite/runId); el texto ejecutable sólo existe en el formulario de configuración, que el
 * server valida como `program + args`.
 */

export interface TestsScreenData {
  matrix: TestMatrixRow[];
  config: TestRepoConfig[];
  runs: TestRun[];
}

export interface TestsScreenProps {
  /** Datos iniciales (tests/SSR). Sin `initial` la pantalla carga del server y pollea si hay corridas vivas. */
  initial?: TestsScreenData;
  selectedRepo?: string;
  selectedRunId?: string;
}

const SUITES: { key: TestSuite; label: string }[] = [
  { key: "unit", label: "Unit" },
  { key: "e2e", label: "E2E" },
  { key: "api", label: "API/OpenAPI" },
  { key: "browser", label: "Browser" },
];
const COMMAND_SUITES: TestSuite[] = ["unit", "e2e", "browser"];

const STATE_LABEL: Record<string, string> = {
  unconfigured: "sin configurar",
  never_run: "sin correr",
  queued: "en cola",
  running: "corriendo…",
  passed: "ok",
  failed: "falló",
  error: "error",
  timeout: "timeout",
  cancelled: "cancelada",
  blocked: "bloqueada",
};

function stateTone(state: string): "ok" | "warn" | "fail" | "muted" {
  if (state === "passed") return "ok";
  if (state === "failed" || state === "error" || state === "timeout") return "fail";
  if (state === "blocked" || state === "cancelled" || state === "queued" || state === "running") return "warn";
  return "muted";
}

function fmtTotals(t?: TestTotals): string {
  if (!t) return "";
  return `${t.passed}/${t.total}${t.failed ? ` · ${t.failed} fail` : ""}${t.errors ? ` · ${t.errors} err` : ""}${t.skipped ? ` · ${t.skipped} skip` : ""}`;
}

function fmtCoverage(c?: TestCoverage): string {
  if (!c || c.status === "not_applicable") return "";
  if (c.status === "reported") return `cob. ${c.lines}%${c.branches !== undefined ? ` · ramas ${c.branches}%` : ""}`;
  if (c.status === "invalid") return "cob. inválida";
  return "cob. no reportada";
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 100) / 10} s`;
}

export function TestsScreen({ initial, selectedRepo: initialRepo, selectedRunId: initialRunId }: TestsScreenProps) {
  const [matrix, setMatrix] = useState<TestMatrixRow[]>(initial?.matrix ?? []);
  const [config, setConfig] = useState<TestRepoConfig[]>(initial?.config ?? []);
  const [runs, setRuns] = useState<TestRun[]>(initial?.runs ?? []);
  const [profile, setProfile] = useState(() => initial?.matrix.flatMap((r) => r.profiles)[0] ?? "dev");
  const [selectedRepo, setSelectedRepo] = useState<string | null>(initialRepo ?? null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [down, setDown] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const load = async () => {
    const [m, c, r] = await Promise.all([getTestsMatrix(), getTestsConfig(), getTestsRuns({ limit: 100 })]);
    if (m === null || c === null) {
      setDown(true);
      return;
    }
    setDown(false);
    setMatrix(m);
    setConfig(c);
    setRuns(r);
    setProfile((p) => p || m.flatMap((row) => row.profiles)[0] || "dev");
  };

  useEffect(() => {
    if (initial) return;
    let alive = true;
    // setTimeout recursivo (mismo patrón que SessionsScreen): un poll lento nunca se solapa.
    // Se pollea sólo mientras haya corridas vivas; si no, cada 15 s para recoger corridas del CLI.
    const tick = async () => {
      await load();
      if (!alive) return;
      timer.current = window.setTimeout(tick, runs.some((r) => r.status === "queued" || r.status === "running") ? 2000 : 15000);
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.some((r) => r.status === "queued" || r.status === "running")]);

  const act = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: "ok", text: okText });
      await load();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const allProfiles = [...new Set(matrix.flatMap((r) => r.profiles))].sort();
  const selectedRun = selectedRunId ? runs.find((r) => r.runId === selectedRunId) ?? null : null;
  const repoConfig = selectedRepo ? config.find((c) => c.repo === selectedRepo) ?? { repo: selectedRepo, configured: false, profiles: [], suites: {} } : null;
  const visibleRuns = selectedRepo ? runs.filter((r) => r.repo === selectedRepo) : runs;

  return (
    <div className="nocturne ron-tests">
      <header className="ron-tests-head">
        <div>
          <h2 className="ron-pf-title">Pruebas</h2>
          <p className="ron-pf-sub">Unit + cobertura por repo · resultados reales, persistidos</p>
        </div>
        <span className="ron-pf-spacer" />
        <label className="ron-tests-profile">
          perfil
          <input list="ron-tests-profiles" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="dev" />
          <datalist id="ron-tests-profiles">{allProfiles.map((p) => <option key={p} value={p} />)}</datalist>
        </label>
        <button className="n-btn n-btn-primary" disabled={busy || !profile} onClick={() => act(() => startTests({ kind: "all", profile }), "lote encolado")}>▷ Correr todo</button>
        <button className="n-btn n-btn-secondary" disabled={busy || !profile} onClick={() => act(() => startTests({ kind: "failed", profile }), "reintentando fallidas")}>↻ Correr fallidas</button>
        <button className="n-btn n-btn-ghost" disabled={busy} onClick={() => void load()}>Refrescar</button>
      </header>

      {down && <p className="ron-msg err">No se pudo consultar el test harness. ¿Está el server arriba?</p>}
      {msg && <p className={`ron-msg ${msg.kind}`}>{msg.text}</p>}

      <div className="card elev-sm ron-tests-matrix-card">
        <table className="table ron-tests-matrix">
          <thead>
            <tr>
              <th>Repo</th>
              {SUITES.map((s) => <th key={s.key}>{s.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {matrix.length === 0 && (
              <tr><td colSpan={5} className="ron-empty-cell">Sin repos. Agrega uno en ⚙ Configuración → Repos.</td></tr>
            )}
            {matrix.map((row) => (
              <tr key={row.repo} className={selectedRepo === row.repo ? "ron-tests-row-selected" : ""}>
                <td>
                  <button className="ron-tests-repo" onClick={() => { setSelectedRepo(row.repo); setSelectedRunId(null); }}>
                    <strong>{row.repo}</strong>
                    <small>{row.configured ? row.profiles.join(", ") || "sin perfiles" : "sin configurar"}</small>
                  </button>
                </td>
                {SUITES.map((s) => (
                  <td key={s.key}>
                    <MatrixCellView
                      cell={row.cells[s.key]}
                      canRun={row.configured && COMMAND_SUITES.includes(s.key) && row.cells[s.key].state !== "unconfigured" && Boolean(profile)}
                      busy={busy}
                      onOpen={() => { setSelectedRepo(row.repo); setSelectedRunId(row.cells[s.key].runId ?? null); }}
                      onRun={() => act(() => startTests({ kind: "suites", repo: row.repo, profile, suites: [s.key] }), `${row.repo} · ${s.label} encolada`)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="ron-tests-lower">
        <section className="card elev-sm ron-tests-history">
          <div className="ron-tests-section-head">
            <strong>Historial{selectedRepo ? ` · ${selectedRepo}` : ""}</strong>
            {selectedRepo && <button className="n-btn n-btn-ghost" onClick={() => { setSelectedRepo(null); setSelectedRunId(null); }}>todos</button>}
          </div>
          {visibleRuns.length === 0 && <p className="ron-note">Sin corridas todavía.</p>}
          <ul className="ron-tests-runs">
            {visibleRuns.map((r) => (
              <li key={r.runId}>
                <button className={`ron-tests-run ${selectedRunId === r.runId ? "selected" : ""}`} onClick={() => { setSelectedRunId(r.runId); setSelectedRepo(r.repo); }}>
                  <span className={`ron-dot ${stateTone(r.status)}`} />
                  <span className="ron-tests-run-name">{r.repo} · {r.suite}</span>
                  <span className="ron-tests-run-meta">{STATE_LABEL[r.status]} · {fmtTotals(r.totals)} {fmtCoverage(r.coverage)}</span>
                  <span className="ron-tests-run-time">{new Date(r.createdAt).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="card elev-sm ron-tests-detail">
          {selectedRun ? (
            <RunDetail run={selectedRun} busy={busy} onCancel={() => act(() => cancelTestRun(selectedRun.runId), "cancelación enviada")} onRetry={() => act(() => retryTestRun(selectedRun.runId), "reintento encolado")} />
          ) : repoConfig ? (
            <RepoConfigForm key={repoConfig.repo} config={repoConfig} busy={busy} onSave={(input) => act(() => saveTestsConfig(repoConfig.repo, input), `configuración de ${repoConfig.repo} guardada`)} />
          ) : (
            <p className="ron-note">Selecciona un repo para configurar sus pruebas, o una corrida para ver su detalle.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function MatrixCellView({ cell, canRun, busy, onOpen, onRun }: { cell: TestMatrixCell; canRun: boolean; busy: boolean; onOpen: () => void; onRun: () => void }) {
  const tone = stateTone(cell.state);
  return (
    <div className="ron-tests-cell">
      <button className="ron-tests-cell-main" onClick={onOpen} title={cell.reason ?? ""}>
        <span className={`ron-dot ${tone}`} />
        <span className={`ron-tests-cell-state ${tone}`}>{STATE_LABEL[cell.state] ?? cell.state}</span>
        {cell.totals && <span className="ron-tests-cell-meta">{fmtTotals(cell.totals)}</span>}
        {cell.coverage && cell.coverage.status !== "not_applicable" && <span className="ron-tests-cell-meta">{fmtCoverage(cell.coverage)}</span>}
        {cell.durationMs !== undefined && <span className="ron-tests-cell-meta">{fmtDuration(cell.durationMs)}</span>}
        {cell.reason && <span className="ron-tests-cell-reason">{cell.reason}</span>}
      </button>
      {canRun && <button className="n-btn n-btn-ghost n-btn-icon" disabled={busy} title="correr esta suite" onClick={onRun}>▷</button>}
    </div>
  );
}

function RunDetail({ run, busy, onCancel, onRetry }: { run: TestRun; busy: boolean; onCancel: () => void; onRetry: () => void }) {
  const live = run.status === "queued" || run.status === "running";
  return (
    <div className="ron-tests-run-detail">
      <div className="ron-tests-section-head">
        <span className={`ron-dot ${stateTone(run.status)}`} />
        <strong>{run.repo} · {run.suite} · {STATE_LABEL[run.status]}</strong>
        <span className="ron-pf-spacer" />
        {live ? (
          <button className="n-btn n-btn-danger" disabled={busy} onClick={onCancel}>Cancelar</button>
        ) : (
          <button className="n-btn n-btn-secondary" disabled={busy} onClick={onRetry}>Reintentar</button>
        )}
      </div>
      <dl className="ron-tests-meta">
        <dt>run</dt><dd className="ron-mono">{run.runId}{run.batchId ? ` · lote ${run.batchId}` : ""}</dd>
        <dt>perfil</dt><dd>{run.profile}</dd>
        {run.command && <><dt>comando</dt><dd className="ron-mono">{[run.command.program, ...run.command.args].join(" ")}</dd></>}
        {run.cwd && <><dt>cwd</dt><dd className="ron-mono">{run.cwd}</dd></>}
        <dt>resultado</dt>
        <dd>{run.totals ? fmtTotals(run.totals) : run.totalsReason ?? "—"}{run.exitCode !== undefined && run.exitCode !== null ? ` · exit ${run.exitCode}` : ""}</dd>
        <dt>cobertura</dt>
        <dd>{run.coverage?.status === "reported" ? fmtCoverage(run.coverage) : run.coverage?.status === "not_applicable" ? "no aplica" : `${fmtCoverage(run.coverage) || "no reportada"}${run.coverage?.reason ? ` (${run.coverage.reason})` : ""}`}</dd>
        {run.reason && <><dt>motivo</dt><dd>{run.reason}</dd></>}
        {run.startedAt && run.finishedAt && <><dt>duración</dt><dd>{fmtDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt))}</dd></>}
        {run.artifacts && run.artifacts.length > 0 && (
          <><dt>artefactos</dt><dd>{run.artifacts.map((a) => { const name = a.split("/").pop()!; return <a key={a} className="ron-tests-artifact" href={`/api/tests/runs/${encodeURIComponent(run.runId)}/artifacts/${encodeURIComponent(name)}`} target="_blank" rel="noreferrer">{name}</a>; })}</dd></>
        )}
      </dl>
      {run.failures && run.failures.length > 0 && (
        <div className="ron-tests-failures">
          <strong>Fallos ({run.failures.length})</strong>
          <ul>{run.failures.map((f, i) => <li key={i}><code>{f.classname ? `${f.classname}::` : ""}{f.name}</code> — {f.message || "(sin mensaje)"}</li>)}</ul>
        </div>
      )}
      {(run.stdout || run.stderr) && (
        <details className="ron-tests-output" open={run.status !== "passed"}>
          <summary>salida (redactada, acotada)</summary>
          {run.stdout && <pre>{run.stdout}</pre>}
          {run.stderr && <pre className="ron-tests-stderr">{run.stderr}</pre>}
        </details>
      )}
    </div>
  );
}

// ---- Formulario de configuración: la única superficie con texto ejecutable; el server lo valida. ----

interface ProfileDraft {
  name: string;
  /** Una línea por variable: `KEY=valor`. `KEY` sin `=` conserva el valor ya guardado en el server. */
  lines: string;
}

interface SuiteDraft {
  enabled: boolean;
  program: string;
  args: string;
  cwd: string;
  timeoutS: string;
  junitPath: string;
  coberturaPath: string;
  lcovPath: string;
}

const SUITE_HINTS: Record<TestSuite, { program: string; args: string; junit: string; cov: string }> = {
  unit: { program: ".venv/bin/pytest", args: "-q --junitxml=reports/junit.xml --cov=src --cov-report=xml:reports/coverage.xml", junit: "reports/junit.xml", cov: "reports/coverage.xml" },
  e2e: { program: "npx", args: "playwright test --reporter=junit", junit: "results.xml", cov: "" },
  api: { program: "", args: "", junit: "", cov: "" },
  browser: { program: "npx", args: "playwright test --reporter=junit", junit: "results.xml", cov: "" },
};

/** Split tipo shell mínimo (comillas simples/dobles) para que `-k "a and b"` sea UN arg. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

function suiteDraft(cfg?: TestSuiteConfig): SuiteDraft {
  return {
    enabled: Boolean(cfg),
    program: cfg?.command.program ?? "",
    args: cfg ? cfg.command.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : "",
    cwd: cfg?.cwd ?? "",
    timeoutS: String(Math.round((cfg?.timeoutMs ?? 600000) / 1000)),
    junitPath: cfg?.junitPath ?? "",
    coberturaPath: cfg?.coberturaPath ?? "",
    lcovPath: cfg?.lcovPath ?? "",
  };
}

function RepoConfigForm({ config, busy, onSave }: { config: TestRepoConfig; busy: boolean; onSave: (input: unknown) => void }) {
  const [profiles, setProfiles] = useState<ProfileDraft[]>(() =>
    config.profiles.length ? config.profiles.map((p) => ({ name: p.name, lines: p.variables.join("\n") })) : [{ name: "dev", lines: "" }]
  );
  const [suites, setSuites] = useState<Record<TestSuite, SuiteDraft>>(() => ({
    unit: suiteDraft(config.suites.unit),
    e2e: suiteDraft(config.suites.e2e),
    api: suiteDraft(config.suites.api),
    browser: suiteDraft(config.suites.browser),
  }));
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const outProfiles = profiles
      .filter((p) => p.name.trim())
      .map((p) => {
        const variables: Record<string, string | null> = {};
        for (const raw of p.lines.split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          const eq = line.indexOf("=");
          if (eq < 0) variables[line] = null; // conservar valor guardado
          else variables[line.slice(0, eq).trim()] = line.slice(eq + 1);
        }
        return { name: p.name.trim(), variables };
      });
    const outSuites: Record<string, unknown> = {};
    for (const key of COMMAND_SUITES) {
      const d = suites[key];
      if (!d.enabled) continue;
      const timeoutS = Number(d.timeoutS);
      if (!d.program.trim()) return setError(`${key}: falta el programa`);
      outSuites[key] = {
        command: { program: d.program.trim(), args: splitArgs(d.args) },
        cwd: d.cwd.trim() || undefined,
        timeoutMs: Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS * 1000 : undefined,
        junitPath: d.junitPath.trim() || undefined,
        coberturaPath: d.coberturaPath.trim() || undefined,
        lcovPath: d.lcovPath.trim() || undefined,
      };
    }
    onSave({ profiles: outProfiles, suites: outSuites });
  };

  const setSuite = (key: TestSuite, patch: Partial<SuiteDraft>) => setSuites((s) => ({ ...s, [key]: { ...s[key], ...patch } }));

  return (
    <form className="ron-tests-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="ron-tests-section-head">
        <strong>{config.configured ? `Configurar pruebas · ${config.repo}` : `Configurar pruebas · ${config.repo} (nuevo)`}</strong>
      </div>
      <p className="ron-note">
        Los comandos se ejecutan como <code>program + args</code> sin shell, en la carpeta del repo (o en <code>cwd</code> relativa para monorepos),
        con un entorno mínimo (PATH, HOME…) más las variables del perfil. Los valores guardados nunca se muestran: una línea <code>KEY</code> sin <code>=</code> los conserva.
      </p>

      <fieldset>
        <legend>Perfiles</legend>
        {profiles.map((p, i) => (
          <div key={i} className="ron-tests-profile-row">
            <label>nombre<input value={p.name} onChange={(e) => setProfiles((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="dev" /></label>
            <label>variables (KEY=valor por línea)<textarea rows={3} value={p.lines} spellCheck={false} onChange={(e) => setProfiles((ps) => ps.map((x, j) => (j === i ? { ...x, lines: e.target.value } : x)))} placeholder={"DATABASE_URL=postgres://…\nPATH=/ruta/.venv/bin:/usr/bin"} /></label>
            <button type="button" className="n-btn n-btn-ghost" onClick={() => setProfiles((ps) => ps.filter((_, j) => j !== i))}>quitar</button>
          </div>
        ))}
        <button type="button" className="n-btn n-btn-ghost" onClick={() => setProfiles((ps) => [...ps, { name: "", lines: "" }])}>+ perfil</button>
      </fieldset>

      {COMMAND_SUITES.map((key) => {
        const d = suites[key];
        const hint = SUITE_HINTS[key];
        return (
          <fieldset key={key}>
            <legend>
              <label><input type="checkbox" checked={d.enabled} onChange={(e) => setSuite(key, { enabled: e.target.checked })} /> {SUITES.find((s) => s.key === key)!.label}</label>
            </legend>
            {d.enabled && (
              <div className="ron-tests-suite-grid">
                <label>programa<input value={d.program} onChange={(e) => setSuite(key, { program: e.target.value })} placeholder={hint.program} /></label>
                <label>args<input value={d.args} onChange={(e) => setSuite(key, { args: e.target.value })} placeholder={hint.args} /></label>
                <label>cwd (relativa)<input value={d.cwd} onChange={(e) => setSuite(key, { cwd: e.target.value })} placeholder="ant-liebre-api" /></label>
                <label>timeout (s)<input value={d.timeoutS} onChange={(e) => setSuite(key, { timeoutS: e.target.value })} /></label>
                <label>JUnit XML<input value={d.junitPath} onChange={(e) => setSuite(key, { junitPath: e.target.value })} placeholder={hint.junit} /></label>
                <label>Cobertura XML<input value={d.coberturaPath} onChange={(e) => setSuite(key, { coberturaPath: e.target.value })} placeholder={hint.cov} /></label>
                <label>LCOV<input value={d.lcovPath} onChange={(e) => setSuite(key, { lcovPath: e.target.value })} placeholder="coverage/lcov.info" /></label>
              </div>
            )}
          </fieldset>
        );
      })}

      {error && <p className="ron-msg err">{error}</p>}
      <div className="ron-tests-form-actions">
        <button type="submit" className="n-btn n-btn-primary" disabled={busy}>Guardar configuración</button>
      </div>
    </form>
  );
}
