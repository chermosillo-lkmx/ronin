import { useEffect, useRef, useState } from "react";
import {
  attachWorker,
  evidenceFileUrl,
  getEvidence,
  getHistory,
  getConnectorSettings,
  getPane,
  getRepoConfig,
  getRepos,
  getTaskDescription,
  getReposConfig,
  getTerminalUrl,
  getWorkflow,
  getPrompts,
  getActions,
  saveActions,
  savePrompt,
  resetPrompt,
  launchAction,
  launchAdhoc,
  launchCustom,
  launchPrReview,
  launchResearch,
  launchTask,
  pinTask,
  refreshTasks,
  saveConnectorSettings,
  saveRepoConfig2,
  saveReposConfig,
  saveWorkflow,
  setOrder,
  stopWorker,
  subscribeStream,
  testConnector,
  workerInput,
  type Evidence,
} from "./api";
import type { ConnectorSettings, ConnectorSettingsInput, CustomAction, HistoryEvent, Priority, PromptTemplate, RepoOverrideConfig, ReposConfig, Snapshot, Task, TaskSource, TaskStatus, WfStage, WfStep, WorkflowConfig, Worker, WorkerState } from "./types";

const PRIO_NUM: Record<Priority, number> = { urgent: 1, high: 2, normal: 3, low: 4, none: 0 };

// Visibility rule (ClickUp): only show actionable dev statuses. "ready for testing"
// is shown only for NightShift tasks. Jira/others are unaffected.
const NIGHTSHIFT_LIST = "901711798837";
const VISIBLE_STATUSES = new Set([
  "backlog",
  "ready for dev",
  "selected for dev",
  "blocked",
  "with issues",
  "in progress",
]);
function isVisible(t: Task): boolean {
  if (t.source !== "clickup") return true;
  const s = (t.statusLabel ?? "").toLowerCase();
  if (VISIBLE_STATUSES.has(s)) return true;
  if (s === "ready for testing" && t.listId === NIGHTSHIFT_LIST) return true;
  return false;
}
const EVT_LABEL: Record<HistoryEvent["type"], string> = { launch: "▶ lanzó", complete: "✓ completó", stop: "◼ detuvo" };

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

// ---- date helpers (local) ----
function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO(): string {
  return isoDate(new Date());
}
/** The Friday→Thursday week containing today, as [fromISO, toISO]. */
function friThuWeek(): [string, string] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const since = (now.getDay() - 5 + 7) % 7; // days since the most recent Friday
  const fri = new Date(now);
  fri.setDate(now.getDate() - since);
  const thu = new Date(fri);
  thu.setDate(fri.getDate() + 6);
  return [isoDate(fri), isoDate(thu)];
}
function dayStartMs(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime();
}
function dayEndMs(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime();
}
function fmtDayLabel(iso: string): string {
  const today = todayISO();
  if (iso === today) return "Hoy";
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" });
}

// Order by creation: real date when present, else the id/key (ClickUp ids and
// Jira numbers are chronological) — oldest first.
function byCreated(a: Task, b: Task): number {
  const da = a.dateCreated;
  const db = b.dateCreated;
  if (da && db) return da - db;
  if (da && !db) return -1;
  if (!da && db) return 1;
  return a.key.localeCompare(b.key);
}

const SOURCE_LABEL: Record<TaskSource, string> = {
  "clickup-live": "ClickUp · LIVE",
  "clickup-seed": "ClickUp · real (seed)",
  mock: "mock",
};

const TASK_SOURCE_BADGE: Record<Task["source"], string> = {
  clickup: "CU",
  jira: "JIRA",
  gitlab: "GL",
  adhoc: "AD",
  pr: "PR",
  custom: "✎",
};

function agoLabel(ts: number | null, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return "ahora";
  if (s < 60) return `hace ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  return `hace ${Math.round(m / 60)} h`;
}

const TASK_LABEL: Record<TaskStatus, string> = {
  queued: "○ en cola",
  triage: "◍ triage pendiente",
  running: "▶ en ejecución",
  review: "⏸ esperando review",
  done: "✓ completado",
};

const WORKER_LABEL: Record<WorkerState, string> = {
  starting: "arrancando",
  busy: "implementando",
  review: "codex review",
  idle: "idle",
  done: "completado",
};

// Order tasks by status: active categories first, then group by the raw label.
const STATUS_RANK: Record<TaskStatus, number> = { running: 0, review: 1, triage: 2, queued: 3, done: 4 };
function byStatus(a: Task, b: Task): number {
  const r = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (r !== 0) return r;
  return (a.statusLabel ?? "").localeCompare(b.statusLabel ?? "");
}

// Order by priority (urgent first), then by creation date (oldest first) so the
// list can be attacked in order. Stays stable across the 5-min auto-refresh.
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3, none: 4 };
// Manual ordering (set by ▲▼) takes precedence within a priority; else creation date.
let ORDER_INDEX = new Map<string, number>();
function byPriority(a: Task, b: Task): number {
  const r = PRIORITY_RANK[a.priority ?? "none"] - PRIORITY_RANK[b.priority ?? "none"];
  if (r !== 0) return r;
  const ia = ORDER_INDEX.get(a.id);
  const ib = ORDER_INDEX.get(b.id);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return byCreated(a, b);
}

function statusClass(s: TaskStatus): string {
  if (s === "running") return "run";
  if (s === "review" || s === "triage") return "wait";
  if (s === "done") return "done";
  return "idle";
}

function workerClass(s: WorkerState): string {
  if (s === "busy" || s === "starting") return "run";
  if (s === "review") return "wait";
  if (s === "done") return "done";
  return "idle";
}

function TaskRow({
  task,
  pinned,
  actions = [],
  onTogglePin,
  onMoveUp,
  onMoveDown,
  onLaunch,
  onPreview,
}: {
  task: Task;
  pinned?: boolean;
  actions?: CustomAction[];
  onTogglePin?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onLaunch?: (task: Task) => void;
  onPreview?: (task: Task) => void;
}) {
  const canLaunch = task.status === "queued" || task.status === "triage";
  // ClickUp priority number (1=urgent … 4=low); Jira gets its own scheme later.
  const num = task.source === "clickup" && task.priority && task.priority !== "none" ? PRIO_NUM[task.priority] : 0;
  return (
    <div
      className={`row ${onPreview ? "clickable" : ""}`}
      onClick={
        onPreview
          ? (e) => {
              // toda la tarjeta abre el preview, salvo clicks en botones/links/inputs
              if ((e.target as HTMLElement).closest("button, a, input")) return;
              onPreview(task);
            }
          : undefined
      }
    >
      <div className="row-main">
        <span className="key">
          <span className={`srcbadge ${task.source}`}>{TASK_SOURCE_BADGE[task.source]}</span>
          {task.url ? <a href={task.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{task.key}</a> : task.key}
        </span>
        <span className="title" title={task.title}>{task.title}</span>
        <span className="repo">{task.repo}</span>
      </div>
      <div className="row-side">
        {(onMoveUp || onMoveDown) && (
          <span className="movebtns">
            <button className="btn move" onClick={onMoveUp} title="subir dentro de la prioridad">▲</button>
            <button className="btn move" onClick={onMoveDown} title="bajar dentro de la prioridad">▼</button>
          </span>
        )}
        {task.priority && task.priority !== "none" && (
          <span className={`prio ${task.priority}`}>{num ? `P${num} ` : ""}{task.priority}</span>
        )}
        <span className={`pill ${statusClass(task.status)}`}>{task.statusLabel ?? TASK_LABEL[task.status]}</span>
        {onTogglePin && (
          <button className={`btn pin ${pinned ? "on" : ""}`} onClick={onTogglePin} title={pinned ? "quitar de hoy" : "agregar a hoy"}>
            {pinned ? "★" : "☆"}
          </button>
        )}
        {canLaunch && (
          <>
            <button className="btn research" onClick={() => launchResearch(task.id)}>
              🔍 investigar
            </button>
            <button className="btn launch" onClick={() => (onLaunch ? onLaunch(task) : launchTask(task.id))}>
              ▷ lanzar
            </button>
            {actions
              .filter((a) => a.showOn?.includes("row"))
              .map((a) => (
                <button key={a.key} className="btn action" onClick={() => { launchAction(task.id, a.key).catch(() => {}); }}>
                  {a.icon} {a.label}
                </button>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

function HoyView({
  tasks,
  pins,
  actions,
  history,
  onTogglePin,
  onLaunch,
  onPreview,
  fromDate,
  toDate,
  setRange,
}: {
  tasks: Task[];
  pins: string[];
  actions: CustomAction[];
  history: HistoryEvent[];
  onTogglePin: (t: Task) => void;
  onLaunch: (t: Task) => void;
  onPreview: (t: Task) => void;
  fromDate: string;
  toDate: string;
  setRange: (from: string, to: string) => void;
}) {
  // group activity by day, newest day first
  const byDay = new Map<string, HistoryEvent[]>();
  for (const e of history) {
    const d = isoDate(new Date(e.ts));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(e);
  }
  const days = [...byDay.keys()].sort().reverse();

  const pinned = new Set(pins);
  const pending = tasks
    .filter((t) => t.status !== "done" && t.source === "clickup")
    .sort((a, b) => {
      const pa = pinned.has(a.id) ? 0 : 1;
      const pb = pinned.has(b.id) ? 0 : 1;
      return pa !== pb ? pa - pb : byCreated(a, b);
    });

  const isToday = fromDate === todayISO() && toDate === todayISO();
  const [wf, wt] = friThuWeek();
  const isWeek = fromDate === wf && toDate === wt;

  return (
    <>
      <div className="range">
        <button className={`rbtn ${isToday ? "on" : ""}`} onClick={() => setRange(todayISO(), todayISO())}>Hoy</button>
        <button className={`rbtn ${isWeek ? "on" : ""}`} onClick={() => setRange(wf, wt)}>Semana (Vie–Jue)</button>
        <input type="date" value={fromDate} max={toDate} onChange={(e) => setRange(e.target.value, toDate)} />
        <span className="range-sep">→</span>
        <input type="date" value={toDate} min={fromDate} onChange={(e) => setRange(fromDate, e.target.value)} />
      </div>

      <h3 className="sec-h">▸ ACTIVIDAD <span className="muted">({history.length} evento{history.length === 1 ? "" : "s"})</span></h3>
      {history.length === 0 && <div className="empty">sin actividad en el rango</div>}
      {days.map((day) => (
        <div key={day} className="day-grp">
          <div className="day-h">{fmtDayLabel(day)} <span className="muted">· {byDay.get(day)!.length}</span></div>
          {byDay.get(day)!.map((e, i) => (
            <div key={i} className="hist">
              <span className={`evt ${e.type}`}>{EVT_LABEL[e.type]}</span>
              <span className="evt-time">{fmtTime(e.ts)}</span>
              <span className={`srcbadge ${e.source}`}>{TASK_SOURCE_BADGE[e.source as Task["source"]] ?? "?"}</span>
              <span className="evt-key">{e.key}</span>
              <span className="evt-title" title={e.title}>{e.title}</span>
            </div>
          ))}
        </div>
      ))}

      <h3 className="sec-h mt">▸ PENDIENTES (ClickUp) <span className="muted">({pending.length}, por fecha de creación · ★ = plan de hoy)</span></h3>
      {pending.map((t) => (
        <TaskRow key={t.id} task={t} pinned={pinned.has(t.id)} actions={actions} onTogglePin={() => onTogglePin(t)} onLaunch={onLaunch} onPreview={onPreview} />
      ))}
    </>
  );
}

function WorkerRow({ worker, task, actions = [], onOpen }: { worker: Worker; task?: Task; actions?: CustomAction[]; onOpen: () => void }) {
  // Para ad-hoc/custom el "key" es un id feo (adhoc-…/custom-…); muestra el mensaje disparador.
  const isFreeText = task?.source === "adhoc" || task?.source === "custom";
  const badge = task ? TASK_SOURCE_BADGE[task.source] : "";
  const trigger = (task?.body ?? task?.title ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  return (
    <div className={`row ${worker.needsInput ? "needs" : ""}`}>
      <div className="row-main">
        <span className="wtitle" title={task?.title}>
          {task && <span className={`srcbadge ${task.source}`}>{badge}</span>}{" "}
          {isFreeText ? (
            <span className="wtrigger">{trigger || task?.title || worker.label}</span>
          ) : (
            <>
              <span className="wkey">{task?.key ?? worker.taskId}</span> {task?.title}
            </>
          )}
        </span>
        <span className="stage">{worker.repo} · {worker.stage}</span>
      </div>
      <div className="row-side">
        {worker.needsInput && <span className="pill needs-pill">⚠ responder</span>}
        {worker.kind === "research" && <span className="pill research">🔍 investigación</span>}
        {worker.kind === "action" && (
          <span className="pill research">⚡ {actions.find((a) => a.key === worker.actionKey)?.label ?? "acción"}</span>
        )}
        <span className={`pill ${workerClass(worker.state)}`}>{WORKER_LABEL[worker.state]}</span>
        <button className="btn view" onClick={onOpen} title="ver detalles y terminal">
          ⊡ ver
        </button>
        {worker.session && (
          <button className="btn attach" onClick={() => attachWorker(worker.id)} title="abrir Terminal con tmux attach">
            ⧉
          </button>
        )}
        <button className="btn stop" onClick={() => stopWorker(worker.id)}>
          ◼
        </button>
      </div>
    </div>
  );
}

function buildComment(task: Task | undefined, worker: Worker, ev: Evidence | null): string {
  if (worker.kind === "research" && ev?.research) return ev.research.trim();
  if (ev?.summary) return ev.summary.trim();
  const parts: string[] = [`### ${task?.key ?? worker.label} — evidencia`];
  if (task?.title) parts.push(task.title);
  if (task?.url) parts.push(task.url);
  if (ev?.curl) parts.push(`\n**Pruebas curl**\n\n${ev.curl.trim()}`);
  if (ev?.ui) parts.push(`\n**Verificación UI**\n\n${ev.ui.trim()}`);
  if (!ev?.curl && !ev?.ui) parts.push("\n_(sin evidencia todavía)_");
  return parts.join("\n");
}

// Fallback when the snapshot hasn't delivered the workflow steps yet.
const LOOP_STAGES: WfStep[] = [
  { key: "planning", label: "Plan", icon: "📋" },
  { key: "implementing", label: "Impl", icon: "⌨️" },
  { key: "curl", label: "Curl", icon: "🌐" },
  { key: "verify", label: "Verify", icon: "🔎" },
  { key: "done", label: "Done", icon: "✓" },
];

function Pipeline({ stageKey, stages }: { stageKey?: string; stages?: WfStep[] }) {
  const steps = stages && stages.length ? stages : LOOP_STAGES;
  const idx = steps.findIndex((s) => s.key === stageKey);
  return (
    <div className="pipe-steps">
      {steps.map((s, i) => {
        const state = idx < 0 ? "pending" : i < idx ? "is-done" : i === idx ? "is-current" : "is-pending";
        return (
          <div key={s.key} className="pstep-wrap">
            <div className={`pstep ${state}`}>
              <span className="pico">{s.icon}</span>
              <span className="plabel">{s.label}</span>
            </div>
            {i < steps.length - 1 && <span className={`parrow ${i < idx ? "is-done" : ""}`}>→</span>}
          </div>
        );
      })}
    </div>
  );
}

function TaskDetailWindow({ worker, task, stages, onClose }: { worker: Worker; task: Task | undefined; stages?: WfStep[]; onClose: () => void }) {
  const [pane, setPane] = useState<string>("cargando terminal…");
  const [ev, setEv] = useState<Evidence | null>(null);
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState("");
  const [ttydUrl, setTtydUrl] = useState<string | null>(null);

  async function sendReply() {
    if (!reply.trim()) return;
    await workerInput(worker.id, reply);
    setReply("");
  }
  async function openInteractive() {
    const url = await getTerminalUrl(worker.id);
    if (url) setTtydUrl(url);
  }

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const p = await getPane(worker.id);
      if (alive && p) setPane(p.pane || "(pane vacío)");
      const e = await getEvidence(worker.id);
      if (alive) setEv(e);
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [worker.id]);

  async function copyComment() {
    await navigator.clipboard.writeText(buildComment(task, worker, ev));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const hasEvidence = ev && (ev.summary || ev.research || ev.curl || ev.ui || ev.verdict || ev.images.length);
  const desc = (task?.body ?? task?.title ?? "").trim();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="detail-window" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="drawer-title">{worker.label} · {task?.key ?? worker.taskId}</div>
            <div className="drawer-sub">{worker.session ?? "simulado"} · {worker.repo} · {worker.stage}</div>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </header>

        <div className="detail-panes">
          {/* IZQUIERDA — detalles */}
          <div className="detail-left">
            <section className="drawer-sec">
              <div className="detail-meta">
                {task && <span className={`srcbadge ${task.source}`}>{TASK_SOURCE_BADGE[task.source]}</span>}
                <span className="repo">{worker.repo}</span>
                {task?.priority && task.priority !== "none" && <span className={`prio ${task.priority}`}>{task.priority}</span>}
                {task?.url && <a className="detail-link" href={task.url} target="_blank" rel="noreferrer">🔗 abrir</a>}
              </div>
            </section>

            {desc && (
              <section className="drawer-sec">
                <h4>▸ DESCRIPCIÓN</h4>
                <pre className="ev-md detail-desc">{desc}</pre>
              </section>
            )}

            <section className="drawer-sec">
              <h4>▸ LOOP</h4>
              <Pipeline stageKey={worker.stageKey} stages={worker.stages ?? stages} />
            </section>

            <section className="drawer-sec">
              <div className="ev-head">
                <h4>▸ EVIDENCIA</h4>
                <button className="btn copy" onClick={copyComment} disabled={!hasEvidence}>
                  {copied ? "✓ copiado" : "⧉ copiar comentario"}
                </button>
              </div>
              {!hasEvidence && <div className="empty">sin evidencia todavía — aparece cuando el worker la genere</div>}
              {ev?.summary && (
                <div className="ev-block"><div className="ev-label">resumen</div><pre className="ev-md">{ev.summary}</pre></div>
              )}
              {ev?.research && (
                <div className="ev-block"><div className="ev-label">investigación (plan propuesto)</div><pre className="ev-md">{ev.research}</pre></div>
              )}
              {ev?.curl && (
                <div className="ev-block"><div className="ev-label">curl</div><pre className="ev-md">{ev.curl}</pre></div>
              )}
              {ev?.ui && (
                <div className="ev-block"><div className="ev-label">ui-verify</div><pre className="ev-md">{ev.ui}</pre></div>
              )}
              {ev?.verdict && (
                <div className="ev-block"><div className="ev-label">veredicto (verificador)</div><pre className="ev-md">{ev.verdict}</pre></div>
              )}
              {ev && ev.images.length > 0 && (
                <div className="ev-block">
                  <div className="ev-label">screenshots</div>
                  <div className="ev-shots">
                    {ev.images.map((img) => (
                      <a key={img} href={evidenceFileUrl(worker.id, img)} target="_blank" rel="noreferrer">
                        <img src={evidenceFileUrl(worker.id, img)} alt={img} />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>

          {/* DERECHA — terminal en vivo */}
          <div className="detail-right">
            <section className="drawer-sec detail-term-sec">
              <div className="ev-head">
                <h4>▸ TERMINAL {worker.needsInput && <span className="needs-pill">⚠ necesita input</span>}</h4>
                {worker.session && (
                  ttydUrl ? (
                    <button className="btn view" onClick={() => setTtydUrl(null)}>↩ solo lectura</button>
                  ) : (
                    <button className="btn view" onClick={openInteractive}>⛶ interactiva</button>
                  )
                )}
              </div>
              {ttydUrl ? (
                <iframe className="ttyd" src={ttydUrl} title="terminal interactiva" />
              ) : (
                <>
                  <pre className="term detail-term">{pane}</pre>
                  {worker.session && (
                    <div className="reply">
                      <input
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") sendReply(); }}
                        placeholder="responder al worker (Enter envía)…"
                      />
                      <button className="btn launch" onClick={sendReply} disabled={!reply.trim()}>▷ enviar</button>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Pre-launch step: turn workflow stages on/off for this run. */
function LaunchModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const [wf, setWf] = useState<WorkflowConfig | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getWorkflow().then((w) => {
      if (!w) return;
      setWf(w);
      setEnabled(new Set(w.stages.map((s) => s.key))); // all on by default
    });
  }, []);

  function toggle(k: string) {
    setEnabled((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }

  async function go() {
    if (!wf) return;
    const keys = wf.stages.filter((s) => enabled.has(s.key)).map((s) => s.key);
    if (!keys.length) return;
    setBusy(true);
    try {
      await launchTask(task.id, keys);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  const verifierOn = !!(wf?.verifyAfter && enabled.has(wf.verifyAfter));
  const verifierLabel = wf?.stages.find((s) => s.key === wf.verifyAfter)?.label;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="drawer-title">▷ Lanzar · {task.key}</div>
            <div className="drawer-sub" title={task.title}>{task.title} · prende/apaga pasos para esta corrida</div>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </header>

        {!wf && <div className="empty">cargando workflow…</div>}
        {wf && (
          <div className="wf-toggles">
            {wf.stages.map((s) => (
              <label key={s.key} className={`wf-toggle ${enabled.has(s.key) ? "on" : ""}`}>
                <input type="checkbox" checked={enabled.has(s.key)} onChange={() => toggle(s.key)} />
                <span className="pico">{s.icon}</span>
                <span className="wf-tlabel">{s.label}</span>
                {s.instruction && <span className="wf-tinstr" title={s.instruction}>{s.instruction}</span>}
              </label>
            ))}
            {wf.verifyAfter && (
              <div className={`wf-toggle auto ${verifierOn ? "on" : "off"}`} title="se controla con la etapa ancla del verificador">
                <span className="pico">🔎</span>
                <span className="wf-tlabel">Verificador</span>
                <span className="wf-tinstr">{verifierOn ? `corre tras "${verifierLabel}"` : `apagado (enciende "${verifierLabel}")`}</span>
              </div>
            )}
          </div>
        )}

        <div className="modal-foot">
          <span className="muted">{enabled.size} paso(s) activo(s)</span>
          <button className="btn copy" onClick={go} disabled={busy || !wf || enabled.size === 0}>
            {busy ? "lanzando…" : "▷ lanzar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Preview de una tarea: descripción (lazy) + Investigar / Lanzar. Reusa modal-backdrop/modal. */
function TaskPreviewModal({ task, actions = [], onClose, onLaunch }: { task: Task; actions?: CustomAction[]; onClose: () => void; onLaunch: (task: Task) => void }) {
  const [desc, setDesc] = useState<string | null>(null); // null = cargando
  const canLaunch = task.status === "queued" || task.status === "triage";

  useEffect(() => {
    let alive = true;
    getTaskDescription(task.id)
      .then((d) => { if (alive) setDesc(d && d.trim() ? d : task.title); })
      .catch(() => { if (alive) setDesc(task.title); });
    return () => { alive = false; };
  }, [task.id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="drawer-title">
              <span className={`srcbadge ${task.source}`}>{TASK_SOURCE_BADGE[task.source]}</span> {task.key}
            </div>
            <div className="drawer-sub" title={task.title}>{task.title}</div>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </header>

        <div className="detail-meta">
          <span className="repo">{task.repo}</span>
          {task.priority && task.priority !== "none" && <span className={`prio ${task.priority}`}>{task.priority}</span>}
          <span className={`pill ${statusClass(task.status)}`}>{task.statusLabel ?? TASK_LABEL[task.status]}</span>
          {task.url && <a className="detail-link" href={task.url} target="_blank" rel="noreferrer">🔗 abrir</a>}
        </div>

        <section className="drawer-sec preview-desc">
          <h4>▸ DESCRIPCIÓN</h4>
          {desc === null ? <div className="empty">cargando descripción…</div> : <pre className="ev-md">{desc}</pre>}
        </section>

        <div className="modal-foot">
          {canLaunch ? (
            <div className="preview-actions">
              <button className="btn research" onClick={() => { launchResearch(task.id); onClose(); }}>🔍 investigar</button>
              <button className="btn launch" onClick={() => { onClose(); onLaunch(task); }}>▷ lanzar</button>
              {actions
                .filter((a) => a.showOn?.includes("preview"))
                .map((a) => (
                  <button
                    key={a.key}
                    className="btn action"
                    onClick={() => { launchAction(task.id, a.key).then(onClose).catch(() => {}); }} // cierra sólo si lanzó bien
                  >
                    {a.icon} {a.label}
                  </button>
                ))}
            </div>
          ) : (
            <span className="muted">tarea en {task.statusLabel ?? task.status}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Free-text request that runs the composable workflow loop (choose repo + stages). */
function CustomRequestModal({ onClose, onLaunched }: { onClose: () => void; onLaunched: () => void }) {
  const [text, setText] = useState("");
  const [repos, setRepos] = useState<string[]>(["monorepo"]);
  const [repo, setRepo] = useState("monorepo");
  const [wf, setWf] = useState<WorkflowConfig | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getRepos().then((rs) => { setRepos(rs); setRepo(rs[0] ?? "monorepo"); });
    getWorkflow().then((w) => {
      if (!w) return;
      setWf(w);
      setEnabled(new Set(w.stages.map((s) => s.key))); // all on by default
    });
  }, []);

  function toggle(k: string) {
    setEnabled((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }

  async function go() {
    if (!wf || !text.trim()) return;
    const keys = wf.stages.filter((s) => enabled.has(s.key)).map((s) => s.key);
    if (!keys.length) return;
    setBusy(true);
    try { await launchCustom(text.trim(), repo, keys); onLaunched(); onClose(); }
    finally { setBusy(false); }
  }

  const verifierOn = !!(wf?.verifyAfter && enabled.has(wf.verifyAfter));
  const verifierLabel = wf?.stages.find((s) => s.key === wf.verifyAfter)?.label;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="drawer-title">✎ Petición personal</div>
            <div className="drawer-sub">texto libre · corre el workflow loop · elige repo y pasos para esta corrida</div>
          </div>
          <button className="drawer-close" onClick={onClose}>✕</button>
        </header>

        <textarea
          className="adhoc-input"
          autoFocus
          placeholder={"Ej: Agrega un endpoint para reasignar CFDIs entre cuentas y valida que solo lo pueda hacer un admin…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="modal-foot">
          <label className="muted">
            Repo:{" "}
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </label>
        </div>

        {!wf && <div className="empty">cargando workflow…</div>}
        {wf && (
          <div className="wf-toggles">
            {wf.stages.map((s) => (
              <label key={s.key} className={`wf-toggle ${enabled.has(s.key) ? "on" : ""}`}>
                <input type="checkbox" checked={enabled.has(s.key)} onChange={() => toggle(s.key)} />
                <span className="pico">{s.icon}</span>
                <span className="wf-tlabel">{s.label}</span>
                {s.instruction && <span className="wf-tinstr" title={s.instruction}>{s.instruction}</span>}
              </label>
            ))}
            {wf.verifyAfter && (
              <div className={`wf-toggle auto ${verifierOn ? "on" : "off"}`} title="se controla con la etapa ancla del verificador">
                <span className="pico">🔎</span>
                <span className="wf-tlabel">Verificador</span>
                <span className="wf-tinstr">{verifierOn ? `corre tras "${verifierLabel}"` : `apagado (enciende "${verifierLabel}")`}</span>
              </div>
            )}
          </div>
        )}

        <div className="modal-foot">
          <span className="muted">{enabled.size} paso(s) activo(s)</span>
          <button className="btn copy" onClick={go} disabled={busy || !wf || !text.trim() || enabled.size === 0}>
            {busy ? "lanzando…" : "▷ lanzar petición"}
          </button>
        </div>
      </div>
    </div>
  );
}

const EMOJI_CHOICES = ["📋", "⌨️", "🌐", "🔎", "✓", "💬", "🔒", "🧪", "🧹", "📦", "🚀", "🛠️", "🔥", "📝", "⚙️", "⚡"];

// Placeholders disponibles en el prompt de una acción custom (panel de ayuda del editor).
const ACTION_PLACEHOLDERS = ["{title}", "{key}", "{repo}", "{body}", "{url}", "{ref}", "{cycle}", "{ev}", "{steps}", "{verifier}", "{var:KEY}"];

/** Visual editor for the composable workflow (persists to data/workflow.json). */
/** Controlled stage editor (etapas + verificador). Reused by the global workflow and per-repo overrides. */
function StageEditor({
  stages,
  verifyAfter,
  onStages,
  onVerifyAfter,
}: {
  stages: WfStage[];
  verifyAfter: string | null;
  onStages: (next: WfStage[]) => void;
  onVerifyAfter: (va: string | null) => void;
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

/** Body (fragment) editing the global default workflow (data/workflow.json), persisted via /api/workflow. */
function GlobalWorkflowEditor() {
  const [wf, setWf] = useState<WorkflowConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getWorkflow().then(setWf);
  }, []);

  async function save() {
    if (!wf) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const updated = await saveWorkflow(wf);
      setWf(updated);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!wf && <div className="empty">cargando…</div>}
      {wf && (
        <StageEditor
          stages={wf.stages}
          verifyAfter={wf.verifyAfter}
          onStages={(stages) => { setWf({ ...wf, stages }); setSaved(false); }}
          onVerifyAfter={(verifyAfter) => { setWf({ ...wf, verifyAfter }); setSaved(false); }}
        />
      )}

      <div className="modal-foot">
        <span className="muted">{err ? <span className="wf-err">{err}</span> : saved ? "guardado ✓" : "se aplica a los próximos lanzamientos"}</span>
        <button className="btn copy" onClick={save} disabled={busy || !wf}>
          {busy ? "guardando…" : "💾 guardar workflow"}
        </button>
      </div>
    </>
  );
}

/** Editor for a repo's workflow override + vars + startCommand, persisted via /api/repo-config/:repo. */
function RepoOverrideEditor({ repo }: { repo: string }) {
  const [cfg, setCfg] = useState<RepoOverrideConfig | null>(null);
  const [inherit, setInherit] = useState(true);
  const [vars, setVars] = useState<{ key: string; value: string }[]>([]);
  const [startCommand, setStartCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // (Re)load whenever the selected repo changes; reset all local state first.
  useEffect(() => {
    setCfg(null);
    setErr(null);
    setSaved(false);
    getRepoConfig(repo).then((c) => {
      if (!c) return;
      setCfg(c);
      setInherit(c.usesDefaultWorkflow);
      setVars(Object.entries(c.vars).map(([key, value]) => ({ key, value })));
      setStartCommand(c.startCommand);
    });
  }, [repo]);

  function setWorkflow(next: WorkflowConfig) {
    setCfg((c) => c && { ...c, workflow: next });
    setSaved(false);
  }

  async function toggleInherit(on: boolean) {
    setInherit(on);
    setSaved(false);
    if (!on && cfg && !cfg.workflow) {
      // Un-inheriting from a default state → seed the override with a copy of the global default.
      const def = await getWorkflow();
      if (def) setCfg((c) => c && { ...c, workflow: { stages: def.stages.map((s) => ({ ...s })), verifyAfter: def.verifyAfter } });
    }
  }

  function patchVar(i: number, p: Partial<{ key: string; value: string }>) {
    setVars((vs) => vs.map((v, idx) => (idx === i ? { ...v, ...p } : v)));
    setSaved(false);
  }
  function removeVar(i: number) {
    setVars((vs) => vs.filter((_, idx) => idx !== i));
    setSaved(false);
  }
  function addVar() {
    setVars((vs) => [...vs, { key: "", value: "" }]);
    setSaved(false);
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const varsObj: Record<string, string> = {};
      for (const { key, value } of vars) if (key.trim()) varsObj[key.trim()] = value;
      const updated = await saveRepoConfig2(repo, {
        workflow: inherit ? null : cfg.workflow,
        vars: varsObj,
        startCommand: startCommand.trim(),
        inheritWorkflow: inherit,
      });
      setCfg(updated);
      setInherit(updated.usesDefaultWorkflow);
      setVars(Object.entries(updated.vars).map(([key, value]) => ({ key, value })));
      setStartCommand(updated.startCommand);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!cfg && <div className="empty">cargando…</div>}
      {cfg && (
        <>
          <label className="wf-verify">
            <input type="checkbox" checked={inherit} onChange={(e) => toggleInherit(e.target.checked)} />
            <span>heredar el workflow default (sin override propio)</span>
          </label>

          {!inherit && cfg.workflow && (
            <StageEditor
              stages={cfg.workflow.stages}
              verifyAfter={cfg.workflow.verifyAfter}
              onStages={(stages) => setWorkflow({ ...cfg.workflow!, stages })}
              onVerifyAfter={(verifyAfter) => setWorkflow({ ...cfg.workflow!, verifyAfter })}
            />
          )}

          <div className="repos-editor">
            <div className="drawer-sub">Variables del repo (se escriben en <code>curl.env</code> y como <code>{"{var:CLAVE}"}</code> en el prompt)</div>
            {vars.map((v, i) => (
              <div key={i} className="repos-row">
                <input className="repos-key" placeholder="clave (ej. DEV_URL)" value={v.key} onChange={(e) => patchVar(i, { key: e.target.value })} />
                <input className="repos-path" placeholder="valor" value={v.value} onChange={(e) => patchVar(i, { value: e.target.value })} />
                <button className="btn stop" onClick={() => removeVar(i)} title="quitar variable">✕</button>
              </div>
            ))}
            <button className="btn add-stage" onClick={addVar}>＋ agregar variable</button>
          </div>

          <div className="repos-default">
            <span>Comando de inicio:</span>
            <input
              className="repos-path"
              placeholder="claude --permission-mode bypassPermissions (default)"
              value={startCommand}
              onChange={(e) => { setStartCommand(e.target.value); setSaved(false); }}
            />
          </div>
        </>
      )}

      <div className="modal-foot">
        <span className="muted">{err ? <span className="wf-err">{err}</span> : saved ? "guardado ✓" : "se aplica a los próximos lanzamientos"}</span>
        <button className="btn copy" onClick={save} disabled={busy || !cfg}>
          {busy ? "guardando…" : "💾 guardar override"}
        </button>
      </div>
    </>
  );
}

/** Workflows section: a repo selector over the global default editor + per-repo override editors. */
function WorkflowsSection() {
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState("__default__");

  useEffect(() => {
    getRepos().then(setRepos);
  }, []);

  return (
    <div className="settings-panel">
      <header className="settings-panel-head">
        <div className="drawer-title">⚙ Workflows por repo</div>
        <div className="drawer-sub">
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="__default__">Default (todos)</option>
            {repos.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <span> · {repo === "__default__" ? "edita el workflow global" : "override propio de este repo (heredar = sin override)"}</span>
        </div>
      </header>

      {repo === "__default__" ? <GlobalWorkflowEditor /> : <RepoOverrideEditor key={repo} repo={repo} />}
    </div>
  );
}

/** Editor for the repo→folder map (data/repos.json), persisted via /api/repos-config. */
function ReposSection() {
  const [cfg, setCfg] = useState<ReposConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getReposConfig().then(setCfg);
  }, []);

  function patch(i: number, p: Partial<{ key: string; path: string }>) {
    setCfg((c) => c && { ...c, repos: c.repos.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  }
  function removeRow(i: number) {
    setCfg((c) => c && { ...c, repos: c.repos.filter((_, idx) => idx !== i) });
  }
  function addRow() {
    setCfg((c) => c && { ...c, repos: [...c.repos, { key: "", path: "" }] });
  }

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const updated = await saveReposConfig(cfg);
      setCfg(updated);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel-head">
        <div className="drawer-title">📁 Repos</div>
        <div className="drawer-sub">carpeta donde arranca el worker por repo · <code>_default</code> cubre lo no listado</div>
      </header>

      {!cfg && <div className="empty">cargando…</div>}
      {cfg && (
        <>
          <div className="repos-editor">
            {cfg.repos.map((r, i) => (
              <div key={i} className="repos-row">
                <input className="repos-key" placeholder="key (ej. ant-ms-cfdis)" value={r.key} onChange={(e) => patch(i, { key: e.target.value })} />
                <input className="repos-path" placeholder="/ruta/al/repo" value={r.path} onChange={(e) => patch(i, { path: e.target.value })} />
                <button className="btn stop" onClick={() => removeRow(i)} title="quitar repo">✕</button>
              </div>
            ))}
            <button className="btn add-stage" onClick={addRow}>＋ agregar repo</button>
          </div>

          <div className="repos-default">
            <span>Carpeta por defecto (<code>_default</code>):</span>
            <input className="repos-path" value={cfg.defaultPath} onChange={(e) => setCfg({ ...cfg, defaultPath: e.target.value })} />
          </div>
        </>
      )}

      <div className="modal-foot">
        <span className="muted">{err ? <span className="wf-err">{err}</span> : saved ? "guardado ✓" : "se aplica a los próximos lanzamientos"}</span>
        <button className="btn copy" onClick={save} disabled={busy || !cfg}>
          {busy ? "guardando…" : "💾 guardar repos"}
        </button>
      </div>
    </div>
  );
}

/** Editor de las 6 plantillas de prompt editables (/api/prompts). Sin overrides = default. */
function PromptsSection() {
  const [cfg, setCfg] = useState<PromptTemplate[] | null>(null);
  const [sel, setSel] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getPrompts().then((c) => {
      if (!c) return;
      setCfg(c);
      if (c[0]) {
        setSel(c[0].key);
        setDraft(c[0].template);
      }
    });
  }, []);

  const current = cfg?.find((t) => t.key === sel) ?? null;

  function pick(key: string) {
    setSel(key);
    setDraft(cfg?.find((t) => t.key === key)?.template ?? "");
    setSaved(false);
    setErr(null);
  }

  async function save() {
    if (!sel) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const updated = await savePrompt(sel, draft);
      setCfg(updated);
      const e = updated.find((t) => t.key === sel);
      if (e) setDraft(e.template);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!sel) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const updated = await resetPrompt(sel);
      setCfg(updated);
      const e = updated.find((t) => t.key === sel);
      if (e) setDraft(e.template);
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel-head">
        <div className="drawer-title">✍️ Prompts</div>
        <div className="drawer-sub">plantillas que se envían a los workers · vacío = usar el default · se aplica a los próximos lanzamientos</div>
      </header>

      {!cfg && <div className="empty">cargando…</div>}
      {cfg && (
        <>
          <div className="prompt-tabs">
            {cfg.map((t) => (
              <button
                key={t.key}
                className={`settings-item ${sel === t.key ? "on" : ""}`}
                onClick={() => pick(t.key)}
              >
                {t.label} {t.isDefault ? "" : "•"}
              </button>
            ))}
          </div>

          {current && (
            <>
              <div className="prompt-meta">
                <span className={current.isDefault ? "muted" : "wf-badge"}>
                  {current.isDefault ? "usando default" : "personalizado"}
                </span>
              </div>
              <textarea
                className="wf-instr prompt-textarea"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSaved(false);
                }}
                spellCheck={false}
              />
              <div className="prompt-ph">
                <span className="muted">placeholders:</span>{" "}
                {current.placeholders.map((p) => (
                  <code key={p} className="prompt-chip">{p}</code>
                ))}
              </div>
            </>
          )}
        </>
      )}

      <div className="modal-foot">
        <span className="muted">{err ? <span className="wf-err">{err}</span> : saved ? "guardado ✓" : "vacío = default"}</span>
        <div className="prompt-actions">
          <button className="btn" onClick={restore} disabled={busy || !current || current.isDefault}>
            ↩ restaurar default
          </button>
          <button className="btn copy" onClick={save} disabled={busy || !current}>
            {busy ? "guardando…" : "💾 guardar prompt"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Editor for connector credentials (ClickUp/Jira), persisted via /api/connectors. Tokens masked. */
function ConnectorsSection() {
  const [cfg, setCfg] = useState<ConnectorSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<null | "clickup" | "jira" | "gitlab">(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // ClickUp form
  const [cuToken, setCuToken] = useState("");
  const [cuTeam, setCuTeam] = useState("");
  const [cuLists, setCuLists] = useState("");
  const [cuTest, setCuTest] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);
  // Jira form
  const [jToken, setJToken] = useState("");
  const [jBase, setJBase] = useState("");
  const [jEmail, setJEmail] = useState("");
  const [jJql, setJJql] = useState("");
  const [jTest, setJTest] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);
  // GitLab form
  const [gToken, setGToken] = useState("");
  const [gBase, setGBase] = useState("");
  const [gProject, setGProject] = useState("");
  const [gTest, setGTest] = useState<{ ok: boolean; detail?: string; error?: string } | null>(null);

  useEffect(() => {
    getConnectorSettings().then((c) => {
      if (!c) return;
      setCfg(c);
      setCuTeam(c.clickup.teamId);
      setCuLists(c.clickup.listIds.join(", "));
      setJBase(c.jira.baseUrl);
      setJEmail(c.jira.email);
      setJJql(c.jira.jql);
      setGBase(c.gitlab.baseUrl);
      setGProject(c.gitlab.project);
    });
  }, []);

  async function save() {
    if (!cfg) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const input: ConnectorSettingsInput = {
        clickup: { token: cuToken, teamId: cuTeam, listIds: cuLists },
        jira: { token: jToken, baseUrl: jBase, email: jEmail, jql: jJql },
        gitlab: { token: gToken, baseUrl: gBase, project: gProject },
      };
      const updated = await saveConnectorSettings(input);
      setCfg(updated);
      // Re-hydrate non-token fields from the server-normalized values (trim/dedup/slash-strip).
      setCuTeam(updated.clickup.teamId);
      setCuLists(updated.clickup.listIds.join(", "));
      setJBase(updated.jira.baseUrl);
      setJEmail(updated.jira.email);
      setJJql(updated.jira.jql);
      setGBase(updated.gitlab.baseUrl);
      setGProject(updated.gitlab.project);
      setCuToken("");
      setJToken("");
      setGToken("");
      setSaved(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test(name: "clickup" | "jira" | "gitlab") {
    setTesting(name);
    try {
      const res = await testConnector(name);
      if (name === "clickup") setCuTest(res);
      else if (name === "jira") setJTest(res);
      else setGTest(res);
    } finally {
      setTesting(null);
    }
  }

  const tokenPlaceholder = (has: boolean) => (has ? "•••• configurado (vacío = conservar)" : "pega el token");

  return (
    <div className="settings-panel">
      <header className="settings-panel-head">
        <div className="drawer-title">🔌 Conectores</div>
        <div className="drawer-sub">credenciales de ClickUp / Jira / GitLab · el token no se muestra · guardar re-sincroniza el tablero</div>
      </header>

      {!cfg && <div className="empty">cargando…</div>}
      {cfg && (
        <div className="conn-forms">
          <fieldset className="conn-group">
            <legend>ClickUp</legend>
            <label className="conn-field"><span>Token</span>
              <input type="password" autoComplete="off" placeholder={tokenPlaceholder(cfg.clickup.hasToken)} value={cuToken} onChange={(e) => { setCuToken(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>Team ID</span>
              <input placeholder="(auto si vacío)" value={cuTeam} onChange={(e) => { setCuTeam(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>List IDs</span>
              <input placeholder="coma-separadas (opcional)" value={cuLists} onChange={(e) => { setCuLists(e.target.value); setSaved(false); }} />
            </label>
            <div className="conn-actions">
              <button className="btn" onClick={() => test("clickup")} disabled={testing === "clickup"}>{testing === "clickup" ? "probando…" : "probar conexión"}</button>
              {cuTest && <span className={cuTest.ok ? "conn-ok" : "conn-err"}>{cuTest.ok ? `✓ ${cuTest.detail}` : `✕ ${cuTest.error}`}</span>}
            </div>
          </fieldset>

          <fieldset className="conn-group">
            <legend>Jira</legend>
            <label className="conn-field"><span>Base URL</span>
              <input placeholder="https://tusitio.atlassian.net" value={jBase} onChange={(e) => { setJBase(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>Email</span>
              <input placeholder="tu@correo.com" value={jEmail} onChange={(e) => { setJEmail(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>Token</span>
              <input type="password" autoComplete="off" placeholder={tokenPlaceholder(cfg.jira.hasToken)} value={jToken} onChange={(e) => { setJToken(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>JQL</span>
              <input placeholder="assignee = currentUser() AND statusCategory != Done" value={jJql} onChange={(e) => { setJJql(e.target.value); setSaved(false); }} />
            </label>
            <div className="conn-actions">
              <button className="btn" onClick={() => test("jira")} disabled={testing === "jira"}>{testing === "jira" ? "probando…" : "probar conexión"}</button>
              {jTest && <span className={jTest.ok ? "conn-ok" : "conn-err"}>{jTest.ok ? `✓ ${jTest.detail}` : `✕ ${jTest.error}`}</span>}
            </div>
          </fieldset>

          <fieldset className="conn-group">
            <legend>GitLab</legend>
            <label className="conn-field"><span>Base URL</span>
              <input placeholder="https://gitlab.com" value={gBase} onChange={(e) => { setGBase(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>Project</span>
              <input placeholder="grupo/proyecto o id (opcional)" value={gProject} onChange={(e) => { setGProject(e.target.value); setSaved(false); }} />
            </label>
            <label className="conn-field"><span>Token</span>
              <input type="password" autoComplete="off" placeholder={tokenPlaceholder(cfg.gitlab.hasToken)} value={gToken} onChange={(e) => { setGToken(e.target.value); setSaved(false); }} />
            </label>
            <div className="conn-actions">
              <button className="btn" onClick={() => test("gitlab")} disabled={testing === "gitlab"}>{testing === "gitlab" ? "probando…" : "probar conexión"}</button>
              {gTest && <span className={gTest.ok ? "conn-ok" : "conn-err"}>{gTest.ok ? `✓ ${gTest.detail}` : `✕ ${gTest.error}`}</span>}
            </div>
          </fieldset>
        </div>
      )}

      <div className="modal-foot">
        <span className="muted">{err ? <span className="wf-err">{err}</span> : saved ? "guardado ✓ · usa «probar conexión» para validar" : "guardar aplica en runtime (sin reiniciar)"}</span>
        <button className="btn copy" onClick={save} disabled={busy || !cfg}>
          {busy ? "guardando…" : "💾 guardar conectores"}
        </button>
      </div>
    </div>
  );
}

/** Full-page settings with a left menu; hosts the config sections. */
/** ⚡ Acciones: crear/editar/eliminar acciones custom (data/actions.json), persistido vía PUT /api/actions. */
function ActionsSection({ onSaved }: { onSaved?: () => void }) {
  const [list, setList] = useState<CustomAction[] | null>(null);
  const [sel, setSel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getActions().then((l) => {
      setList(l);
      if (l[0]) setSel(l[0].key);
    });
  }, []);

  const current = list?.find((a) => a.key === sel) ?? null;

  function patch(p: Partial<CustomAction>) {
    setList((l) => l && l.map((a) => (a.key === sel ? { ...a, ...p } : a)));
    setSaved(false);
  }

  function addAction() {
    let key = "accion-nueva";
    let n = 2;
    while ((list ?? []).some((a) => a.key === key)) key = `accion-nueva-${n++}`; // -2, -3, … (rediscover resuelve por registry)
    const a: CustomAction = {
      key,
      label: "Nueva acción",
      icon: "⚡",
      prompt: "",
      stages: [],
      verifyAfter: null,
      inheritWorkflow: true,
      readOnly: false,
      showOn: ["row", "preview"],
    };
    setList((l) => [...(l ?? []), a]);
    setSel(key);
    setSaved(false);
  }

  function removeAction() {
    if (!current) return;
    setList((l) => {
      const next = (l ?? []).filter((a) => a.key !== sel);
      setSel(next[0]?.key ?? "");
      return next;
    });
    setSaved(false);
  }

  async function toggleInherit(on: boolean) {
    if (!on && current && current.stages.length === 0) {
      const def = await getWorkflow(); // sembrar desde el workflow global al desactivar heredar
      patch({ inheritWorkflow: false, stages: def?.stages ?? [], verifyAfter: def?.verifyAfter ?? null });
    } else {
      patch({ inheritWorkflow: on });
    }
  }

  async function save() {
    if (!list) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const updated = await saveActions(list);
      setList(updated);
      if (!updated.some((a) => a.key === sel)) setSel(updated[0]?.key ?? "");
      setSaved(true);
      onSaved?.(); // refresca los botones del tablero
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel-head">
        <div className="drawer-title">⚡ Acciones</div>
        <div className="drawer-sub">botones custom por tarea · prompt + etapas propias o heredadas · se aplica a los próximos lanzamientos</div>
      </header>

      {!list && <div className="empty">cargando…</div>}
      {list && (
        <>
          <div className="prompt-tabs">
            {list.map((a) => (
              <button key={a.key} className={`settings-item ${sel === a.key ? "on" : ""}`} onClick={() => setSel(a.key)}>
                {a.icon} {a.label}
              </button>
            ))}
            <button className="btn add-stage" onClick={addAction}>＋ acción</button>
          </div>

          {list.length === 0 && <div className="empty">sin acciones · crea una con ＋ acción</div>}

          {current && (
            <div className="action-editor">
              <div className="wf-line">
                <select className="wf-icon" value={current.icon} onChange={(e) => patch({ icon: e.target.value })}>
                  {!EMOJI_CHOICES.includes(current.icon) && <option value={current.icon}>{current.icon}</option>}
                  {EMOJI_CHOICES.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
                <input className="wf-label" placeholder="label del botón" value={current.label} onChange={(e) => patch({ label: e.target.value })} />
                <input
                  className="wf-key"
                  placeholder="key (slug único)"
                  value={current.key}
                  onChange={(e) => {
                    // renombrar la key: mover la selección junto con la key, o al re-render
                    // current = list.find(a=>a.key===sel) sería undefined y el editor se desmontaría.
                    const k = e.target.value;
                    setSel(k);
                    patch({ key: k });
                  }}
                />
              </div>

              <textarea
                className="wf-instr prompt-textarea"
                placeholder="prompt de la acción (usa los placeholders de abajo)…"
                value={current.prompt}
                spellCheck={false}
                onChange={(e) => patch({ prompt: e.target.value })}
              />
              <div className="prompt-ph">
                <span className="muted">placeholders:</span>{" "}
                {ACTION_PLACEHOLDERS.map((p) => <code key={p} className="prompt-chip">{p}</code>)}
              </div>

              <label className="action-check">
                <input type="checkbox" checked={current.inheritWorkflow} onChange={(e) => toggleInherit(e.target.checked)} /> heredar workflow global/por-repo
              </label>
              {!current.inheritWorkflow && (
                <StageEditor
                  stages={current.stages}
                  verifyAfter={current.verifyAfter}
                  onStages={(stages) => patch({ stages })}
                  onVerifyAfter={(verifyAfter) => patch({ verifyAfter })}
                />
              )}

              <label className="action-check">
                <input type="checkbox" checked={current.readOnly} onChange={(e) => patch({ readOnly: e.target.checked })} /> read-only (refuérzalo en el prompt)
              </label>
              <div className="action-showon">
                <span className="muted">mostrar en:</span>
                {(["row", "preview"] as const).map((ctx) => (
                  <label key={ctx} className="action-check">
                    <input
                      type="checkbox"
                      checked={current.showOn.includes(ctx)}
                      onChange={(e) =>
                        patch({ showOn: e.target.checked ? [...current.showOn, ctx] : current.showOn.filter((c) => c !== ctx) })
                      }
                    />{" "}
                    {ctx === "row" ? "fila" : "preview"}
                  </label>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="modal-foot">
        <span className="muted">{err ? <span className="wf-err">{err}</span> : saved ? "guardado ✓" : "se aplica a los próximos lanzamientos"}</span>
        <div className="prompt-actions">
          <button className="btn stop" onClick={removeAction} disabled={busy || !current}>🗑 eliminar</button>
          <button className="btn copy" onClick={save} disabled={busy || !list}>{busy ? "guardando…" : "💾 guardar acciones"}</button>
        </div>
      </div>
    </div>
  );
}

function SettingsView({ onBack, onActionsChanged }: { onBack: () => void; onActionsChanged?: () => void }) {
  const [section, setSection] = useState<"repos" | "workflow" | "prompts" | "connectors" | "actions">("repos");
  return (
    <div className="settings">
      <nav className="settings-menu">
        <button className="settings-back" onClick={onBack}>← Tablero</button>
        <div className="settings-menu-title">Configuración</div>
        <button className={`settings-item ${section === "repos" ? "on" : ""}`} onClick={() => setSection("repos")}>📁 Repos</button>
        <button className={`settings-item ${section === "workflow" ? "on" : ""}`} onClick={() => setSection("workflow")}>⚙ Workflows</button>
        <button className={`settings-item ${section === "prompts" ? "on" : ""}`} onClick={() => setSection("prompts")}>✍️ Prompts</button>
        <button className={`settings-item ${section === "actions" ? "on" : ""}`} onClick={() => setSection("actions")}>⚡ Acciones</button>
        <button className={`settings-item ${section === "connectors" ? "on" : ""}`} onClick={() => setSection("connectors")}>🔌 Conectores</button>
      </nav>
      <div className="settings-content">
        {section === "repos" && <ReposSection />}
        {section === "workflow" && <WorkflowsSection />}
        {section === "prompts" && <PromptsSection />}
        {section === "actions" && <ActionsSection onSaved={onActionsChanged} />}
        {section === "connectors" && <ConnectorsSection />}
      </div>
    </div>
  );
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [openWorkerId, setOpenWorkerId] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<"clickup" | "jira" | "gitlab" | "priority" | "hoy">("clickup");
  const [adhocOpen, setAdhocOpen] = useState(false);
  const [adhocText, setAdhocText] = useState("");
  const [adhocBusy, setAdhocBusy] = useState(false);
  const [prOpen, setPrOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [view, setView] = useState<"board" | "settings">("board");
  const [launchFor, setLaunchFor] = useState<Task | null>(null);
  const [previewTask, setPreviewTask] = useState<Task | null>(null);
  const [actions, setActions] = useState<CustomAction[]>([]);
  const refreshActions = () => getActions().then(setActions);
  useEffect(() => { refreshActions(); }, []);
  const [prUrl, setPrUrl] = useState("");
  const [prTaskUrl, setPrTaskUrl] = useState("");
  const [prBusy, setPrBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [fromDate, setFromDate] = useState(todayISO());
  const [toDate, setToDate] = useState(todayISO());
  const [search, setSearch] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const t = localStorage.getItem("cowork-theme");
      return t === "dark" || t === "light" ? t : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("cowork-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => subscribeStream(setSnap, setConnected), []);
  // Ask for notification permission once.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  }, []);
  // Notify when a worker starts needing input (once per transition).
  useEffect(() => {
    const ws = snap?.workers ?? [];
    for (const w of ws) {
      if (w.needsInput && !notifiedRef.current.has(w.id)) {
        notifiedRef.current.add(w.id);
        const task = snap?.tasks.find((t) => t.id === w.taskId);
        try {
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification("⚠ Worker necesita input", { body: `${w.label} · ${task?.title ?? w.taskId}` });
          }
        } catch {
          /* notifications unavailable */
        }
      }
      if (!w.needsInput) notifiedRef.current.delete(w.id);
    }
  }, [snap]);
  // Refresh the activity log while on the "Hoy" tab (events follow state changes).
  useEffect(() => {
    if (sourceTab !== "hoy") return;
    getHistory(dayStartMs(fromDate), dayEndMs(toDate)).then(setHistory);
  }, [sourceTab, snap, fromDate, toDate]);

  function setRange(from: string, to: string) {
    setFromDate(from);
    setToDate(to);
  }

  async function submitAdhoc() {
    if (!adhocText.trim()) return;
    setAdhocBusy(true);
    try {
      await launchAdhoc(adhocText.trim());
      setAdhocText("");
      setAdhocOpen(false);
    } finally {
      setAdhocBusy(false);
    }
  }

  async function submitPr() {
    if (!prUrl.trim()) return;
    setPrBusy(true);
    try {
      await launchPrReview(prUrl.trim(), prTaskUrl.trim());
      setPrUrl("");
      setPrTaskUrl("");
      setPrOpen(false);
    } finally {
      setPrBusy(false);
    }
  }

  async function onTogglePin(t: Task) {
    const pinned = (snap?.pins ?? []).includes(t.id);
    await pinTask(t.id, !pinned);
  }

  // Move a task up/down within its priority group (persists the manual order).
  async function moveInList(list: Task[], idx: number, delta: number) {
    const j = idx + delta;
    if (j < 0 || j >= list.length) return;
    if (list[j].priority !== list[idx].priority) return; // stay within the priority group
    const ids = list.map((t) => t.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await setOrder(ids);
  }
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await refreshTasks();
      setNow(Date.now());
    } finally {
      setRefreshing(false);
    }
  }

  const tasks = snap?.tasks ?? [];
  const workers = snap?.workers ?? [];
  const integrations = snap?.integrations ?? [];

  const isPriorityTab = sourceTab === "priority";
  const inTab = (t: Task) => isPriorityTab || t.source === sourceTab;
  // Order every tab by priority → manual order (▲▼) → creation date.
  ORDER_INDEX = new Map((snap?.order ?? []).map((id, i) => [id, i] as const));
  const sorter = byPriority;
  const counts = {
    clickup: tasks.filter((t) => t.source === "clickup" && isVisible(t)).length,
    jira: tasks.filter((t) => t.source === "jira" && isVisible(t)).length,
    gitlab: tasks.filter((t) => t.source === "gitlab" && isVisible(t)).length,
    priority: tasks.filter((t) => (t.priority ?? "none") !== "none" && isVisible(t)).length,
  };
  const q = search.trim().toLowerCase();
  const matchSearch = (t: Task) => !q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q);
  const active = [...tasks]
    .filter((t) => t.status !== "done" && inTab(t) && matchSearch(t) && isVisible(t))
    .sort(sorter);
  const done = [...tasks]
    .filter((t) => t.status === "done" && inTab(t) && matchSearch(t) && isVisible(t))
    .sort(sorter);
  const openWorker = openWorkerId ? workers.find((w) => w.id === openWorkerId) : undefined;
  const openTask = openWorker ? tasks.find((t) => t.id === openWorker.taskId) : undefined;

  return (
    <div className="app">
      <header className="bar">
        <div className="dots">
          <span className="dot red" />
          <span className="dot amber" />
          <span className="dot green" />
        </div>
        <span className="brand-logo" role="img" aria-label="LKMX" />
        <span className="brand">Ronin</span>
        <span className="sub">· tablero local de tareas</span>
        <span className={`conn ${connected ? "on" : "off"}`}>
          {connected ? "● en vivo" : "○ reconectando…"}
        </span>
        {snap && <span className={`src ${snap.taskSource}`}>{SOURCE_LABEL[snap.taskSource]}</span>}
        <span className="synced" title="última actualización del tablero">
          {agoLabel(snap?.lastSync ?? null, now)}
        </span>
        <button className={`refresh ${refreshing ? "spin" : ""}`} onClick={onRefresh} disabled={refreshing} title="actualizar tareas">
          ↻
        </button>
        <button
          className="refresh"
          onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          title={theme === "light" ? "cambiar a tema oscuro" : "cambiar a tema claro"}
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>
        <button className="refresh wf-btn" onClick={() => setView("settings")} title="configuración (repos, workflows)">
          ⚙
        </button>
        <span className="mode">{snap?.mode === "live" ? "LIVE" : "SIMULADO"}</span>
      </header>

      {view === "settings" ? (
        <SettingsView onBack={() => setView("board")} onActionsChanged={refreshActions} />
      ) : (
        <>
      <main className="body">
        <section className="col tasks">
          <div className="toprow">
          <input
            className="search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            placeholder="filtrar por id / número (ej. 86e20 · PW-738) o texto…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
            <button className="adhoc-btn" onClick={() => setAdhocOpen(true)} title="lanzar una tarea ad-hoc (DM/mención)">
              ✦ Ad-hoc
            </button>
            <button className="adhoc-btn pr" onClick={() => setPrOpen(true)} title="revisar un PR">
              ⎇ PR
            </button>
            <button className="adhoc-btn" onClick={() => setCustomOpen(true)} title="petición personal con workflow loop confirmable">
              ✎ Petición
            </button>
          </div>
          <div className="tabs">
            <button className={`tab ${sourceTab === "clickup" ? "on" : ""}`} onClick={() => setSourceTab("clickup")}>
              <span className="srcbadge clickup">CU</span> ClickUp <span className="tab-count">{counts.clickup}</span>
            </button>
            <button className={`tab ${sourceTab === "jira" ? "on" : ""}`} onClick={() => setSourceTab("jira")}>
              <span className="srcbadge jira">JIRA</span> Jira <span className="tab-count">{counts.jira}</span>
            </button>
            <button className={`tab ${sourceTab === "gitlab" ? "on" : ""}`} onClick={() => setSourceTab("gitlab")}>
              <span className="srcbadge gitlab">GL</span> GitLab <span className="tab-count">{counts.gitlab}</span>
            </button>
            <button className={`tab ${sourceTab === "priority" ? "on" : ""}`} onClick={() => setSourceTab("priority")}>
              ⚑ Prioridad <span className="tab-count">{counts.priority}</span>
            </button>
            <button className={`tab ${sourceTab === "hoy" ? "on" : ""}`} onClick={() => setSourceTab("hoy")}>
              📅 Hoy
            </button>
          </div>
          {sourceTab === "hoy" ? (
            <HoyView
              tasks={tasks.filter((t) => matchSearch(t) && isVisible(t))}
              pins={snap?.pins ?? []}
              actions={actions}
              history={history}
              onTogglePin={onTogglePin}
              onLaunch={setLaunchFor}
              onPreview={setPreviewTask}
              fromDate={fromDate}
              toDate={toDate}
              setRange={setRange}
            />
          ) : (
            <>
              {active.length === 0 && <div className="empty">sin tareas activas</div>}
              {active.map((t, i) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  pinned={(snap?.pins ?? []).includes(t.id)}
                  actions={actions}
                  onTogglePin={() => onTogglePin(t)}
                  onMoveUp={() => moveInList(active, i, -1)}
                  onMoveDown={() => moveInList(active, i, 1)}
                  onLaunch={setLaunchFor}
                  onPreview={setPreviewTask}
                />
              ))}
              {done.length > 0 && (
                <>
                  <h3 className="done-h">completadas ({done.length})</h3>
                  {done.map((t) => (
                    <TaskRow key={t.id} task={t} pinned={(snap?.pins ?? []).includes(t.id)} actions={actions} onTogglePin={() => onTogglePin(t)} onLaunch={setLaunchFor} onPreview={setPreviewTask} />
                  ))}
                </>
              )}
            </>
          )}
        </section>

        <aside className="col side">
          <h2>▸ EN EJECUCIÓN</h2>
          {workers.length === 0 && <div className="empty">sin tareas en ejecución</div>}
          {workers.map((w) => (
            <WorkerRow key={w.id} worker={w} task={tasks.find((t) => t.id === w.taskId)} actions={actions} onOpen={() => setOpenWorkerId(w.id)} />
          ))}

          <h2 className="mt">▸ INTEGRACIONES</h2>
          {integrations.map((i) => (
            <div key={i.name} className="row">
              <span className="iname">{i.name}</span>
              <span className={`pill ${i.status === "connected" ? "run" : i.status === "pilot" ? "wait" : "idle"}`}>
                {i.status === "connected" ? "● conectado" : i.status === "pilot" ? "◐ piloto" : "○ roadmap"}
              </span>
            </div>
          ))}
        </aside>
      </main>

      <footer className="foot">
        Fase 4 · {workers.length} worker(s) · {active.length} tarea(s) activa(s)
      </footer>
        </>
      )}

      {openWorker && (
        <TaskDetailWindow worker={openWorker} task={openTask} stages={snap?.stages} onClose={() => setOpenWorkerId(null)} />
      )}

      {launchFor && <LaunchModal task={launchFor} onClose={() => setLaunchFor(null)} />}

      {previewTask && (
        <TaskPreviewModal task={previewTask} actions={actions} onClose={() => setPreviewTask(null)} onLaunch={setLaunchFor} />
      )}

      {customOpen && (
        <CustomRequestModal
          onClose={() => setCustomOpen(false)}
          onLaunched={() => setSourceTab("priority")}
        />
      )}


      {adhocOpen && (
        <div className="modal-backdrop" onClick={() => setAdhocOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="drawer-head">
              <div>
                <div className="drawer-title">✦ Tarea ad-hoc</div>
                <div className="drawer-sub">pega el DM/mención o la pregunta · worker simple (sin /tmux-worker-loop) · output = la respuesta</div>
              </div>
              <button className="drawer-close" onClick={() => setAdhocOpen(false)}>✕</button>
            </header>
            <textarea
              className="adhoc-input"
              autoFocus
              placeholder={"Ej: David me preguntó cómo asociar unos CFDIs de un RFC ya descargado con una cuenta para que aparezcan en otro business. ¿Tienes un script? Lo corro en la DB de dev…"}
              value={adhocText}
              onChange={(e) => setAdhocText(e.target.value)}
            />
            <div className="modal-foot">
              <span className="muted">Corre en el monorepo (KB + todos los servicios). El resultado aparece en el drawer del worker.</span>
              <button className="btn copy" onClick={submitAdhoc} disabled={adhocBusy || !adhocText.trim()}>
                {adhocBusy ? "lanzando…" : "▷ lanzar ad-hoc"}
              </button>
            </div>
          </div>
        </div>
      )}

      {prOpen && (
        <div className="modal-backdrop" onClick={() => setPrOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <header className="drawer-head">
              <div>
                <div className="drawer-title">⎇ PR review</div>
                <div className="drawer-sub">verifica el PR contra la tarea · tras tu merge + "ya mergeé", corre curl en dev</div>
              </div>
              <button className="drawer-close" onClick={() => setPrOpen(false)}>✕</button>
            </header>
            <input
              className="search"
              type="url"
              autoComplete="off"
              placeholder="URL del PR (ej. https://github.com/.../pull/1503)"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
            />
            <input
              className="search"
              type="url"
              autoComplete="off"
              placeholder="URL de la tarea/objetivo (opcional, ej. ClickUp)"
              value={prTaskUrl}
              onChange={(e) => setPrTaskUrl(e.target.value)}
            />
            <div className="modal-foot">
              <span className="muted">El worker hace checkout del branch y verifica; NO mergea. Tú mergeas y le respondes para seguir con curl.</span>
              <button className="btn copy" onClick={submitPr} disabled={prBusy || !prUrl.trim()}>
                {prBusy ? "lanzando…" : "▷ revisar PR"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
