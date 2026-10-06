// Pruebas de scripts/unit-gate.sh: cada caso arma un origin bare + clon en un tmp, con un
// intérprete FALSO (MAIN_ROOT/<repo>/.venv/bin/python) que en vez de correr pytest copia el junit
// y el XML Cobertura que elige la prueba (FAKE_SUITE_JUNIT / FAKE_SUITE_COVERAGE). Así las reglas
// 3 y 4 ven exactamente lo que queremos.
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

const cobertura = ({ lineRate = 0.9, source, classes = [{ filename: "src/app.py", lines: [{ number: 2, hits: 1 }] }] }) =>
  `<?xml version="1.0" ?>\n<coverage line-rate="${lineRate}">\n` +
  `<sources><source>${source}</source></sources>\n<packages><package name="fake"><classes>\n` +
  classes.map(({ filename, lines }) =>
    `<class filename="${filename}"><lines>` +
    lines.map(({ number, hits }) => `<line number="${number}" hits="${hits}"/>`).join("") +
    `</lines></class>`,
  ).join("\n") +
  `\n</classes></package></packages>\n</coverage>\n`;

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
  write(".coveragerc", "[report]\nfail_under = 80\n");
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

  // Intérprete falso: copia los reportes elegidos a las rutas pedidas por pytest.
  const py = join(mainRoot, REPO, ".venv", "bin", "python");
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(
    py,
    `#!/bin/bash\nfor a in "$@"; do case "$a" in\n` +
    `  --junitxml=*) cp "$FAKE_SUITE_JUNIT" "\${a#--junitxml=}";;\n` +
    `  --cov-report=xml:*) [ -f "$FAKE_SUITE_COVERAGE" ] && cp "$FAKE_SUITE_COVERAGE" "\${a#--cov-report=xml:}";;\n` +
    `esac; done\necho "fake pytest"\nexit 0\n`,
  );
  chmodSync(py, 0o755);

  const suiteJunit = join(tmp, "suite.xml");
  const suiteCoverage = join(tmp, "coverage.xml");
  writeFileSync(suiteCoverage, cobertura({ source: repo }));
  return {
    tmp, repo,
    git: (...args) => git(repo, ...args),
    write,
    setSuite: (cases) => writeFileSync(suiteJunit, junit(cases)),
    setCoverage: (options = {}) => writeFileSync(suiteCoverage, cobertura({ source: repo, ...options })),
    removeCoverage: () => rmSync(suiteCoverage, { force: true }),
    writeJunit: (path, cases) => {
      const p = path.startsWith("/") ? path : join(repo, path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, junit(cases));
      return p;
    },
    run: (env = {}) => {
      const r = spawnSync("bash", [GATE, session], {
        encoding: "utf8",
        env: {
          ...gitEnv,
          UNIT_GATE_BASE: "origin/main",
          UNIT_GATE_MAIN_ROOT: mainRoot,
          FAKE_SUITE_JUNIT: suiteJunit,
          FAKE_SUITE_COVERAGE: suiteCoverage,
          ...env,
        },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
}

function nodeFixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "unit-gate-node-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) => sh("git", args, { cwd, env: gitEnv });
  const origin = join(tmp, "origin.git");
  const session = join(tmp, "session");
  const repo = join(session, "ant-fake-app");
  const fakeBin = join(tmp, "bin");
  mkdirSync(session, { recursive: true });
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(session, "clone", "-q", origin, "ant-fake-app");
  const write = (rel, body) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const config = (coverageBody) => `export default { test: { coverage: { ${coverageBody} } } };\n`;
  write(".gitignore", "reports/\nnode_modules/\n");
  write("package.json", "{}\n");
  write("vitest.config.ts", config("thresholds: { lines: 80 }"));
  write("src/app.ts", "export const f = () => 1;\n");
  write("tests/app.test.ts", "test('app f', () => expect(1).toBe(1));\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "checkout", "-q", "-b", "feat/x");
  write("src/app.ts", "export const f = () => 2;\n");
  write("tests/app.test.ts", "test('app f', () => expect(2).toBe(2));\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");
  mkdirSync(join(repo, "node_modules"), { recursive: true });

  const suiteJunit = join(tmp, "suite.xml");
  const suiteCoverage = join(tmp, "coverage.xml");
  writeFileSync(suiteJunit, junit([{ classname: "tests.app.test", name: "f", outcome: "passed" }]));
  writeFileSync(suiteCoverage, cobertura({
    source: repo,
    classes: [{ filename: "src/app.ts", lines: [{ number: 1, hits: 1 }] }],
  }));
  mkdirSync(fakeBin, { recursive: true });
  const npx = join(fakeBin, "npx");
  writeFileSync(
    npx,
    `#!/bin/bash\nfor a in "$@"; do case "$a" in --outputFile=*) cp "$FAKE_SUITE_JUNIT" "\${a#--outputFile=}";; esac; done\n` +
    `mkdir -p reports/coverage-gate\ncp "$FAKE_SUITE_COVERAGE" reports/coverage-gate/cobertura-coverage.xml\nexit 0\n`,
  );
  chmodSync(npx, 0o755);
  return {
    repo,
    write,
    config,
    setCoverage: (options = {}) => writeFileSync(suiteCoverage, cobertura({ source: repo, ...options })),
    run: () => {
      const r = spawnSync("bash", [GATE, session], {
        encoding: "utf8",
        env: {
          ...gitEnv,
          PATH: `${fakeBin}:${process.env.PATH}`,
          UNIT_GATE_BASE: "origin/main",
          FAKE_SUITE_JUNIT: suiteJunit,
          FAKE_SUITE_COVERAGE: suiteCoverage,
        },
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

test("8. línea nueva cubierta y cobertura total sobre el piso → PASS", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 líneas nuevas de src, todas cubiertas/);
  assert.match(r.out, /cobertura 90(?:\.00)? % ≥ piso 80(?:\.00)? %/);
  assert.match(r.out, /UNIT-GATE: PASS/);
});

test("9. línea nueva con hits=0 → FAIL y lista archivo:línea", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.setCoverage({ classes: [{ filename: "src/app.py", lines: [{ number: 2, hits: 0 }] }] });
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /líneas nuevas sin cubrir/);
  assert.match(r.out, /src\/app\.py:2/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("10. cobertura total debajo del piso → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.setCoverage({ lineRate: 0.799 });
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cobertura 79\.90 % < piso 80(?:\.00)? %/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("11. piso bajado respecto al merge-base → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write(".coveragerc", "[report]\nfail_under = 70\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /piso bajado de 80(?:\.00)? a 70(?:\.00)?/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("12. repo sin piso de cobertura declarado → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  rmSync(join(fx.repo, ".coveragerc"));
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sin piso de cobertura declarado/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("13. suite sin XML de cobertura → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.removeCoverage();
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no produjo .*coverage-gate\.xml/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("14. pragma: no cover agregado en src → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write("src/app.py", "def f():\n    return 2  # pragma: no cover\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /exclusión de cobertura agregada/);
  assert.match(r.out, /src\/app\.py:2.*pragma: no cover/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("15. entrada nueva en omit → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write(".coveragerc", "[run]\nomit =\n    src/generated.py\n[report]\nfail_under = 80\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /entrada nueva en omit\/coverage\.exclude/);
  assert.match(r.out, /\.coveragerc:3.*src\/generated\.py/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("16. archivo de src nuevo sin rastrear y cubierto → PASS", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write("src/new.py", "def new():\n    return 1\n");
  fx.write(TEST_FILE, "def test_app_db():\n    assert 2 == 2  # new\n");
  fx.setCoverage({ classes: [
    { filename: "src/app.py", lines: [{ number: 2, hits: 1 }] },
    { filename: "src/new.py", lines: [{ number: 2, hits: 1 }] },
  ] });
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /2 líneas nuevas de src, todas cubiertas/);
  assert.match(r.out, /UNIT-GATE: PASS/);
});

test("17. archivo de src nuevo sin rastrear con hits=0 → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write("src/new.py", "def new():\n    return 1\n");
  fx.write(TEST_FILE, "def test_app_db():\n    assert 2 == 2  # new\n");
  fx.setCoverage({ classes: [
    { filename: "src/app.py", lines: [{ number: 2, hits: 1 }] },
    { filename: "src/new.py", lines: [{ number: 2, hits: 0 }] },
  ] });
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /src\/new\.py:2/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("18. error interno al analizar Cobertura → FAIL cerrado", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.setCoverage({ lineRate: "NaN" });
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /analizador de cobertura falló/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("19. filename se resuelve primero contra source de Cobertura", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write("app.py", "def unrelated():\n    return 0\n");
  fx.setCoverage({ source: join(fx.repo, "src"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 1 }] }] });
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 líneas nuevas de src, todas cubiertas/);
});

test("20. piso en pyproject TOML se lee aunque haya listas multilínea", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  rmSync(join(fx.repo, ".coveragerc"));
  fx.write("pyproject.toml", "[project]\ndependencies = [\n  'x',\n]\n[tool.coverage.report]\nfail_under = 80\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cobertura 90\.00 % ≥ piso 80\.00 %/);
});

test("21. Node usa Cobertura y coverage.thresholds.lines → PASS", (t) => {
  const fx = nodeFixture(t);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /vitest run --coverage --coverage\.reporter=cobertura/);
  assert.match(r.out, /1 líneas nuevas de src, todas cubiertas/);
  assert.match(r.out, /cobertura 90\.00 % ≥ piso 80\.00 %/);
});

test("22. thresholds.lines fuera de coverage no declara piso Node", (t) => {
  const fx = nodeFixture(t);
  fx.write("vitest.config.ts", "export default { test: { thresholds: { lines: 80 }, coverage: {} } };\n");
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sin piso de cobertura declarado/);
});

test("23. exclude agregado con una variable dentro de coverage → FAIL", (t) => {
  const fx = nodeFixture(t);
  fx.write("vitest.config.ts", "const excluded = ['src/new.ts'];\n" + fx.config("thresholds: { lines: 80 }, exclude: excluded"));
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /entrada nueva en omit\/coverage\.exclude/);
  assert.match(r.out, /vitest\.config\.ts:2.*exclude: excluded/);
});

test("24. archivo JavaScript nuevo ausente de Cobertura → FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write("src/new.js", "export const value = 1;\n");
  fx.write(TEST_FILE, "def test_app_db():\n    assert 2 == 2  # new\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no aparece en el reporte de cobertura.*src\/new\.js/);
});

test("25. thresholds comentado no declara piso Node", (t) => {
  const fx = nodeFixture(t);
  fx.write("vitest.config.ts", fx.config("// thresholds: { lines: 80 }"));
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sin piso de cobertura declarado/);
});

test("26. exclude multilínea agregado dentro de coverage → FAIL", (t) => {
  const fx = nodeFixture(t);
  fx.write("vitest.config.ts", "const excluded = ['src/new.ts'];\n" + fx.config("thresholds: { lines: 80 },\nexclude:\n  excluded"));
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /entrada nueva en omit\/coverage\.exclude/);
  assert.match(r.out, /vitest\.config\.ts:3.*exclude:/);
});

test("27. fail_under TOML acepta comentario inline", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  rmSync(join(fx.repo, ".coveragerc"));
  fx.write("pyproject.toml", "[tool.coverage.report]\nfail_under = 80 # minimum required\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cobertura 90\.00 % ≥ piso 80\.00 %/);
});

test("28. Node: stories y .d.ts dentro de src (fuera de la cobertura) no cuentan como src sin reporte → PASS", (t) => {
  const fx = nodeFixture(t);
  fx.write("src/app.stories.tsx", "export default { title: 'App' };\n");
  fx.write("src/types.d.ts", "export type X = number;\n");
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /no aparece en el reporte de cobertura/);
});

test("29. Python: src cambiado bajo un omit que YA existía en main → aviso, no FAIL", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  fx.write(".coveragerc", "[run]\nomit =\n    src/legacy/*\n[report]\nfail_under = 80\n");
  fx.write("src/legacy/old.py", "def g():\n    return 1\n");
  fx.git("add", "-A");
  fx.git("commit", "-q", "-m", "legacy omit");
  fx.git("push", "-q", "origin", "HEAD:main");
  fx.git("fetch", "-q", "origin");
  fx.write("src/legacy/old.py", "def g():\n    return 2\n");
  fx.write(TEST_FILE, "def test_app_db():\n    assert 3 == 3\n");
  fx.write("src/app.py", "def f():\n    return 3\n");
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚠.*omit.*src\/legacy\/old\.py/);
  assert.doesNotMatch(r.out, /no aparece en el reporte de cobertura/);
});

// ── Detección del directorio de código de producto por repo (lib/source-dirs.sh) ──
// Un repo de servicio no siempre guarda su código en src/: messaging-gateway lo tiene en hub/
// (pyproject `[tool.setuptools.packages.find] include = ["hub*"]`). Antes el gate leía un cambio en
// hub/ sin tests como «sin cambios en src» y medía la cobertura sobre --cov=src (nada).
function layoutFixture(t, { name = "messaging-fake", base, change }) {
  const tmp = mkdtempSync(join(tmpdir(), "unit-gate-layout-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (cwd, ...args) => sh("git", args, { cwd, env: gitEnv });
  const origin = join(tmp, "origin.git");
  const session = join(tmp, "session");
  const repo = join(session, name);
  const mainRoot = join(tmp, "main-root");
  mkdirSync(session, { recursive: true });
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(session, "clone", "-q", origin, name);
  const write = (rel, body) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  write(".gitignore", "reports/\n.venv/\n*.xml\n");
  write("tests/test_app.py", "def test_app_db():\n    assert True\n");
  for (const [rel, body] of Object.entries(base)) write(rel, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "checkout", "-q", "-b", "feat/x");
  for (const [rel, body] of Object.entries(change)) write(rel, body);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change");

  const py = join(mainRoot, name, ".venv", "bin", "python");
  mkdirSync(dirname(py), { recursive: true });
  writeFileSync(
    py,
    `#!/bin/bash\nfor a in "$@"; do case "$a" in\n` +
    `  --junitxml=*) cp "$FAKE_SUITE_JUNIT" "\${a#--junitxml=}";;\n` +
    `  --cov-report=xml:*) [ -f "$FAKE_SUITE_COVERAGE" ] && cp "$FAKE_SUITE_COVERAGE" "\${a#--cov-report=xml:}";;\n` +
    `esac; done\necho "fake pytest"\nexit 0\n`,
  );
  chmodSync(py, 0o755);
  const suiteJunit = join(tmp, "suite.xml");
  const suiteCoverage = join(tmp, "coverage.xml");
  writeFileSync(suiteJunit, junit([OTHER_PASS, APP("passed")]));
  return {
    repo, session, mainRoot,
    setCoverage: (options = {}) => writeFileSync(suiteCoverage, cobertura({ source: repo, ...options })),
    run: (script = GATE, env = {}) => {
      const r = spawnSync("bash", [script, session], {
        encoding: "utf8",
        env: {
          ...gitEnv,
          UNIT_GATE_BASE: "origin/main",
          UNIT_GATE_MAIN_ROOT: mainRoot,
          UNIT_GATE_EXTRA_JUNIT: "",
          FAKE_SUITE_JUNIT: suiteJunit,
          FAKE_SUITE_COVERAGE: suiteCoverage,
          ...env,
        },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
}

const HUB_PYPROJECT =
  "[project]\nname = 'mg'\n\n[tool.setuptools.packages.find]\ninclude = [\"hub*\"]\n\n" +
  "[tool.coverage.report]\nfail_under = 80\n";

test("30. layout hub/ (packages.find): cambio en hub/ sin tests → FAIL de la regla 1", (t) => {
  const fx = layoutFixture(t, {
    base: { "pyproject.toml": HUB_PYPROJECT, "hub/app.py": "def f():\n    return 1\n" },
    change: { "hub/app.py": "def f():\n    return 2\n" },
  });
  fx.setCoverage({ source: join(fx.repo, "hub"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 1 }] }] });
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hay cambios en código de producto sin ningún cambio en tests/);
  assert.match(r.out, /^\s+hub\/app\.py$/m);
  assert.doesNotMatch(r.out, /sin cambios en src/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("31. layout hub/ con tests: --cov=hub y las líneas nuevas se resuelven contra <source>/hub → PASS", (t) => {
  const fx = layoutFixture(t, {
    base: { "pyproject.toml": HUB_PYPROJECT, "hub/app.py": "def f():\n    return 1\n" },
    change: { "hub/app.py": "def f():\n    return 2\n", "tests/test_app.py": "def test_app_db():\n    assert 2 == 2\n" },
  });
  fx.setCoverage({ source: join(fx.repo, "hub"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 1 }] }] });
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /--cov=hub /);
  assert.doesNotMatch(r.out, /--cov=src/);
  assert.match(r.out, /1 líneas nuevas de hub, todas cubiertas/);
  assert.match(r.out, /UNIT-GATE: PASS/);
});

test("32. layout hub/ con línea nueva sin cubrir → FAIL con hub/app.py:2", (t) => {
  const fx = layoutFixture(t, {
    base: { "pyproject.toml": HUB_PYPROJECT, "hub/app.py": "def f():\n    return 1\n" },
    change: { "hub/app.py": "def f():\n    return 2\n", "tests/test_app.py": "def test_app_db():\n    assert 2 == 2\n" },
  });
  fx.setCoverage({ source: join(fx.repo, "hub"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 0 }] }] });
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /líneas nuevas sin cubrir: hub\/app\.py:2/);
});

test("33. coverage `source` declarado gana sobre src/ y packages.find (una --cov por directorio)", (t) => {
  const fx = layoutFixture(t, {
    base: {
      ".coveragerc": "[run]\nsource =\n    hub\n    tools\n[report]\nfail_under = 80\n",
      "pyproject.toml": "[tool.setuptools.packages.find]\ninclude = [\"other*\"]\n",
      "src/script.py": "x = 1\n",
      "hub/app.py": "def f():\n    return 1\n",
      "tools/t.py": "y = 1\n",
    },
    change: { "hub/app.py": "def f():\n    return 2\n", "src/script.py": "x = 2\n" },
  });
  fx.setCoverage({ source: join(fx.repo, "hub"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 1 }] }] });
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /hay cambios en código de producto sin ningún cambio en tests/);
  assert.match(r.out, /^\s+hub\/app\.py$/m);
  assert.doesNotMatch(r.out, /^\s+src\/script\.py$/m);
  assert.match(r.out, /--cov=hub --cov=tools /);
});

test("34. pyproject [tool.coverage.run] source (lista TOML) también declara el directorio", (t) => {
  const fx = layoutFixture(t, {
    base: {
      "pyproject.toml": "[tool.coverage.run]\nsource = [\"hub\"]\n\n[tool.coverage.report]\nfail_under = 80\n",
      "hub/app.py": "def f():\n    return 1\n",
    },
    change: { "hub/app.py": "def f():\n    return 2\n" },
  });
  fx.setCoverage({ source: join(fx.repo, "hub"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 1 }] }] });
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^\s+hub\/app\.py$/m);
  assert.match(r.out, /--cov=hub /);
});

test("35. repo src/ sin source declarado: sigue siendo src aunque packages.find diga otra cosa", (t) => {
  const fx = layoutFixture(t, {
    base: {
      "pyproject.toml": "[tool.setuptools.packages.find]\ninclude = [\"hub*\"]\n\n[tool.coverage.report]\nfail_under = 80\n",
      "src/app.py": "def f():\n    return 1\n",
      "hub/x.py": "z = 1\n",
    },
    change: { "src/app.py": "def f():\n    return 2\n", "tests/test_app.py": "def test_app_db():\n    assert 2 == 2\n" },
  });
  fx.setCoverage();
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /--cov=src /);
  assert.match(r.out, /1 líneas nuevas de src, todas cubiertas/);
});

test("36. src repo clásico: el comando y los mensajes no cambian", (t) => {
  const fx = fixture(t);
  fx.setSuite([OTHER_PASS, APP("passed")]);
  const r = fx.run(withoutExtra);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /-p no:cacheprovider --cov=src --cov-report=xml:reports\/coverage-gate\.xml/);
  assert.match(r.out, /1 archivo\(s\) de src con 1 archivo\(s\) de tests tocados/);
});

test("37. sin src/, sin source y sin packages.find → FAIL cerrado «no sé dónde está el código»", (t) => {
  const fx = layoutFixture(t, {
    name: "ant-misterio",
    base: { "pyproject.toml": "[tool.coverage.report]\nfail_under = 80\n", "pkg/app.py": "def f():\n    return 1\n" },
    change: { "pkg/app.py": "def f():\n    return 2\n" },
  });
  fx.setCoverage();
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no sé dónde está el código de producto de ant-misterio/);
  assert.match(r.out, /UNIT-GATE: FAIL/);
});

test("38. source declarado que no existe en el repo → FAIL cerrado", (t) => {
  const fx = layoutFixture(t, {
    base: { ".coveragerc": "[run]\nsource = nope\n[report]\nfail_under = 80\n", "src/app.py": "x = 1\n" },
    change: { "src/app.py": "x = 2\n" },
  });
  fx.setCoverage();
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no sé dónde está el código de producto de messaging-fake/);
});

// ── i18n-gate.sh usa la misma detección ──
const I18N_GATE = join(dirname(fileURLToPath(import.meta.url)), "i18n-gate.sh");
function i18nRun(fx) {
  const catalog = join(fx.mainRoot, "ant-ms-i18n", "src", "database", "migrations", "versions");
  mkdirSync(catalog, { recursive: true });
  writeFileSync(join(catalog, "001_seed.py"), "CODES = ['KNOWN_CODE']\n");
  return fx.run(I18N_GATE, { I18N_GATE_BASE: "origin/main", I18N_GATE_MAIN_ROOT: fx.mainRoot });
}

test("39. i18n-gate: un 4xx con literal añadido bajo hub/ → FAIL (antes ni veía el repo)", (t) => {
  const fx = layoutFixture(t, {
    base: { "pyproject.toml": HUB_PYPROJECT, "hub/app.py": "def f():\n    return 1\n" },
    change: { "hub/app.py": "def f():\n    raise HTTPException(status_code=404, detail=\"Not found\")\n" },
  });
  const r = i18nRun(fx);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /── messaging-fake/);
  assert.match(r.out, /4xx nuevos con mensaje escrito a mano/);
  assert.match(r.out, /I18N-GATE: FAIL/);
});

test("40. i18n-gate: cambio fuera del código de producto (tests/) no cuenta como línea nueva", (t) => {
  const fx = layoutFixture(t, {
    base: { "pyproject.toml": HUB_PYPROJECT, "hub/app.py": "def f():\n    return 1\n" },
    change: { "tests/test_app.py": "def test_app_db():\n    raise HTTPException(status_code=404, detail=\"x\")\n" },
  });
  const r = i18nRun(fx);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /messaging-fake: sin líneas nuevas bajo hub\/ — se omite/);
  assert.match(r.out, /I18N-GATE: PASS/);
});

test("41. i18n-gate: repo de servicio con tests/ pero sin código detectable → FAIL cerrado", (t) => {
  const fx = layoutFixture(t, {
    name: "ant-misterio",
    base: { "pkg/app.py": "def f():\n    return 1\n" },
    change: { "pkg/app.py": "def f():\n    return 2\n" },
  });
  const r = i18nRun(fx);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no sé dónde está el código de producto de ant-misterio/);
  assert.match(r.out, /I18N-GATE: FAIL/);
});

test("42. setup.cfg [coverage:run] source también declara el directorio", (t) => {
  const fx = layoutFixture(t, {
    base: {
      "setup.cfg": "[metadata]\nname = mg\n[coverage:run]\nsource = hub\n[coverage:report]\nfail_under = 80\n",
      "hub/app.py": "def f():\n    return 1\n",
    },
    change: { "hub/app.py": "def f():\n    return 2\n" },
  });
  fx.setCoverage({ source: join(fx.repo, "hub"), classes: [{ filename: "app.py", lines: [{ number: 2, hits: 1 }] }] });
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^\s+hub\/app\.py$/m);
  assert.match(r.out, /--cov=hub /);
});
