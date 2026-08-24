import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCommand } from "./runner.js";

const NODE = process.execPath;

test("runCommand captures exit code and bounded stdout/stderr without a shell", async () => {
  const handle = runCommand({
    command: { program: NODE, args: ["-e", "process.stdout.write('out $HOME'); process.stderr.write('err'); process.exit(3)"] },
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
  });
  const r = await handle.done;
  assert.equal(r.exitCode, 3);
  assert.equal(r.stdout, "out $HOME"); // no expansión de shell
  assert.equal(r.stderr, "err");
  assert.equal(r.outcome, "exited");
});

test("runCommand passes only the given env to the child", async () => {
  process.env.RONIN_LEAK_CHECK = "leak";
  try {
    const r = await runCommand({
      command: { program: NODE, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"] },
      cwd: process.cwd(),
      env: { TOKEN: "abc", PATH: process.env.PATH ?? "" },
      timeoutMs: 10_000,
    }).done;
    const env = JSON.parse(r.stdout) as Record<string, string>;
    assert.equal(env.TOKEN, "abc");
    assert.equal(env.RONIN_LEAK_CHECK, undefined);
  } finally {
    delete process.env.RONIN_LEAK_CHECK;
  }
});

test("runCommand resolves a relative program against cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-run-"));
  try {
    const r = await runCommand({
      command: { program: NODE, args: ["-e", "process.stdout.write(process.cwd())"] },
      cwd: dir,
      env: {},
      timeoutMs: 10_000,
    }).done;
    assert.equal(r.stdout, dir.replace(/^\/private/, "") === r.stdout ? r.stdout : r.stdout);
    assert.ok(r.stdout.endsWith(dir.split("/").pop()!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCommand reports timeout and kills the process group", async () => {
  const started = Date.now();
  const r = await runCommand({
    command: { program: NODE, args: ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1000)"] },
    cwd: process.cwd(),
    env: {},
    timeoutMs: 300,
  }).done;
  assert.equal(r.outcome, "timeout");
  assert.equal(r.stdout, "partial");
  assert.ok(Date.now() - started < 5_000);
});

test("runCommand cancel keeps partial output and reports cancelled", async () => {
  const handle = runCommand({
    command: { program: NODE, args: ["-e", "process.stdout.write('partial'); setInterval(() => {}, 1000)"] },
    cwd: process.cwd(),
    env: {},
    timeoutMs: 10_000,
  });
  await new Promise((r) => setTimeout(r, 200));
  handle.cancel();
  const r = await handle.done;
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.stdout, "partial");
});

test("runCommand reports a spawn error as outcome error", async () => {
  const r = await runCommand({
    command: { program: "/definitely/not/a/program", args: [] },
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1_000,
  }).done;
  assert.equal(r.outcome, "error");
  assert.match(r.stderr, /ENOENT/);
});
