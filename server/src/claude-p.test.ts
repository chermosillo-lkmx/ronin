import assert from "node:assert/strict";
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
