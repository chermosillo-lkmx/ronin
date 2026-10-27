// Pruebas de scripts/migrate-pre-merge.mjs sobre una copia fija del catálogo vivo (2026-10-27).
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "migrate-pre-merge.mjs");
const FIXTURE = join(here, "fixtures", "workflows-2026-10-27.json");
const UNIT_GATE = "/Users/cesarhermosillo/code/claude-cowork/scripts/unit-gate.sh";

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "migrate-pre-merge-"));
  const file = join(dir, "workflows.json");
  copyFileSync(FIXTURE, file);
  return { dir, file };
}
const run = (file) => spawnSync("node", [SCRIPT, file], { encoding: "utf8" });
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const wf = (data, name) => data.items.find((w) => w.name === name);
const keys = (w) => w.config.stages.map((s) => s.key);
const stage = (w, key) => w.config.stages.find((s) => s.key === key);

test("cada workflow que mergea tiene pre-merge justo antes de pr/merge, con mergeGate y el verifyCmd de unit-gate", () => {
  const { dir, file } = sandbox();
  try {
    const r = run(file);
    assert.equal(r.status, 0, r.stderr);
    const data = load(file);
    for (const name of ["tmux-worker-loop", "claude-plan-codex-impl", "hotfix-verificado", "pr-review-merge-dev"]) {
      const w = wf(data, name);
      const k = keys(w);
      const i = k.indexOf("pre-merge");
      assert.ok(i >= 0, `${name} sin pre-merge`);
      assert.ok(["pr", "merge"].includes(k[i + 1]), `${name}: tras pre-merge viene ${k[i + 1]}`);
      const s = w.config.stages[i];
      assert.equal(s.label, "Gate pre-merge");
      assert.equal(s.icon, "🛡");
      assert.equal(s.mergeGate, true);
      assert.equal(s.maxRetries, 3);
      assert.equal(s.verifyCmd, UNIT_GATE);
      assert.match(s.instruction, /No corras la suite ni `unit-gate\.sh`/);
      assert.match(s.instruction, /UNIT-GATE: PASS/);
      assert.match(s.instruction, /UNIT-GATE: FAIL/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tests y arreglar ya no tienen el verifyCmd de unit-gate; i18n/e2e/ticket-evidence intactos", () => {
  const { dir, file } = sandbox();
  try {
    const before = load(file);
    run(file);
    const after = load(file);
    for (const [name, key] of [["tmux-worker-loop", "tests"], ["claude-plan-codex-impl", "tests"], ["hotfix-verificado", "tests"], ["pr-review-merge-dev", "arreglar"]]) {
      const s = stage(wf(after, name), key);
      assert.equal(s.verifyCmd, undefined, `${name}/${key}`);
      assert.equal(s.maxRetries, undefined, `${name}/${key}`);
    }
    for (const w of before.items) {
      for (const s of w.config.stages) {
        if (!s.verifyCmd || s.verifyCmd === UNIT_GATE) continue;
        const now = stage(wf(after, w.name), s.key);
        assert.equal(now.verifyCmd, s.verifyCmd, `${w.name}/${s.key}`);
        assert.equal(now.maxRetries, s.maxRetries, `${w.name}/${s.key}`);
        assert.equal(now.mergeGate, undefined);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ningún texto contiene \"córrelo tú también\" ni \"vuelve a correr el gate\" ni \"con su unit-gate\"", () => {
  const { dir, file } = sandbox();
  try {
    assert.match(readFileSync(file, "utf8"), /córrelo tú también/);
    run(file);
    const text = readFileSync(file, "utf8");
    for (const frase of ["córrelo tú también", "vuelve a correr el gate", "con su unit-gate"]) {
      assert.ok(!text.includes(frase), `sigue la frase: ${frase}`);
    }
    for (const name of ["tmux-worker-loop", "claude-plan-codex-impl", "hotfix-verificado", "pr-review-merge-dev"]) {
      assert.ok(!stage(wf(load(file), name), name === "pr-review-merge-dev" ? "arreglar" : "tests").instruction.includes("unit-gate.sh`) sobre"));
    }
    const d = load(file);
    for (const [n, k] of [["claude-plan-codex-impl", "pr"], ["pr-review-merge-dev", "merge"]]) {
      assert.match(stage(wf(d, n), k).instruction, /verify-pre-merge\.json/);
      assert.match(stage(wf(d, n), k).instruction, /pre-merge/);
    }
    assert.match(stage(wf(d, "claude-plan-codex-impl"), "tests").instruction, /reportar_pruebas/);
    assert.match(stage(wf(d, "claude-plan-codex-impl"), "tests").instruction, /dirigid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("tmux-worker-loop y hotfix-verificado ganan pr entre tests y curl", () => {
  const { dir, file } = sandbox();
  try {
    run(file);
    const d = load(file);
    const ref = stage(wf(d, "claude-plan-codex-impl"), "pr");
    for (const name of ["tmux-worker-loop", "hotfix-verificado"]) {
      const k = keys(wf(d, name));
      const t = k.indexOf("tests");
      assert.deepEqual(k.slice(t, t + 4), ["tests", "pre-merge", "pr", "curl"], name);
      assert.equal(stage(wf(d, name), "pr").instruction, ref.instruction);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("segunda corrida no cambia el archivo", () => {
  const { dir, file } = sandbox();
  try {
    run(file);
    const once = readFileSync(file, "utf8");
    const baks = readdirSync(dir).filter((f) => f.includes(".bak-")).length;
    const r = run(file);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(file, "utf8"), once);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, baks, "no debe crear otro .bak");
    assert.ok(once.endsWith("}\n") && once.includes('\n  "items": ['));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("deja un .bak", () => {
  const { dir, file } = sandbox();
  try {
    const original = readFileSync(file, "utf8");
    run(file);
    const baks = readdirSync(dir).filter((f) => /^workflows\.json\.bak-\d{8}-\d{6}$/.test(f));
    assert.equal(baks.length, 1);
    assert.equal(readFileSync(join(dir, baks[0]), "utf8"), original);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("el orden de claves de las etapas intactas se conserva", () => {
  const { dir, file } = sandbox();
  try {
    const before = load(file);
    run(file);
    const after = load(file);
    const a = JSON.stringify(stage(wf(before, "claude-plan-codex-impl"), "i18n"));
    const b = JSON.stringify(stage(wf(after, "claude-plan-codex-impl"), "i18n"));
    assert.equal(a, b);
    assert.deepEqual(after.items.map((w) => w.id), before.items.map((w) => w.id));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function editar(file, fn) {
  const d = load(file);
  fn(d);
  writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
}

test("un verifyCmd con wrapper y argumentos se reconoce como unit-gate y se mueve a pre-merge", () => {
  const { dir, file } = sandbox();
  try {
    const cmd = "/opt/wrap.sh /Users/x/claude-cowork/scripts/unit-gate.sh --verbose";
    editar(file, (d) => { stage(wf(d, "claude-plan-codex-impl"), "tests").verifyCmd = cmd; });
    const r = run(file);
    assert.equal(r.status, 0, r.stderr);
    const w = wf(load(file), "claude-plan-codex-impl");
    assert.equal(stage(w, "pre-merge").verifyCmd, cmd);
    assert.equal(stage(w, "pre-merge").mergeGate, true);
    assert.equal(stage(w, "tests").verifyCmd, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gate irreconocible en tests con unit-gate en otro workflow: aborta sin escribir nada", () => {
  const { dir, file } = sandbox();
  try {
    editar(file, (d) => { stage(wf(d, "hotfix-verificado"), "tests").verifyCmd = "/opt/mi-gate-raro"; });
    const antes = readFileSync(file, "utf8");
    const r = run(file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /hotfix-verificado/);
    assert.equal(readFileSync(file, "utf8"), antes);
    assert.deepEqual(readdirSync(dir).sort(), ["workflows.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("workflow a medias (pre-merge presente y tests aún con unit-gate): aborta sin escribir nada", () => {
  const { dir, file } = sandbox();
  try {
    run(file);
    for (const f of readdirSync(dir)) if (f.includes(".bak-")) rmSync(join(dir, f));
    editar(file, (d) => { stage(wf(d, "claude-plan-codex-impl"), "tests").verifyCmd = UNIT_GATE; });
    const antes = readFileSync(file, "utf8");
    const r = run(file);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /claude-plan-codex-impl/);
    assert.equal(readFileSync(file, "utf8"), antes);
    assert.deepEqual(readdirSync(dir).sort(), ["workflows.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("el catálogo empaquetado (sin ningún verifyCmd) sigue migrando", () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-pre-merge-"));
  try {
    const file = join(dir, "workflows.json");
    copyFileSync(join(here, "..", "server", "data", "workflows.json"), file);
    assert.equal(run(file).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
