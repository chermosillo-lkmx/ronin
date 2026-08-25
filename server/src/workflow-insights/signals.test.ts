import assert from "node:assert/strict";
import test from "node:test";
import type { Commit } from "../report-git.js";
import type { HistoryEvent } from "../history.js";
import type { AnalysisRange } from "./model.js";
import { collectSignals, type SignalDeps } from "./signals.js";

const from = Date.parse("2026-08-10T00:00:00Z");
const to = Date.parse("2026-08-24T00:00:00Z");
const range: AnalysisRange = { from: new Date(from), to: new Date(to) };

type FakeOverrides = Partial<{
  events: HistoryEvent[];
  commitsByRepo: Record<string, Commit[]>;
  repos: string[];
  resolveCwd: (repo: string) => { cwd: string; real: boolean };
  files: Record<string, { name: string; mtime: number }[]>;
  fileContents: Record<string, string>;
}>;

function fakeDeps(overrides: FakeOverrides = {}): SignalDeps {
  const events = overrides.events ?? [];
  const commitsByRepo = overrides.commitsByRepo ?? {};
  const repoList = overrides.repos ?? [];
  const resolveCwd = overrides.resolveCwd ?? ((repo: string) => ({ cwd: `/repos/${repo}`, real: true }));
  const files = overrides.files ?? {};
  const fileContents = overrides.fileContents ?? {};
  return {
    history: () => events,
    commits: async () => commitsByRepo,
    repos: () => repoList,
    resolveCwd,
    readDir: (dir: string) => files[dir] ?? [],
    readFile: (file: string, maxBytes: number) =>
      Buffer.from(fileContents[file] ?? "", "utf8").subarray(0, maxBytes).toString("utf8"),
  };
}

test("collectSignals groups history by key with counts and window, and caps at 80 tasks", async () => {
  const events: HistoryEvent[] = [
    { ts: from + 1, type: "launch", key: "CU-1", title: "A", source: "clickup", repo: "api", body: "b" },
    { ts: from + 2, type: "stop", key: "CU-1", title: "A", source: "clickup", repo: "api" },
    { ts: from + 3, type: "launch", key: "CU-1", title: "A", source: "clickup", repo: "api" },
    { ts: from + 4, type: "complete", key: "CU-1", title: "A", source: "clickup", repo: "api", evidence: "hecho" },
    ...Array.from({ length: 100 }, (_, i) => ({ ts: from + 10 + i, type: "launch" as const, key: `X-${i}`, title: `t${i}`, source: "jira", repo: "api" })),
  ];
  const s = await collectSignals(range, fakeDeps({ events }));
  const cu = s.tasks.find((t) => t.key === "CU-1")!;
  assert.deepEqual([cu.launches, cu.stops, cu.completes, cu.lastEvidence], [2, 1, 1, "hecho"]);
  assert.equal(s.tasks.length, 80);
  assert.equal(s.tasks[0].key, "CU-1"); // más eventos primero
});

test("collectSignals caps commits per repo and reads only evidence files modified in the window", async () => {
  const cwd = "/repos/api";
  const commitsByRepo: Record<string, Commit[]> = {
    api: Array.from({ length: 100 }, (_, i) => ({ hash: `h${i}`, subject: `s${i}`, author: "dev", ts: from + i })),
  };
  const files = {
    [cwd]: [
      { name: "EVIDENCIA-a.md", mtime: from + 1000 }, // en ventana
      { name: "research.md", mtime: to - 1000 }, // en ventana
      { name: "EVIDENCIA-viejo.md", mtime: from - 1000 }, // nombre válido, fuera de ventana
      { name: "otro.txt", mtime: from + 500 }, // no matchea el patrón de nombre
    ],
  };
  const fileContents = {
    [`${cwd}/EVIDENCIA-a.md`]: "x".repeat(5000), // fuerza el corte de bytes
    [`${cwd}/research.md`]: "resumen breve",
  };
  const deps = fakeDeps({ repos: ["api"], commitsByRepo, files, fileContents });
  const s = await collectSignals(range, deps);
  assert.equal(s.commits.api.length, 60);
  assert.deepEqual(s.evidence.map((e) => e.file).sort(), ["EVIDENCIA-a.md", "research.md"]);
  assert.ok(s.evidence.every((e) => Buffer.byteLength(e.excerpt) <= 3072));
});

test("collectSignals never throws when a repo folder is missing", async () => {
  const s = await collectSignals(range, fakeDeps({ repos: ["api"], resolveCwd: () => ({ cwd: "/nope", real: false }) }));
  assert.deepEqual(s.evidence, []);
});

test("collectSignals truncates body to 300 chars and lastEvidence to 500 chars", async () => {
  const events: HistoryEvent[] = [
    { ts: from + 1, type: "launch", key: "CU-9", title: "T", source: "clickup", repo: "api", body: "b".repeat(400) },
    { ts: from + 2, type: "complete", key: "CU-9", title: "T", source: "clickup", repo: "api", evidence: "e".repeat(600) },
  ];
  const s = await collectSignals(range, fakeDeps({ events }));
  const t = s.tasks.find((x) => x.key === "CU-9")!;
  assert.equal(t.body!.length, 300);
  assert.equal(t.lastEvidence!.length, 500);
});

test("collectSignals dedupes evidence by resolved cwd and keeps the first repo key", async () => {
  const cwd = "/repos/shared";
  const files = { [cwd]: [{ name: "research.md", mtime: from + 10 }] };
  const fileContents = { [`${cwd}/research.md`]: "hola" };
  const deps = fakeDeps({ repos: ["alpha", "beta"], resolveCwd: () => ({ cwd, real: true }), files, fileContents });
  const s = await collectSignals(range, deps);
  assert.equal(s.evidence.length, 1);
  assert.equal(s.evidence[0].repo, "alpha");
});
