import type { TestRun } from "../../types";

export interface HeatCell {
  date: string;
  count: number;
  status: "none" | "passed" | "failed" | "error";
}

export interface HeatRow {
  repo: string;
  configured: boolean;
  cells: HeatCell[];
  total: number;
}

type Verdict = Exclude<HeatCell["status"], "none">;

const verdictRank: Record<Verdict, number> = { passed: 1, failed: 2, error: 3 };

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function verdictFor(status: TestRun["status"]): Verdict | null {
  if (status === "passed" || status === "failed" || status === "error") return status;
  // El timeout es terminal y la matriz ya lo representa con el tono de fallo.
  if (status === "timeout") return "failed";
  return null;
}

export function buildHeatmap(
  runs: TestRun[],
  repos: { repo: string; configured: boolean }[],
  opts: { days: number; today: Date },
): HeatRow[] {
  if (opts.days <= 0) return repos.map(({ repo, configured }) => ({ repo, configured, cells: [], total: 0 }));

  const lastDay = startOfLocalDay(opts.today);
  const firstDay = new Date(lastDay);
  firstDay.setDate(firstDay.getDate() - opts.days + 1);
  const cells = Array.from({ length: opts.days }, (_, index) => {
    const day = new Date(firstDay);
    day.setDate(day.getDate() + index);
    return { date: localDate(day), count: 0, status: "none" as const };
  });
  const dayIndex = new Map(cells.map((cell, index) => [cell.date, index]));
  const rows: HeatRow[] = repos.map(({ repo, configured }) => ({
    repo,
    configured,
    cells: cells.map((cell) => ({ ...cell })),
    total: 0,
  }));
  const rowIndex = new Map(rows.map((row, index) => [row.repo, index]));

  for (const run of runs) {
    const verdict = verdictFor(run.status);
    const date = new Date(run.createdAt);
    const row = rowIndex.get(run.repo);
    const cellIndex = Number.isNaN(date.getTime()) ? undefined : dayIndex.get(localDate(date));
    if (!verdict || row === undefined || cellIndex === undefined) continue;

    const cell = rows[row].cells[cellIndex];
    cell.count += 1;
    rows[row].total += 1;
    if (cell.status === "none" || verdictRank[verdict] > verdictRank[cell.status]) cell.status = verdict;
  }

  return rows;
}

export function monthSpans(days: number, today: Date): { label: string; days: number }[] {
  if (days <= 0) return [];

  const spans: { label: string; days: number }[] = [];
  let remaining = days;
  let cursor = startOfLocalDay(today);

  while (remaining > 0) {
    const spanDays = Math.min(remaining, cursor.getDate());
    spans.unshift({
      label: cursor.toLocaleDateString("es-MX", { month: "short" }),
      days: spanDays,
    });
    remaining -= spanDays;
    cursor.setDate(cursor.getDate() - spanDays);
  }

  return spans;
}
