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
  assert.deepEqual(calls[0].opts.args, ["-p", "--tools", "Read,Grep,Glob", "--strict-mcp-config", "--setting-sources", "", "--disallowedTools",
    "Read(**/.env*)", "Read(**/*.pem)", "Read(**/*.key)", "Read(**/*credentials*)", "Read(**/*secret*)",
    "Read(**/id_rsa)", "Read(**/*.p12)", "Read(**/*.pfx)", "Read(**/.npmrc)", "Read(**/.netrc)"]);
});

function blocks(prompt: string): { inside: string; outside: string } {
  const re = /<<<DATOS_TERCEROS (\w+)>>>([\s\S]*?)<<<FIN_DATOS_TERCEROS \1>>>/g;
  let inside = "";
  const outside = prompt.replace(re, (_m, _n, body) => { inside += body + "\n"; return ""; });
  return { inside, outside };
}

test("comentario, guía y borrador previo van dentro de bloques de datos, nunca en la parte confiable", async () => {
  const { calls, d } = deps("ok");
  await draftCommentReply({ repo: "api", comment: "COMENTARIO_X", guidance: "GUIA_Y", previous: "PREVIO_Z" }, d);
  const { inside, outside } = blocks(calls[0].input);
  for (const s of ["COMENTARIO_X", "GUIA_Y", "PREVIO_Z"]) {
    assert.ok(inside.includes(s), `${s} dentro`);
    assert.ok(!outside.includes(s), `${s} fuera`);
  }
  assert.equal((calls[0].input.match(/<<<DATOS_TERCEROS /g) ?? []).length, 3);
  assert.match(outside, /no autoriza/i);
  assert.ok(!/indicaci[oó]n de c[eé]sar/i.test(outside));
});

test("un repo sin carpeta real falla con error legible y sin llamar a Claude", async () => {
  const { calls, d } = deps("ok");
  d.resolveCwd = () => ({ cwd: "/donde/corre/ronin", real: false });
  await assert.rejects(draftCommentReply({ repo: "api", comment: "c" }, d), (e: Error) => /api/.test(e.message) && /carpeta/i.test(e.message) && !/donde\/corre/.test(e.message));
  assert.equal(calls.length, 0);
});

test("draftCommentReply redacta el token, la capability y las vars", async () => {
  const { d } = deps("el token 123456:ABCDEF y cap-abcdef12 y VALOR_DE_VAR_9 y corto", ["123456:ABCDEF", "cap-abcdef12", "VALOR_DE_VAR_9"]);
  const out = await draftCommentReply({ repo: "api", comment: "c" }, d);
  assert.equal(out, "el token [redactado] y [redactado] y [redactado] y corto");
});

test("un secreto corto también se redacta", async () => {
  const { d } = deps("a [redactado] b a", ["a"]);
  assert.equal(await draftCommentReply({ repo: "api", comment: "c" }, d), "[redactado] [redactado] b [redactado]");
});

test("timeout de Claude → error legible sin stderr interno", async () => {
  const { d } = deps(new Error("claude -p excedió el tiempo límite"));
  await assert.rejects(draftCommentReply({ repo: "api", comment: "c" }, d), (e: Error) => /tiempo/i.test(e.message) && !/claude -p/.test(e.message));
  const { d: d2 } = deps(new Error("claude -p salió con código 1: TOKEN=abc /Users/x/stack"));
  await assert.rejects(draftCommentReply({ repo: "api", comment: "c" }, d2), (e: Error) => !/TOKEN|Users|código/.test(e.message));
});
