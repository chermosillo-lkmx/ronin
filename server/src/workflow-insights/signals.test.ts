import assert from "node:assert/strict";
import test from "node:test";
import type { Commit } from "../report-git.js";
import type { HistoryEvent } from "../history.js";
import type { AnalysisRange } from "./model.js";
import { collectSignals, truncateUtf8Bytes, type SignalDeps } from "./signals.js";

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

test("collectSignals groups session history by session name with launch/close/adopt counts and caps at 80 sessions", async () => {
  const events: HistoryEvent[] = [
    { ts: from + 1, type: "launch", key: "cowork-api", title: "cowork-api", source: "session", repo: "api", request: "b" },
    { ts: from + 2, type: "close", key: "cowork-api", title: "cowork-api", source: "session", repo: "api" },
    { ts: from + 3, type: "launch", key: "cowork-api", title: "cowork-api", source: "session", repo: "api" },
    { ts: from + 4, type: "adopt", key: "cowork-api", title: "cowork-api", source: "session", repo: "api", evidence: "hecho" },
    ...Array.from({ length: 100 }, (_, i) => ({ ts: from + 10 + i, type: "launch" as const, key: `session-${i}`, title: `session-${i}`, source: "session" as const, repo: "api" })),
  ];
  const s = await collectSignals(range, fakeDeps({ events }));
  const session = s.tasks.find((t) => t.key === "cowork-api")!;
  assert.deepEqual([session.launches, session.closes, session.adoptions, session.lastEvidence], [2, 1, 1, "hecho"]);
  assert.equal(s.tasks.length, 80);
  assert.equal(s.tasks[0].key, "cowork-api"); // más eventos primero
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

test("collectSignals truncates request to 300 chars and lastEvidence to 500 chars", async () => {
  const events: HistoryEvent[] = [
    { ts: from + 1, type: "launch", key: "cowork-api", title: "cowork-api", source: "session", repo: "api", request: "b".repeat(400) },
    { ts: from + 2, type: "adopt", key: "cowork-api", title: "cowork-api", source: "session", repo: "api", evidence: "e".repeat(600) },
  ];
  const s = await collectSignals(range, fakeDeps({ events }));
  const t = s.tasks.find((x) => x.key === "cowork-api")!;
  assert.equal(t.request!.length, 300);
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

test("collectSignals caps evidence GLOBALLY across repos (not per repo) and keeps global mtime-desc order", async () => {
  const cwdA = "/repos/repoA", cwdB = "/repos/repoB";
  // 10 files per repo (under the old per-repo cap of 15, so a per-repo cut would keep
  // ALL 20 — only a global cut to LIMITS.evidenceFiles=15 trims this). mtimes interleaved
  // across A/B so neither repo's own files form a trivially-correct global top 15.
  const filesA = Array.from({ length: 10 }, (_, i) => ({ name: `EVIDENCIA-a${i}.md`, mtime: from + i * 2 })); // offsets 0,2,...,18
  const filesB = Array.from({ length: 10 }, (_, i) => ({ name: `EVIDENCIA-b${i}.md`, mtime: from + i * 2 + 1 })); // offsets 1,3,...,19
  const files = { [cwdA]: filesA, [cwdB]: filesB };
  const fileContents: Record<string, string> = {};
  for (const f of filesA) fileContents[`${cwdA}/${f.name}`] = "a";
  for (const f of filesB) fileContents[`${cwdB}/${f.name}`] = "b";
  const resolveCwd = (repo: string) => (repo === "repoA" ? { cwd: cwdA, real: true } : { cwd: cwdB, real: true });
  const deps = fakeDeps({ repos: ["repoA", "repoB"], resolveCwd, files, fileContents });

  const s = await collectSignals(range, deps);

  assert.equal(s.evidence.length, 15);
  const mtimes = s.evidence.map((e) => e.mtime);
  assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a)); // orden global desc, no por repo
  // el corte global se queda con los 15 mtimes más altos del conjunto combinado (offsets 5..19),
  // no con "hasta 15 de cada repo" (que aquí habría devuelto los 20).
  assert.deepEqual(
    [...mtimes].sort((a, b) => a - b),
    Array.from({ length: 15 }, (_, i) => from + 5 + i),
  );
});

test("truncateUtf8Bytes never splits a UTF-8 codepoint and stays within the byte cap", () => {
  const s = "😀".repeat(10); // emoji de 4 bytes cada uno → 40 bytes totales
  const buf = Buffer.from(s, "utf8");
  for (let max = 0; max <= buf.length + 2; max++) {
    const out = truncateUtf8Bytes(buf, max);
    assert.ok(Buffer.byteLength(out) <= max, `max=${max} produjo ${Buffer.byteLength(out)} bytes`);
    assert.ok(!out.includes("�"), `max=${max} produjo un carácter de reemplazo`);
  }
});
