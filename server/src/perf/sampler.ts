import { execFile } from "node:child_process";
import { cpus, freemem, loadavg } from "node:os";
import { promisify } from "node:util";
import type { SessionSample } from "./journal.js";

const run = promisify(execFile);

export interface Proc { pid: number; ppid: number; cpu: number; rssKb: number }

/** Salida de `ps -A -o pid=,ppid=,pcpu=,rss=`. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)$/);
    if (m) procs.push({ pid: +m[1]!, ppid: +m[2]!, cpu: +m[3]!, rssKb: +m[4]! });
  }
  return procs;
}

/** `vm.swapusage` de macOS: «total = 31744.00M  used = 30679.50M  free = …». */
export function parseSwap(out: string): { usedMb: number; totalMb: number } | null {
  const total = out.match(/total = ([\d.]+)M/);
  const used = out.match(/used = ([\d.]+)M/);
  return total && used ? { totalMb: +total[1]!, usedMb: +used[1]! } : null;
}

/** `tmux list-panes -a -F '#{session_name}\t#{pane_pid}'` → sesión → pids raíz. */
export function parsePanes(out: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const line of out.split("\n")) {
    const [name, pid] = line.split("\t");
    if (!name || !pid || !/^\d+$/.test(pid.trim())) continue;
    map.set(name, [...(map.get(name) ?? []), +pid.trim()]);
  }
  return map;
}

/**
 * CPU (% de un núcleo, puede pasar de 100) y RSS de los árboles de procesos de cada sesión: sus
 * panes de tmux más los gates que Ronin le corrió. Un pid se cuenta una sola vez, para la primera
 * sesión que lo reclama.
 */
export function sumTrees(procs: Proc[], roots: Map<string, number[]>): Record<string, SessionSample> {
  const children = new Map<number, Proc[]>();
  const byPid = new Map<number, Proc>();
  for (const p of procs) {
    byPid.set(p.pid, p);
    children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  }
  const claimed = new Set<number>();
  const out: Record<string, SessionSample> = {};
  for (const [session, pids] of roots) {
    let cpu = 0;
    let rssKb = 0;
    const stack = pids.filter((pid) => byPid.has(pid));
    while (stack.length) {
      const pid = stack.pop()!;
      if (claimed.has(pid)) continue;
      claimed.add(pid);
      const p = byPid.get(pid)!;
      cpu += p.cpu;
      rssKb += p.rssKb;
      for (const c of children.get(pid) ?? []) stack.push(c.pid);
    }
    out[session] = { cpu: Math.round(cpu * 10) / 10, rssMb: Math.round(rssKb / 1024) };
  }
  return out;
}

export interface MachineSample {
  load1: number;
  cores: number;
  freeMemMb: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  sessions: Record<string, SessionSample>;
}

/** Muestra real. Cualquier fallo de ps/tmux/sysctl deja ese dato fuera, nunca lanza. */
export async function sampleMachine(gatePids: Map<string, number[]>): Promise<MachineSample> {
  const base: MachineSample = {
    load1: Math.round(loadavg()[0]! * 100) / 100,
    cores: cpus().length,
    freeMemMb: Math.round(freemem() / 1048576),
    sessions: {},
  };
  try {
    const swap = parseSwap((await run("sysctl", ["-n", "vm.swapusage"])).stdout);
    if (swap) Object.assign(base, { swapUsedMb: swap.usedMb, swapTotalMb: swap.totalMb });
  } catch {
    /* no macOS */
  }
  try {
    const [ps, panes] = await Promise.all([
      run("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss="], { maxBuffer: 8 * 1024 * 1024 }),
      run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]).catch(() => ({ stdout: "" })),
    ]);
    const roots = parsePanes(panes.stdout);
    for (const [session, pids] of gatePids) roots.set(session, [...(roots.get(session) ?? []), ...pids]);
    base.sessions = sumTrees(parsePs(ps.stdout), roots);
  } catch {
    /* sin ps: sólo la parte de máquina */
  }
  return base;
}
