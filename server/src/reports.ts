import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory } from "./history.js";
import { commitsFor, type Commit } from "./report-git.js";
import { findCycleEvidence } from "./report-worker.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPORTS_DIR = join(here, "..", "data", "reports");

export type ReportKind = "daily" | "weekly";
// A-Z incluido: reportName emite `weekly-YYYY-W27` (W mayúscula). Excluye . / \ → anti path-traversal intacto.
const NAME_RE = /^[A-Za-z0-9-]+$/;

/** Error de validación del cliente (fecha/name inválidos) → la ruta lo mapea a 400. */
export class BadRequest extends Error {}

// ---- fechas locales (evita bugs UTC/DST) ----
function parseRefDay(ref?: string): Date {
  if (!ref) { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ref).trim());
  if (!m) throw new BadRequest(`fecha inválida: ${ref}`);
  const [, y, mo, d] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d));
  if (dt.getFullYear() !== +y || dt.getMonth() !== +mo - 1 || dt.getDate() !== +d)
    throw new BadRequest(`fecha inválida: ${ref}`); // rechaza 2026-02-31
  return dt;
}
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Semana ISO (anclada a jueves) de una fecha local. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (t.getDay() + 6) % 7;                 // Lun=0..Dom=6
  t.setDate(t.getDate() - dow + 3);                 // jueves de esta semana
  const isoYear = t.getFullYear();
  const week1Thu = new Date(isoYear, 0, 4);
  const w1dow = (week1Thu.getDay() + 6) % 7;
  const firstThu = new Date(isoYear, 0, 4 - w1dow + 3);
  const week = 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 864e5));
  return { year: isoYear, week };
}
export function windowFor(kind: ReportKind, ref?: string): [Date, Date] {
  const day = parseRefDay(ref);
  if (kind === "daily") return [day, addDays(day, 1)];
  const back = (day.getDay() + 6) % 7;              // días desde el lunes más reciente
  const mon = addDays(day, -back);
  return [mon, addDays(mon, 7)];
}
export function reportName(kind: ReportKind, from: Date): string {
  if (kind === "daily") return `daily-${isoDate(from)}`;
  const { year, week } = isoWeek(from);
  return `weekly-${year}-W${String(week).padStart(2, "0")}`;
}

// ---- tareas trabajadas desde history ----
interface WorkedTask { key: string; title: string; source: string; repo: string; body?: string; evidence?: string; }
function tasksInWindow(from: Date, to: Date): { done: WorkedTask[]; wip: WorkedTask[]; repos: string[] } {
  const evs = readHistory(from.getTime(), to.getTime());
  const completed = new Map<string, WorkedTask>();       // key → última completada
  const touched = new Map<string, WorkedTask>();         // key → launch/stop
  for (const e of evs) {                                 // readHistory viene newest-first
    const t: WorkedTask = { key: e.key, title: e.title, source: e.source, repo: e.repo, body: e.body, evidence: e.evidence };
    if (e.type === "complete") { if (!completed.has(e.key)) completed.set(e.key, t); }
    else if (!touched.has(e.key)) touched.set(e.key, t);
  }
  const done = [...completed.values()];
  const wip = [...touched.values()].filter((t) => !completed.has(t.key)); // tocada sin completar
  const repos = [...new Set([...done, ...wip].map((t) => t.repo).filter(Boolean))];
  return { done, wip, repos };
}

// ---- prompt + extracción ----
function periodLabel(kind: ReportKind, from: Date, to: Date): string {
  if (kind === "daily") return isoDate(from);
  return `${isoDate(from)} → ${isoDate(addDays(to, -1))}`; // semana inclusiva
}
const EV_CAP = 3000;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
function doneBlock(t: WorkedTask): string {
  const head = `- [${t.key}] ${t.title} (repo=${t.repo}, source=${t.source})`;
  const body = t.body ? `\n  disparador: ${oneLine(t.body).slice(0, 500)}` : "";
  const ev = t.evidence ? `\n  evidencia:\n\`\`\`\n${t.evidence.slice(0, EV_CAP)}\n\`\`\`` : "";
  return head + body + ev;
}
function buildPrompt(period: string, done: WorkedTask[], wip: WorkedTask[], commits: Record<string, Commit[]>): string {
  const doneLines = done.map(doneBlock).join("\n") || "(ninguna)";
  const wipLines = wip.map((t) => `- [${t.key}] ${t.title}` + (t.body ? `\n  disparador: ${oneLine(t.body).slice(0, 300)}` : "")).join("\n") || "(ninguna)";
  const commitBlock = Object.entries(commits)
    .map(([repo, cs]) => `### ${repo}\n` + cs.map((c) => `- ${c.hash} ${c.subject} — ${c.author}`).join("\n"))
    .join("\n\n") || "(sin commits)";
  return [
    `Eres un asistente que redacta un reporte de trabajo en ESPAÑOL para el periodo ${period}.`,
    `Recibes TAREAS COMPLETADAS (con su disparador y, si existe, la EVIDENCIA real del worker: diagnóstico/corrección/curl), TAREAS EN PROGRESO y COMMITS por repo.`,
    `Atribuye el/los commit(s) a cada tarea completada por el key o por similitud del asunto.`,
    `Por cada tarea COMPLETADA:`,
    `  1) UNA línea de síntesis de "lo que se hizo": PRIORIZA la evidencia y el disparador sobre el título crudo (los títulos ad-hoc/custom como "Si" son sólo el disparador, no describen el trabajo). Apta para leer en un daily/weekly.`,
    `  2) Debajo, un detalle expandible con un extracto FIEL de la evidencia (condensa, NO inventes); si no hay evidencia, OMITE el detalle.`,
    ``,
    `Para TAREAS EN PROGRESO usa el disparador para dar contexto (que un título "Si" no quede huérfano).`,
    ``,
    `Devuelve SOLO markdown entre <REPORT> y </REPORT>, con este formato:`,
    `# Reporte ${period}`,
    `## Resumen`,
    `<una frase + conteo: N completadas, M en progreso>`,
    `## Completadas`,
    `- **[key] <título legible o resumen del disparador>** — <síntesis 1 línea>`,
    `  <details><summary>detalle</summary>`,
    ``,
    `  <extracto condensado de la evidencia></details>`,
    `## En progreso`,
    `- **[key] <resumen del disparador>**`,
    ``,
    `## TAREAS COMPLETADAS\n${doneLines}`,
    `\n## TAREAS EN PROGRESO\n${wipLines}`,
    `\n## COMMITS POR REPO\n${commitBlock}`,
  ].join("\n");
}
/**
 * Ejecuta `claude -p` con el prompt por STDIN (no por argv) para evitar E2BIG en periodos
 * cargados: el prompt puede pesar cientos de KB y ARG_MAX en macOS ronda 1MB. timeout + cap de salida.
 */
function runClaudeP(input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const MAX = 4 << 20;
    const child = spawn("claude", ["-p"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => done(() => { child.kill("SIGTERM"); reject(new Error("claude -p excedió el tiempo límite")); }), 120000);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > MAX) done(() => { child.kill("SIGTERM"); reject(new Error("claude -p excedió el límite de salida")); });
    });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => done(() => reject(e))); // p.ej. claude no está en PATH (ENOENT)
    child.on("close", (code) => done(() => {
      if (code !== 0) return reject(new Error(`claude -p salió con código ${code}: ${stderr.trim().slice(0, 200)}`));
      resolve(stdout);
    }));
    child.stdin.on("error", () => { /* EPIPE si el proceso muere antes de leer stdin */ });
    child.stdin.end(input);
  });
}

function extractReport(stdout: string): string {
  const m = stdout.match(/<REPORT>([\s\S]*?)<\/REPORT>/i);
  if (m && m[1].trim()) return m[1].trim();
  // abierto sin cerrar: solo se acepta si el cuerpo trae el encabezado `# Reporte`
  // (evita escribir un preámbulo truncado como si fuera el reporte).
  const open = stdout.match(/<REPORT>([\s\S]*)$/i);
  if (open && /(^|\n)#\s*Reporte\b/i.test(open[1])) return open[1].trim();
  throw new Error("claude no devolvió el reporte entre <REPORT>…</REPORT>");
}

function safeName(name: unknown): string {
  if (typeof name !== "string" || name.length > 64 || !NAME_RE.test(name))
    throw new BadRequest("nombre de reporte inválido");
  return name;
}
function emptyReport(period: string): string {
  return `# Reporte ${period}\n\n## Resumen\nSin tareas trabajadas en el periodo.\n`;
}

// ---- API pública ----
export async function generateReport(kind: ReportKind, ref?: string): Promise<{ name: string; markdown: string; path: string }> {
  const [from, to] = windowFor(kind, ref);           // lanza BadRequest → 400 si ref inválido
  const name = reportName(kind, from);
  const period = periodLabel(kind, from, to);
  const { done, wip, repos } = tasksInWindow(from, to);
  for (const t of done) if (!t.evidence) {           // eventos viejos: evidencia desde /tmp si el cycle sigue
    const e = findCycleEvidence(t.key);
    if (e) t.evidence = e;
  }

  let markdown: string;
  if (done.length === 0 && wip.length === 0) {
    markdown = emptyReport(period);                  // sin tareas → válido, sin llamar a claude
  } else {
    const commits = await commitsFor(repos, from, to);
    const prompt = buildPrompt(period, done, wip, commits);
    const stdout = await runClaudeP(prompt);         // falla → throw → 500
    if (!stdout.trim()) throw new Error("claude devolvió salida vacía");
    markdown = extractReport(stdout);
  }
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, `${safeName(name)}.md`);
  writeFileSync(path, markdown.endsWith("\n") ? markdown : markdown + "\n");
  return { name, markdown, path };
}

export interface ReportMeta { name: string; kind: ReportKind; date: string; ts: number; size: number; }
export function listReports(): ReportMeta[] {
  let files: string[] = [];
  try { files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".md")); } catch { return []; }
  const metas = files.map((f) => {
    const name = f.slice(0, -3);
    const kind: ReportKind = name.startsWith("weekly-") ? "weekly" : "daily";
    const date = name.replace(/^(daily|weekly)-/, "");
    let ts = 0, size = 0;
    try { const st = statSync(join(REPORTS_DIR, f)); ts = st.mtimeMs; size = st.size; } catch { /* ignore */ }
    return { name, kind, date, ts, size };
  });
  return metas.sort((a, b) => b.ts - a.ts); // más nuevo primero
}
export function readReport(name: string): { name: string; markdown: string } | null {
  const safe = safeName(name);                       // lanza BadRequest → 400
  try {
    const markdown = readFileSync(join(REPORTS_DIR, `${safe}.md`), "utf8");
    return { name: safe, markdown };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // no existe → 404
    throw e;                                          // EACCES/EIO en archivo existente → 500
  }
}
