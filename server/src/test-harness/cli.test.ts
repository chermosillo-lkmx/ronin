import assert from "node:assert/strict";
import test from "node:test";
import type { Run, RunSelection } from "./model.js";
import { runCli, type CliHarness } from "./cli.js";

function fakeHarness(runs: Partial<Run>[]): CliHarness & { calls: RunSelection[] } {
  const calls: RunSelection[] = [];
  const byId = new Map(runs.map((r, i) => [r.runId ?? `r${i}`, { runId: `r${i}`, repo: "api", suite: "unit", profile: "dev", createdAt: "", status: "passed", ...r } as Run]));
  return {
    calls,
    async start(selection) {
      calls.push(selection);
      return { batchId: selection.kind === "suites" ? undefined : "b1", runIds: [...byId.keys()] };
    },
    async waitForAll() {},
    getRun: (id) => byId.get(id),
  };
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (s: string) => out.push(s), error: (s: string) => err.push(s) };
}

test("CLI all delegates to the same selection service and exits 0 when every child passed", async () => {
  const harness = fakeHarness([{ status: "passed", totals: { total: 3, passed: 3, failed: 0, skipped: 0, errors: 0 }, coverage: { status: "reported", lines: 81.5 } }]);
  const o = io();
  const code = await runCli(["all", "--profile", "dev"], harness, o);
  assert.equal(code, 0);
  assert.deepEqual(harness.calls[0], { kind: "all", profile: "dev" });
  assert.match(o.out.join("\n"), /api\s+unit\s+passed/);
  assert.match(o.out.join("\n"), /81\.5%/);
});

test("CLI repo/suite/failed build declared selections; a failed child exits 1 and blocked exits 2", async () => {
  const failed = fakeHarness([{ status: "failed" }, { status: "passed" }]);
  assert.equal(await runCli(["repo", "api", "--profile", "dev"], failed, io()), 1);
  assert.deepEqual(failed.calls[0], { kind: "suites", repo: "api", profile: "dev", suites: ["unit", "e2e", "browser"] });

  const blocked = fakeHarness([{ status: "blocked", reason: "perfil qa no configurado" }]);
  const o = io();
  assert.equal(await runCli(["suite", "api", "unit", "--profile", "qa"], blocked, o), 2);
  assert.deepEqual(blocked.calls[0], { kind: "suites", repo: "api", profile: "qa", suites: ["unit"] });
  assert.match(o.out.join("\n"), /perfil qa no configurado/);

  const f = fakeHarness([]);
  assert.equal(await runCli(["failed", "--profile", "dev"], f, io()), 0);
  assert.deepEqual(f.calls[0], { kind: "failed", profile: "dev" });
});

test("CLI rejects invalid arguments with 64 without starting anything, and --help exits 0", async () => {
  const h = fakeHarness([]);
  const o = io();
  assert.equal(await runCli(["all"], h, o), 64);
  assert.equal(await runCli(["suite", "api", "shell", "--profile", "dev"], h, o), 64);
  assert.equal(await runCli(["bogus", "--profile", "dev"], h, o), 64);
  assert.equal(h.calls.length, 0);
  const help = io();
  assert.equal(await runCli(["--help"], h, help), 0);
  assert.match(help.out.join("\n"), /--profile/);
  assert.equal(h.calls.length, 0);
});

test("CLI never prints profile variable values", async () => {
  const h = fakeHarness([{ status: "passed", stdout: "TOKEN=***" }]);
  const o = io();
  await runCli(["all", "--profile", "dev"], h, o);
  assert.equal(JSON.stringify(o).includes("s3cr3t"), false);
});
