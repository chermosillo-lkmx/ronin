import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheHit, repoHeads, type GitPort, type RepoHead } from "./gate-cache.js";
import type { VerifyState } from "./stages.js";

// Worktree real en un tmp: cada sub-repo es un dir con `.git` y `package.json`.
function mkWorktree(repos: string[]): string {
  const wt = mkdtempSync(join(tmpdir(), "gate-cache-"));
  for (const r of repos) {
    mkdirSync(join(wt, r, ".git"), { recursive: true });
    writeFileSync(join(wt, r, "package.json"), "{}");
  }
  return wt;
}

interface FakeRepo {
  sha?: string;
  status?: string;
  fail?: boolean;
}
// GitPort falso: responde por el basename del cwd; los diffs se resuelven por «a..b» en `diffs`.
function fakeGit(repos: Record<string, FakeRepo>, diffs: Record<string, string | null> = {}): GitPort {
  return {
    async run(args, cwd) {
      const name = cwd.split("/").pop() as string;
      const r = repos[name] ?? {};
      if (r.fail) return { ok: false, out: "" };
      if (args[0] === "rev-parse") return { ok: true, out: `${r.sha ?? "aaa"}\n` };
      if (args[0] === "status") return { ok: true, out: r.status ?? "" };
      if (args[0] === "diff") {
        const key = `${name}:${args[args.length - 2]}..${args[args.length - 1]}`;
        const d = diffs[key];
        return d === null || d === undefined ? { ok: false, out: "" } : { ok: true, out: d };
      }
      return { ok: false, out: "" };
    },
  };
}

test("repoHeads: worktree con dos sub-repos devuelve ambos con sha y dirty", async () => {
  const wt = mkWorktree(["api", "web"]);
  try {
    // también ignorados: *-base, node_modules, ocultos, y un dir sin tests/package.json
    mkdirSync(join(wt, "api-base", ".git"), { recursive: true });
    writeFileSync(join(wt, "api-base", "package.json"), "{}");
    mkdirSync(join(wt, "node_modules", ".git"), { recursive: true });
    mkdirSync(join(wt, ".hid", ".git"), { recursive: true });
    mkdirSync(join(wt, "vacio", ".git"), { recursive: true });
    const heads = await repoHeads(
      wt,
      fakeGit({ api: { sha: "s1" }, web: { sha: "s2", status: " M src/a.ts\n" } }),
    );
    assert.deepEqual(heads, [
      { repo: "api", sha: "s1", dirty: false },
      { repo: "web", sha: "s2", dirty: true },
    ]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("repoHeads: el propio worktree cuenta si es repo (.git archivo + tests/)", async () => {
  const wt = mkdtempSync(join(tmpdir(), "gate-cache-self-"));
  try {
    writeFileSync(join(wt, ".git"), "gitdir: x");
    mkdirSync(join(wt, "tests"));
    const heads = await repoHeads(wt, fakeGit({ [wt.split("/").pop() as string]: { sha: "z" } }));
    assert.deepEqual(heads, [{ repo: wt.split("/").pop(), sha: "z", dirty: false }]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("repoHeads: cambios sólo en reports/ no cuentan como dirty", async () => {
  const wt = mkWorktree(["api", "web"]);
  try {
    const heads = await repoHeads(
      wt,
      fakeGit({
        api: { status: "?? reports/ronin-gate/x.log\n" },
        web: { status: "R  old.ts -> reports/new.ts\n" },
      }),
    );
    assert.equal(heads?.find((h) => h.repo === "api")?.dirty, false);
    // renombre: un lado fuera de reports/ => dirty
    assert.equal(heads?.find((h) => h.repo === "web")?.dirty, true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("repoHeads: archivo trackeado modificado bajo reports/ sí es dirty; untracked no", async () => {
  const wt = mkWorktree(["api", "web"]);
  try {
    const hs = await repoHeads(
      wt,
      fakeGit({ api: { status: " M reports/mod.py\n" }, web: { status: "?? reports/ronin-gate/a\n" } }),
    );
    assert.equal(hs?.find((h) => h.repo === "api")?.dirty, true);
    assert.equal(hs?.find((h) => h.repo === "web")?.dirty, false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test("repoHeads: git falla → null", async () => {
  const wt = mkWorktree(["api", "web"]);
  try {
    assert.equal(await repoHeads(wt, fakeGit({ web: { fail: true } })), null);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const W = "c".repeat(40);
const passed = (shas: Record<string, string>): VerifyState => ({ attempts: 1, status: "passed", shas });
const heads = (o: Record<string, string>): RepoHead[] =>
  Object.entries(o).map(([repo, sha]) => ({ repo, sha, dirty: false }));

test("cacheHit: mismos SHAs y passed → true; failed o sin cache → false", async () => {
  const g = fakeGit({});
  assert.equal(await cacheHit(passed({ api: A }), heads({ api: A }), g, "/w", ["e2e_dev/"]), true);
  assert.equal(
    await cacheHit({ attempts: 1, status: "failed", shas: { api: A } }, heads({ api: A }), g, "/w", []),
    false,
  );
  assert.equal(await cacheHit(null, heads({ api: A }), g, "/w", []), false);
  assert.equal(await cacheHit({ attempts: 1, status: "passed" }, heads({ api: A }), g, "/w", []), false);
});

test("cacheHit: SHA nuevo con diff sólo en e2e_dev/ → true; con src/ → false; ilegible → false", async () => {
  const hs = heads({ api: B });
  const c = passed({ api: A });
  const ok = fakeGit({}, { [`api:${A}..${B}`]: "e2e_dev/t.py\ne2e_dev/sub/u.py\n" });
  assert.equal(await cacheHit(c, hs, ok, "/x/w", ["e2e_dev/"]), true);
  const mixed = fakeGit({}, { [`api:${A}..${B}`]: "e2e_dev/t.py\nsrc/a.ts\n" });
  assert.equal(await cacheHit(c, hs, mixed, "/x/w", ["e2e_dev/"]), false);
  assert.equal(await cacheHit(c, hs, fakeGit({}, { [`api:${A}..${B}`]: null }), "/x/w", ["e2e_dev/"]), false);
});

test("cacheHit: prefijo e2e con semántica de directorio (qa/e2e no cubre qa/e2e2)", async () => {
  const hs = heads({ api: B });
  const c = passed({ api: A });
  const g = (d: string) => fakeGit({}, { [`api:${A}..${B}`]: d });
  assert.equal(await cacheHit(c, hs, g("qa/e2e/x.py\n"), "/x/w", ["qa/e2e"]), true);
  assert.equal(await cacheHit(c, hs, g("qa/e2e2/x.py\n"), "/x/w", ["qa/e2e"]), false);
});

test("cacheHit: aparece un sub-repo nuevo (o desaparece) → false", async () => {
  const g = fakeGit({});
  assert.equal(await cacheHit(passed({ api: A }), heads({ api: A, web: W }), g, "/w", []), false);
  assert.equal(await cacheHit(passed({ api: A, web: W }), heads({ api: A }), g, "/w", []), false);
});

test("cacheHit: sin repos → false aunque la caché esté vacía y passed", async () => {
  assert.equal(await cacheHit({ attempts: 1, status: "passed", shas: {} }, [], fakeGit({}), "/w", []), false);
});

test("cacheHit: SHA guardado no hex (HEAD, opción) → false y git nunca lo recibe", async () => {
  const seen: string[] = [];
  const g: GitPort = {
    async run(args) {
      seen.push(...args);
      return { ok: true, out: "" };
    },
  };
  assert.equal(await cacheHit(passed({ api: "HEAD" }), heads({ api: B }), g, "/x/w", ["e2e_dev/"]), false);
  assert.equal(await cacheHit(passed({ api: "--output=/tmp/x" }), heads({ api: B }), g, "/x/w", []), false);
  assert.ok(!seen.includes("--output=/tmp/x") && !seen.includes("HEAD"));
});

test("cacheHit: el diff lleva --end-of-options antes de las revisiones", async () => {
  let args: string[] = [];
  const g: GitPort = {
    async run(a) {
      args = a;
      return { ok: true, out: "e2e_dev/x\n" };
    },
  };
  assert.equal(await cacheHit(passed({ api: A }), heads({ api: B }), g, "/x/w", ["e2e_dev/"]), true);
  assert.deepEqual(args, ["diff", "--name-only", "--no-renames", "--end-of-options", A, B]);
});

test("cacheHit: clave de prototipo (constructor) no cuenta como sub-repo cacheado", async () => {
  assert.equal(await cacheHit(passed({ other: A }), heads({ constructor: A }), fakeGit({}), "/x/w", []), false);
});
