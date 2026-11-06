import { strict as assert } from "node:assert";
import { test } from "node:test";
import { draftCommentReply } from "./comment.js";

function deps(output: string | Error, secrets: string[] = []) {
  const calls: Array<{ input: string; opts: any }> = [];
  return {
    calls,
    d: {
      run: (async (input: string, opts: any) => { calls.push({ input, opts }); if (output instanceof Error) throw output; return output; }) as any,
      resolveCwd: (repo: string) => ({ cwd: `/repos/${repo}`, real: true }),
      secrets: () => secrets,
    },
  };
}

test("draftCommentReply usa cwd del repo y args exactos", async () => {
  const { calls, d } = deps("respuesta");
  assert.equal(await draftCommentReply({ repo: "api", comment: "¿por qué?" }, d), "respuesta");
  assert.equal(calls[0].opts.command, "claude");
  assert.equal(calls[0].opts.cwd, "/repos/api");
  assert.equal(calls[0].opts.timeoutMs, 110_000);
  assert.deepEqual(calls[0].opts.args, ["-p", "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--disallowedTools",
    "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/*credentials*)", "Read(**/*secret*)"]);
});

test("el prompt delimita el comentario como datos e incluye guía y borrador previo", async () => {
  const { calls, d } = deps("ok");
  await draftCommentReply({ repo: "api", comment: "COMENTARIO_X", guidance: "GUIA_Y", previous: "PREVIO_Z" }, d);
  const p = calls[0].input;
  for (const s of ["COMENTARIO_X", "GUIA_Y", "PREVIO_Z", "DATOS_TERCEROS"]) assert.ok(p.includes(s), s);
});

test("draftCommentReply redacta el token, la capability y las vars", async () => {
  const { d } = deps("el token 123456:ABCDEF y cap-abcdef12 y VALOR_DE_VAR_9 y corto", ["123456:ABCDEF", "cap-abcdef12", "VALOR_DE_VAR_9"]);
  const out = await draftCommentReply({ repo: "api", comment: "c" }, d);
  assert.equal(out, "el token [redactado] y [redactado] y [redactado] y corto");
});

test("secretos de menos de 8 caracteres se ignoran (redactSecrets no es idempotente con ellos)", async () => {
  const { d } = deps("a [redactado] b", ["a", "re", "dactado"]);
  assert.equal(await draftCommentReply({ repo: "api", comment: "c" }, d), "a [redactado] b");
});

test("timeout de Claude → error legible sin stderr interno", async () => {
  const { d } = deps(new Error("claude -p excedió el tiempo límite"));
  await assert.rejects(draftCommentReply({ repo: "api", comment: "c" }, d), (e: Error) => /tiempo/i.test(e.message) && !/claude -p/.test(e.message));
  const { d: d2 } = deps(new Error("claude -p salió con código 1: TOKEN=abc /Users/x/stack"));
  await assert.rejects(draftCommentReply({ repo: "api", comment: "c" }, d2), (e: Error) => !/TOKEN|Users|código/.test(e.message));
});
