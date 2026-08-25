import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAnalyzer } from "./analyzer.js";
import type { AnalysisRange } from "./model.js";
import { createProposalStore, type ProposalStore } from "./store.js";
import type { Signals } from "./signals.js";

const range: AnalysisRange = { from: new Date("2026-08-10T00:00:00Z"), to: new Date("2026-08-24T00:00:00Z") };

const SIGNALS: Signals = {
  range: { from: range.from.toISOString(), to: range.to.toISOString() },
  tasks: [
    { key: "CU-1", title: "Hotfix login", source: "clickup", repo: "ronin", launches: 2, stops: 1, completes: 1, firstTs: 1, lastTs: 2 },
    { key: "CU-2", title: "Hotfix pagos", source: "clickup", repo: "web", launches: 1, stops: 0, completes: 1, firstTs: 3, lastTs: 4 },
  ],
  commits: {
    ronin: [
      { hash: "aaa1111", subject: "fix: login", ts: 10 },
      { hash: "bbb2222", subject: "fix: sesión", ts: 11 },
    ],
    web: [{ hash: "ccc3333", subject: "fix: pagos", ts: 12 }],
  },
  evidence: [{ repo: "ronin", file: "EVIDENCIA-CU-1.md", mtime: 20, excerpt: "hotfix verificado" }],
};

const VALID_STAGES = [
  { key: "planning", label: "Plan", icon: "📋" },
  { key: "implementing", label: "Impl", icon: "⌨️", role: "impl" },
];

function wrap(proposals: unknown[]): string {
  return `ruido previo\n<PROPOSALS>${JSON.stringify({ proposals })}</PROPOSALS>\nruido posterior`;
}

async function withStore(fn: (store: ProposalStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ronin-workflow-analyzer-"));
  try {
    await fn(createProposalStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a valid response yields proposed proposals and a done analysis with counts", async () => {
  await withStore(async (store) => {
    const runClaude = async () =>
      `<PROPOSALS>${JSON.stringify({
        proposals: [
          {
            name: "Hotfix Rápido",
            rationale: "r",
            evidence: ["CU-1"],
            config: { stages: VALID_STAGES, verifyAfter: null },
          },
        ],
      })}</PROPOSALS>`;
    const analyzer = createAnalyzer({ store, signals: async () => SIGNALS, catalogNames: () => ["default"], runClaude });
    const id = analyzer.start(range);
    assert.equal(store.getAnalysis(id)?.status, "running");
    await analyzer.waitFor(id);
    const a = store.getAnalysis(id)!;
    assert.equal(a.status, "done");
    assert.equal(a.proposalIds.length, 1);
    assert.equal(store.getProposal(a.proposalIds[0])?.name, "hotfix-rapido");
    assert.deepEqual(a.signals, { tasks: SIGNALS.tasks.length, commits: 3, evidenceFiles: SIGNALS.evidence.length });
  });
});

test("invalid proposals are discarded with a reason, the rest survive", async () => {
  await withStore(async (store) => {
    const runClaude = async () =>
      wrap([
        {
          name: "verificado",
          rationale: "r",
          evidence: [],
          config: { stages: [{ key: "planning", label: "Plan", icon: "📋", verifyCmd: "rm -rf /" }, ...VALID_STAGES.slice(1)], verifyAfter: null },
        },
        { name: "default", rationale: "r", evidence: [], config: { stages: VALID_STAGES, verifyAfter: null } },
        { name: "revisión-doble", rationale: "r", evidence: ["CU-2"], config: { stages: VALID_STAGES, verifyAfter: "planning" } },
      ]);
    const analyzer = createAnalyzer({ store, signals: async () => SIGNALS, catalogNames: () => ["default"], runClaude });
    const id = analyzer.start(range);
    await analyzer.waitFor(id);
    const a = store.getAnalysis(id)!;
    assert.equal(a.proposalIds.length, 1);
    assert.equal(a.discarded.length, 2);
    assert.match(a.discarded.map((d) => d.reason).join(), /verifyCmd|VERIFY/);
    assert.match(a.discarded.map((d) => d.reason).join(), /ya existe/);
    assert.equal(store.getProposal(a.proposalIds[0])?.name, "revision-doble");
  });
});

test("claude failure or missing JSON marks the analysis error without persisting proposals", async () => {
  await withStore(async (store) => {
    const analyzer = createAnalyzer({
      store,
      signals: async () => SIGNALS,
      catalogNames: () => [],
      runClaude: async () => {
        throw new Error("claude -p excedió el tiempo límite");
      },
    });
    const id = analyzer.start(range);
    await analyzer.waitFor(id);
    assert.equal(store.getAnalysis(id)?.status, "error");
    assert.match(store.getAnalysis(id)!.error!, /tiempo límite/);
    assert.deepEqual(store.listProposals("proposed"), []);
    assert.ok(store.getAnalysis(id)!.finishedAt);
  });
});

test("a response without a PROPOSALS block errors and persists nothing", async () => {
  await withStore(async (store) => {
    const analyzer = createAnalyzer({ store, signals: async () => SIGNALS, catalogNames: () => [], runClaude: async () => "lo siento, no puedo" });
    const id = analyzer.start(range);
    await analyzer.waitFor(id);
    assert.equal(store.getAnalysis(id)?.status, "error");
    assert.match(store.getAnalysis(id)!.error!, /JSON/);
    assert.deepEqual(store.listProposals(), []);
  });
});

test("empty names, non-objects and in-batch duplicates are discarded; rationale and evidence are trimmed", async () => {
  await withStore(async (store) => {
    const runClaude = async () =>
      wrap([
        "no soy un objeto",
        { name: "   ", rationale: "r", evidence: [], config: { stages: VALID_STAGES, verifyAfter: null } },
        // un `name` que no es string NO se coerciona: "[object Object]" daría el slug plausible "object-object"
        { name: {}, rationale: "r", evidence: [], config: { stages: VALID_STAGES, verifyAfter: null } },
        {
          name: "triage",
          rationale: "x".repeat(500),
          evidence: [...Array.from({ length: 25 }, (_, i) => `CU-${i}`), 42, null],
          config: { stages: VALID_STAGES, verifyAfter: null },
        },
        { name: "Triage", rationale: "r", evidence: [], config: { stages: VALID_STAGES, verifyAfter: null } },
      ]);
    const analyzer = createAnalyzer({ store, signals: async () => SIGNALS, catalogNames: () => [], runClaude });
    const id = analyzer.start(range);
    await analyzer.waitFor(id);
    const a = store.getAnalysis(id)!;
    assert.equal(a.proposalIds.length, 1);
    assert.equal(a.discarded.length, 4);
    assert.match(a.discarded.map((d) => d.reason).join(), /propuesta inválida/);
    assert.equal(a.discarded.filter((d) => d.reason === "nombre vacío").length, 2);
    assert.match(a.discarded.map((d) => d.reason).join(), /ya existe/);
    assert.ok(!a.discarded.some((d) => d.name === "object-object"));
    const p = store.getProposal(a.proposalIds[0])!;
    assert.equal(p.rationale.length, 400);
    assert.equal(p.evidence.length, 20);
    assert.equal(p.status, "proposed");
    assert.equal(p.analysisId, id);
  });
});

test("waitFor on a finished analysis resolves immediately and unknown ids reject", async () => {
  await withStore(async (store) => {
    const analyzer = createAnalyzer({
      store,
      signals: async () => SIGNALS,
      catalogNames: () => [],
      runClaude: async () => wrap([]),
      now: () => new Date("2026-08-24T12:00:00Z"),
    });
    const id = analyzer.start(range);
    await analyzer.waitFor(id);
    await analyzer.waitFor(id);
    assert.equal(store.getAnalysis(id)?.createdAt, "2026-08-24T12:00:00.000Z");
    await assert.rejects(() => analyzer.waitFor("an-desconocido"), /desconocido/);
  });
});

/** Envuelve un store real haciendo fallar escrituras concretas, para simular un disco roto. */
function brittleStore(store: ProposalStore, fail: { analysisFromCall?: number; proposalAtCall?: number }): ProposalStore {
  let analyses = 0;
  let proposals = 0;
  return {
    ...store,
    upsertAnalysis(analysis) {
      analyses += 1;
      if (fail.analysisFromCall !== undefined && analyses >= fail.analysisFromCall) throw new Error("ENOSPC: no queda espacio en el dispositivo");
      store.upsertAnalysis(analysis);
    },
    upsertProposal(proposal) {
      proposals += 1;
      if (fail.proposalAtCall !== undefined && proposals === fail.proposalAtCall) throw new Error("ENOSPC: no queda espacio en el dispositivo");
      store.upsertProposal(proposal);
    },
  };
}

/** Falla en vez de colgar el suite si `waitFor` nunca resuelve. */
async function settlesWithin(promise: Promise<void>, ms = 2000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("waitFor nunca resolvió: los waiters quedaron colgados")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("a store that cannot write the terminal analysis still releases waiters and never rejects unhandled", async () => {
  await withStore(async (real) => {
    // Falla en la 2ª escritura y en TODAS las siguientes: revienta tanto el cierre `done`
    // como el intento de marcar `error`, que es donde run() podría escapar sin capturar.
    const store = brittleStore(real, { analysisFromCall: 2 });
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    let unhandled: unknown;
    const onUnhandled = (reason: unknown): void => void (unhandled = reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const analyzer = createAnalyzer({
        store,
        signals: async () => SIGNALS,
        catalogNames: () => [],
        runClaude: async () => wrap([{ name: "triage", rationale: "r", evidence: [], config: { stages: VALID_STAGES, verifyAfter: null } }]),
      });
      const id = analyzer.start(range);
      await settlesWithin(analyzer.waitFor(id));
      // Un waitFor POSTERIOR al fallo tampoco puede colgarse, aunque en disco siga "running".
      assert.equal(real.getAnalysis(id)?.status, "running");
      await settlesWithin(analyzer.waitFor(id));
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled, undefined);
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /no se pudo marcar el análisis/);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      console.error = originalError;
    }
  });
});

test("a write failing mid-batch still links the proposals that made it to disk", async () => {
  await withStore(async (real) => {
    const store = brittleStore(real, { proposalAtCall: 2 });
    const analyzer = createAnalyzer({
      store,
      signals: async () => SIGNALS,
      catalogNames: () => [],
      runClaude: async () =>
        wrap(
          ["uno", "dos", "tres"].map((name) => ({ name, rationale: "r", evidence: [], config: { stages: VALID_STAGES, verifyAfter: null } }))
        ),
    });
    const id = analyzer.start(range);
    await settlesWithin(analyzer.waitFor(id));
    const a = real.getAnalysis(id)!;
    assert.equal(a.status, "error");
    assert.match(a.error!, /ENOSPC/);
    const survivors = real.listProposals("proposed");
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].name, "uno");
    assert.deepEqual(a.proposalIds, [survivors[0].id]);
  });
});
