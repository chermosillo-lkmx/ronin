// Pruebas de scripts/unit-gate.sh: cada caso arma un origin bare + clon en un tmp, con un
// intérprete FALSO (MAIN_ROOT/<repo>/.venv/bin/python) que en vez de correr pytest copia el junit
// que elige la prueba (FAKE_SUITE_JUNIT). Así la regla 3 ve exactamente lo que queremos.
// Correr: node --test scripts/unit-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "unit-gate.sh");
const REPO = "ant-fake-api";
const TEST_FILE = "tests/test_app.py";

const junit = (cases) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<testsuites><testsuite name="pytest" tests="${cases.length}" ` +
  `failures="${cases.filter((c) => c.outcome === "failure").length}" ` +
  `errors="${cases.filter((c) => c.outcome === "error").length}" ` +
  `skipped="${cases.filter((c) => c.outcome === "skipped").length}">\n` +
  cases
    .map(
      ({ classname, name, outcome }) =>
        `<testcase classname="${classname}" name="${name}">` +
        (outcome === "failure" ? `<failure message="boom">boom</failure>` : "") +
        (outcome === "error" ? `<error message="boom">boom</error>` : "") +
        (outcome === "skipped" ? `<skipped message="needs db">needs db</skipped>` : "") +
        `</testcase>`,
    )
    .join("\n") +
  `\n</testsuite></testsuites>\n`;

const OTHER_PASS = { classname: "tests.test_other", name: "test_other", outcome: "passed" };
const APP = (outcome) => ({ classname: "tests.test_app", name: "test_app_db", outcome });

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "unit-gate-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) => sh("git", args, { cwd, env: gitEnv });

  const origin = join(tmp, "origin.git");
  const session = join(tmp, "session");
  const repo = join(session, REPO);
  const mainRoot = join(tmp, "main-root");
  mkdirSync(session, { recursive: true });
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(session, "clone", "-q", origin, REPO);

  const write = (rel, body) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  write(".gitignore", "reports/\n.venv/\n*.xml\n");
  write("pytest.ini", "[pytest]\n");
  write("src/app.py", "def f():\n    return 1\n");
  write(TEST_FILE, "def test_app_db():\n    assert True\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "checkout", "-q", "-b", "feat/x");
  write("src/app.py", "def f():\n    return 2\n");
  write(TEST_FILE, "def test_app_db():\n    assert 2 == 2\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");

  // Intérprete falso: `python -m pytest ... --junitxml=<p>` copia $FAKE_SUITE_JUNIT a <p>.
  const py = join(mainRoot, REPO, ".venv", "bin", "python");
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(
    py,
    `#!/bin/bash\nfor a in "$@"; do case "$a" in --junitxml=*) cp "$FAKE_SUITE_JUNIT" "\${a#--junitxml=}";; esac; done\necho "fake pytest"\nexit 0\n`,
  );
  chmodSync(py, 0o755);

  const suiteJunit = join(tmp, "suite.xml");
  return {
    tmp, repo,
    setSuite: (cases) => writeFileSync(suiteJunit, junit(cases)),
    writeJunit: (path, cases) => {
      const p = path.startsWith("/") ? path : join(repo, path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, junit(cases));
      return p;
    },
    run: (env = {}) => {
      const r = spawnSync("bash", [GATE, session], {
        encoding: "utf8",
        env: { ...gitEnv, UNIT_GATE_BASE: "origin/main", UNIT_GATE_MAIN_ROOT: mainRoot, FAKE_SUITE_JUNIT: suiteJunit, ...env },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
}

const withoutExtra = { UNIT_GATE_EXTRA_JUNIT: "" };

test("1. test tocado sólo con skips en la suite y sin junit extra → FAIL (caracterización)", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("skipped")]);
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NO aparecen ejecutados/);
  assert.match(r.out, /tests\/test_app\.py/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("2. junit extra fresco (ruta relativa al repo) donde el archivo pasa → PASS y lo dice", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("skipped")]);
  fx.writeJunit("reports/junit-realdb.xml", [APP("passed")]);
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: "reports/junit-realdb.xml" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ ant-fake-api: tests tocados ejecutados vía UNIT_GATE_EXTRA_JUNIT: tests\/test_app\.py/);
  assert.match(r.out, /UNIT-GATE: PASS/);
});

test("3. junit extra donde el archivo falla → FAIL con ❌ de la corrida extra", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("skipped")]);
  const p = fx.writeJunit("reports/junit-realdb.xml", [APP("passed"), { ...APP("failure"), name: "test_two" }]);
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: p });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ .*UNIT_GATE_EXTRA_JUNIT.*tests\/test_app\.py/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("4. junit extra que no existe → FAIL (nunca se ignora en silencio)", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]); // aun con la regla 2 cubierta por la suite
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: "reports/no-existe.xml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no-existe\.xml/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("4b. junit extra ilegible → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("skipped")]);
  mkdirSync(join(fx.repo, "reports"), { recursive: true });
  writeFileSync(join(fx.repo, "reports", "roto.xml"), "<testsuites><testcase");
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: "reports/roto.xml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /roto\.xml/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("5. junit extra anterior al último commit → FAIL por viejo", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("skipped")]);
  const p = fx.writeJunit("reports/junit-realdb.xml", [APP("passed")]);
  const old = new Date("2000-01-01T00:00:00Z");
  utimesSync(p, old, old);
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: "reports/junit-realdb.xml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /junit extra anterior al último commit: vuelve a correr esas pruebas/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("6. suite con un fallo + junit extra verde → sigue FAIL (la regla 3 no cambia)", (t) => {
  const fx = fixture(t);
  fx.setSuite([{ ...OTHER_PASS, outcome: "failure" }, APP("skipped")]);
  fx.writeJunit("reports/junit-realdb.xml", [APP("passed"), OTHER_PASS]);
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: "reports/junit-realdb.xml" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /suite en ROJO/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("7. dos junit extra separados por «:», el archivo lo cubre el segundo → PASS", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("skipped")]);
  const a = fx.writeJunit("reports/a.xml", [OTHER_PASS]);
  fx.writeJunit("reports/b.xml", [APP("passed")]);
  const r = fx.run({ UNIT_GATE_EXTRA_JUNIT: `${a}:reports/b.xml` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /vía UNIT_GATE_EXTRA_JUNIT: tests\/test_app\.py/);
  assert.match(r.out, /UNIT-GATE: PASS/);
});
