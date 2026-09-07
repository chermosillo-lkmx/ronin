import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runClaudeP } from "./claude-p.js";

test("runClaudeP pasa el prompt por STDIN y devuelve stdout", async () => {
  const out = await runClaudeP("hola", { command: process.execPath, args: ["-e", "process.stdin.on('data',d=>process.stdout.write('eco:'+d))"] });
  assert.equal(out, "eco:hola");
});

test("runClaudeP rechaza por timeout y por exit distinto de 0", async () => {
  await assert.rejects(runClaudeP("x", { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 200 }), /tiempo límite/);
  await assert.rejects(runClaudeP("x", { command: process.execPath, args: ["-e", "process.exit(3)"] }), /código 3/);
});

test("runClaudeP rechaza cuando el comando no existe", async () => {
  await assert.rejects(runClaudeP("x", { command: "/no/existe" }), /ENOENT/);
});

test("runClaudeP pasa cwd al proceso cuando se configura", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ronin-claude-p-"));
  try {
    const out = await runClaudeP("", { command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"], cwd });
    assert.equal(out, realpathSync(cwd));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runClaudeP conserva el cwd heredado cuando no se configura", async () => {
  const out = await runClaudeP("", { command: process.execPath, args: ["-e", "process.stdout.write(process.cwd())"] });
  assert.equal(out, process.cwd());
});
