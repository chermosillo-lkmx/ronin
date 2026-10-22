// Pruebas de scripts/ticket-evidence-gate.sh: cada caso arma un cycle dir con launch.json y un
// `curl` falso al frente del PATH que responde los comentarios de ClickUp desde archivos del tmp.
// Sin red, sin token real. Correr: node --test scripts/ticket-evidence-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "ticket-evidence-gate.sh");
const CREATED = 1_792_681_234_728;
const EVIDENCE = "## Evidencia (DEV)\n\n" + "veredicto, causa, PR, suites y pruebas por criterio. ".repeat(10);

// curl falso: toma el id de .../task/<id>/comment, responde $FAKE_CLICKUP/<id>.json (o un 404 de
// ClickUp) y anota el id consultado en $FAKE_CLICKUP/calls.
const FAKE_CURL = `#!/bin/bash
url="\${@: -1}"
id="\${url#*/task/}"; id="\${id%%/*}"
echo "$id" >> "$FAKE_CLICKUP/calls"
if [ -f "$FAKE_CLICKUP/$id.json" ]; then cat "$FAKE_CLICKUP/$id.json"; else echo '{"err":"Task not found","ECODE":"ITEM_013"}'; fi
`;

function fixture(t, launch) {
  const tmp = mkdtempSync(join(tmpdir(), "ticket-gate-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const cycle = join(tmp, "cycle");
  const fake = join(tmp, "clickup");
  const bin = join(tmp, "bin");
  for (const dir of [cycle, fake, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(cycle, "launch.json"), JSON.stringify({ name: "cowork-x", createdAt: CREATED, inputs: {}, ...launch }));
  return {
    comment: (id, text, date = CREATED + 60_000) =>
      writeFileSync(join(fake, `${id}.json`), JSON.stringify({ comments: [{ comment_text: text, date: String(date), user: { username: "ana" } }] })),
    calls: () => (existsSync(join(fake, "calls")) ? readFileSync(join(fake, "calls"), "utf8").trim().split("\n") : []),
    run: () => {
      const r = spawnSync("bash", [GATE, cycle], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, COWORK_CLICKUP_TOKEN: "pk_fake", FAKE_CLICKUP: fake },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
}

test("inputs.ticket con un id de ClickUp que no empieza con 86 se verifica (PASS con comentario)", (t) => {
  const fx = fixture(t, { inputs: { ticket: "1dfkggwe07k" } });
  fx.comment("1dfkggwe07k", EVIDENCE);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ 1dfkggwe07k: comentario de evidencia presente/);
  assert.deepEqual(fx.calls(), ["1dfkggwe07k"]);
});

test("inputs.ticket sin comentario de evidencia es FAIL, no un PASS vacío", (t) => {
  const fx = fixture(t, { inputs: { ticket: "1dfkggwe07k" } });
  fx.comment("1dfkggwe07k", "listo");
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ 1dfkggwe07k: sin comentario de evidencia/);
  assert.match(r.out, /TICKET-EVIDENCE-GATE: FAIL/);
});

test("inputs.ticket acepta la URL del ticket y el prefijo CU-", (t) => {
  const fx = fixture(t, { inputs: { tickets: ["https://app.clickup.com/t/1dfkggwe07k", "CU-86e3u4umb"] } });
  fx.comment("1dfkggwe07k", EVIDENCE);
  fx.comment("86e3u4umb", EVIDENCE);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fx.calls(), ["1dfkggwe07k", "86e3u4umb"]);
});

test("sin inputs, toma las URLs de ClickUp del request, también con workspace", (t) => {
  const fx = fixture(t, {
    request: "Libéralo: https://app.clickup.com/t/1dfkggwdzjn y https://app.clickup.com/t/9017123/abc123xyz",
  });
  fx.comment("1dfkggwdzjn", EVIDENCE);
  fx.comment("abc123xyz", EVIDENCE);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fx.calls(), ["1dfkggwdzjn", "abc123xyz"]);
});

test("sin inputs, los ids 86xxxxxxx sueltos del request siguen contando", (t) => {
  const fx = fixture(t, { request: "arregla CU-86e3qq035 y 86e3r8f60" });
  fx.comment("86e3qq035", EVIDENCE);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✅ 86e3qq035/);
  assert.match(r.out, /❌ 86e3r8f60/);
});

test("con inputs declarados, los tickets que el request sólo menciona no se exigen", (t) => {
  const fx = fixture(t, {
    inputs: { ticket: "1dfkggwe07k" },
    request: "Seguimiento de https://app.clickup.com/t/1dfkggwdzjn (front: https://app.clickup.com/t/1dfkggwdzjq, CU-86e3u4umb)",
  });
  fx.comment("1dfkggwe07k", EVIDENCE);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fx.calls(), ["1dfkggwe07k"]);
});

test("un comentario anterior al arranque del ciclo no cuenta", (t) => {
  const fx = fixture(t, { inputs: { ticket: "1dfkggwe07k" } });
  fx.comment("1dfkggwe07k", EVIDENCE, CREATED - 1);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
});

test("ciclo sin ticket sigue siendo PASS explícito y no llama a ClickUp", (t) => {
  const fx = fixture(t, { request: "mejora el README; ver https://example.com/t/abc" });
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no declara ningún ticket/);
  assert.deepEqual(fx.calls(), []);
});

test("un inputs.ticket que no parece id de ClickUp es FAIL, no se ignora", (t) => {
  const fx = fixture(t, { inputs: { ticket: "el de ayer" } });
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no parece un id de ClickUp/);
});
