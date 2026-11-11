import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "./journal.js";
import { createPerfRecorder, type RecorderDeps } from "./recorder.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "perf-r-"));
  let clock = new Date(2026, 10, 11, 10).getTime();
  const journal = createJournal(dir, () => clock);
  const sentinels: Record<string, number> = { planning: clock - 3600_000 };
  const live = new Set(["cowork-a"]);
  const pidsSeen: Array<Map<string, number[]>> = [];
  const deps: RecorderDeps = {
    journal,
    listCycleSessions: () => ["cowork-a", "cowork-term"],
    readLaunch: (s) => (s === "cowork-a" ? { mode: "workflow", repo: "monorepo", workflowId: "wf-1", workflowName: "claude-plan-codex-impl", createdAt: clock - 7200_000 } : { mode: "terminal" }),
    stageKeys: () => ["planning", "implementing", "pre-merge"],
    sentinelAt: (_s, k) => sentinels[k] ?? null,
    verifyState: (_s, k) => (k === "pre-merge" ? { status: "failed", attempts: 1, durationMs: 1000, at: clock - 60_000 } : { status: "passed", attempts: 0 }),
    liveSessions: async () => live,
    sample: async (g) => {
      pidsSeen.push(new Map(g));
      return { load1: 3, cores: 14, freeMemMb: 100, swapUsedMb: 10, swapTotalMb: 20, sessions: { "cowork-a": { cpu: 50, rssMb: 300 }, otra: { cpu: 1, rssMb: 1 } } };
    },
    now: () => clock,
  };
  return { dir, deps, journal, sentinels, live, pidsSeen, advance: (ms: number) => (clock += ms), clock: () => clock };
}

test("recorder: lanzamiento + volcado inicial + sentinelas, sin terminales ni sesiones ajenas en la muestra", async () => {
  const f = fixture();
  const r = createPerfRecorder(f.deps);
  await r.tick();
  const evs = f.journal.read(0);
  assert.deepEqual(evs.map((e) => e.type), ["launch", "gate", "stage", "sample"]);
  const gate = evs[1] as any;
  assert.equal(gate.ran, true);
  assert.equal(gate.endedAt - gate.startedAt, 1000);
  const sample = evs[3] as any;
  assert.deepEqual(Object.keys(sample.sessions), ["cowork-a"]);
});

test("recorder: sólo anota sentinelas que cambian; cierre cuando la sesión deja tmux; no duplica al reiniciar", async () => {
  const f = fixture();
  const r = createPerfRecorder(f.deps);
  await r.tick();
  f.advance(60_000);
  f.sentinels.implementing = f.clock() - 1000;
  await r.tick();
  const stages = () => f.journal.read(0).filter((e) => e.type === "stage").map((e: any) => e.stage);
  assert.deepEqual(stages(), ["planning", "implementing"]);

  // Re-tocar planning (volver a una etapa) es una visita nueva.
  f.advance(60_000);
  f.sentinels.planning = f.clock() - 10;
  f.live.delete("cowork-a");
  await r.tick();
  assert.deepEqual(stages(), ["planning", "implementing", "planning"]);
  assert.equal(f.journal.read(0).filter((e) => e.type === "close").length, 1);

  // Un recorder nuevo (reinicio) relee el diario: nada se repite.
  const before = f.journal.read(0).filter((e) => e.type !== "sample").length;
  await createPerfRecorder(f.deps).tick();
  assert.equal(f.journal.read(0).filter((e) => e.type !== "sample").length, before);
});

test("recorder: gates del driver con dedupe y pids de gate a la muestra", async () => {
  const f = fixture();
  const r = createPerfRecorder(f.deps);
  r.onGateSpawn("cowork-a", 4242);
  const g = { session: "cowork-a", stage: "pre-merge", status: "passed", attempts: 1, ran: true, startedAt: 1, endedAt: 2 };
  r.onGateOutcome(g);
  r.onGateOutcome(g);
  await r.tick();
  assert.deepEqual(f.pidsSeen[0]!.get("cowork-a"), [4242]);
  r.onGateExit("cowork-a", 4242);
  await r.tick();
  assert.equal(f.pidsSeen[1]!.has("cowork-a"), false);
  assert.equal(f.journal.read(0).filter((e) => e.type === "gate" && (e as any).endedAt === 2).length, 1);
});

test("recorder: tmux ilegible no cierra nada", async () => {
  const f = fixture();
  f.deps.liveSessions = async () => null;
  await createPerfRecorder(f.deps).tick();
  assert.equal(f.journal.read(0).filter((e) => e.type === "close").length, 0);
});

test("recorder: una sesión ya cerrada al arrancar cierra en su última actividad; una vista viva, en el momento", async () => {
  const f = fixture();
  f.live.delete("cowork-a");
  await createPerfRecorder(f.deps).tick();
  const close = f.journal.read(0).find((e) => e.type === "close") as any;
  assert.equal(close.at, f.clock() - 60_000); // el gate del volcado es lo último (planning fue hace 1 h)

  const g = fixture();
  const r = createPerfRecorder(g.deps);
  await r.tick();
  g.advance(5 * 60_000);
  g.live.delete("cowork-a");
  await r.tick();
  assert.equal((g.journal.read(0).find((e) => e.type === "close") as any).at, g.clock());
});
