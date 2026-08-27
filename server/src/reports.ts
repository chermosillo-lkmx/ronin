import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaudeP } from "./claude-p.js";
import { dataPath } from "./data-dir.js";
import { readHistory } from "./history.js";
import { commitsFor, type Commit } from "./report-git.js";
import { listRepos } from "./repos.js";
import { cycleDirForSession, readEvidence } from "./stages.js";

export const REPORTS_DIR = dataPath("reports");
export type ReportKind = "daily" | "weekly";
export class BadRequest extends Error {}
const NAME_RE = /^[A-Za-z0-9-]+$/;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function windowFor(kind: ReportKind, ref?: string): [Date, Date] {
  const day = ref ? new Date(`${ref}T00:00:00`) : new Date();
  if (Number.isNaN(day.getTime())) throw new BadRequest(`fecha inválida: ${ref}`);
  day.setHours(0, 0, 0, 0);
  if (kind === "daily") return [day, new Date(day.getTime() + 86400000)];
  const monday = new Date(day); monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return [monday, new Date(monday.getTime() + 7 * 86400000)];
}
export function reportName(kind: ReportKind, from: Date): string { return `${kind}-${iso(from)}`; }
export function buildPrompt(period: string, sessions: ReturnType<typeof readHistory>, commits: Record<string, Commit[]>): string {
  const worked = sessions.filter((event) => event.type === "launch").map((event) => {
    const evidence = readEvidence(cycleDirForSession(event.key)).summary ?? event.evidence ?? "";
    return `- ${event.key} (repo=${event.repo})\n  petición: ${event.request ?? event.title}\n  evidencia: ${evidence || "(sin evidencia)"}`;
  }).join("\n") || "(ninguna)";
  const git = Object.entries(commits).map(([repo, rows]) => `### ${repo}\n${rows.map((c) => `- ${c.hash} ${c.subject}`).join("\n")}`).join("\n") || "(sin commits)";
  return `Redacta en español un reporte markdown del periodo ${period}.\n\n## Sesiones trabajadas\n${worked}\n\n## Commits por repo\n${git}\n\nDevuelve sólo <REPORT>markdown</REPORT>.`;
}
export async function generateReport(kind: ReportKind, ref?: string) {
  const [from, to] = windowFor(kind, ref); const sessions = readHistory(from.getTime(), to.getTime());
  const prompt = buildPrompt(`${iso(from)} → ${iso(new Date(to.getTime() - 1))}`, sessions, await commitsFor(listRepos(), from, to));
  const output = await runClaudeP(prompt); const markdown = output.match(/<REPORT>([\s\S]*?)<\/REPORT>/i)?.[1]?.trim() || `# Reporte ${iso(from)}\n\nSin sesiones trabajadas.\n`;
  const name = reportName(kind, from); mkdirSync(REPORTS_DIR, { recursive: true }); const path = join(REPORTS_DIR, `${name}.md`); writeFileSync(path, markdown + "\n"); return { name, markdown, path };
}
export interface ReportMeta { name: string; kind: ReportKind; date: string; ts: number; size: number; }
export function listReports(): ReportMeta[] { try { return readdirSync(REPORTS_DIR).filter((f) => f.endsWith(".md")).map((f) => { const s = statSync(join(REPORTS_DIR, f)); return { name: f.slice(0, -3), kind: f.startsWith("weekly-") ? "weekly" : "daily", date: f.slice(6, -3), ts: s.mtimeMs, size: s.size }; }); } catch { return []; } }
export function readReport(name: string) { if (!NAME_RE.test(name)) throw new BadRequest("nombre de reporte inválido"); try { return { name, markdown: readFileSync(join(REPORTS_DIR, `${name}.md`), "utf8") }; } catch { return null; } }
