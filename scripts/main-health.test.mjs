import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "main-health.sh");
const REPO = "ant-health-api";

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} → ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function junit(cases) {
  const count = (outcome) => cases.filter((item) => item.outcome === outcome).length;
  return `<?xml version="1.0"?><testsuites><testsuite tests="${cases.length}" failures="${count("failure")}" errors="${count("error")}" skipped="${count("skipped")}">` +
    cases.map(({ classname, name, outcome = "passed", reason = "" }) =>
      `<testcase classname="${classname}" name="${name}">` +
      (outcome === "failure" ? `<failure message="${reason}">${reason}</failure>` : "") +
      (outcome === "error" ? `<error message="${reason}">${reason}</error>` : "") +
      (outcome === "skipped" ? `<skipped message="${reason}">${reason}</skipped>` : "") +
      `</testcase>`,
    ).join("") + `</testsuite></testsuites>\n`;
}

const coverage = `<?xml version="1.0"?><coverage line-rate="0.90"><packages><package><classes>` +
  `<class filename="src/app.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class>` +
  `</classes></package></packages></coverage>\n`;

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "main-health-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, "repos");
  const healthDir = join(root, "health");
  const origin = join(root, "origin.git");
  const repo = join(repoRoot, REPO);
  const fakeGate = join(root, "fake-unit-gate.sh");
  const marker = join(root, "suite-count");
  const sourceJunit = join(root, "junit.xml");
  const sourceCoverage = join(root, "coverage.xml");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  mkdirSync(repoRoot, { recursive: true });
  sh("git", ["init", "-q", "--bare", "-b", "main", origin], { cwd: root, env: gitEnv });
  sh("git", ["clone", "-q", origin, repo], { cwd: root, env: gitEnv });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  if (options.pyprojectFloor) {
    writeFileSync(join(repo, "pyproject.toml"),
      `[tool.coverage.run]\nsource = ["src"]\n\n` +
      `[tool.coverage.report]\nfail_under = ${options.pyprojectFloor}\nexclude_lines = [\n  "pragma: no cover",\n  "if TYPE_CHECKING:",\n]\n`);
  } else {
    writeFileSync(join(repo, ".coveragerc"), "[run]\nsource = src\n[report]\nfail_under = 80\n");
  }
  if (options.setupFloor) {
    writeFileSync(join(repo, "setup.cfg"), `[coverage:report]\nfail_under = ${options.setupFloor}\n`);
  }
  writeFileSync(join(repo, "pytest.ini"), "[pytest]\n");
  if (options.packageManager) {
    writeFileSync(join(repo, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    if (options.packageManager === "pnpm") writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    else writeFileSync(join(repo, "package-lock.json"), '{"lockfileVersion":3}\n');
  }
  writeFileSync(join(repo, "src/app.py"), "def f():\n    return 1\n");
  writeFileSync(join(repo, "tests/test_app.py"), "def test_f():\n    assert True\n");
  sh("git", ["add", "-A"], { cwd: repo, env: gitEnv });
  sh("git", ["commit", "-q", "-m", "main"], { cwd: repo, env: gitEnv });
  sh("git", ["push", "-q", "origin", "HEAD:main"], { cwd: repo, env: gitEnv });
  const sha = sh("git", ["rev-parse", "HEAD"], { cwd: repo, env: gitEnv });

  writeFileSync(
    fakeGate,
    `#!/bin/bash\n` +
      `set -u\n` +
      `wt="$1"\n` +
      `n=0; [ ! -f "$FAKE_MARKER" ] || n="$(cat "$FAKE_MARKER")"; printf '%s\\n' "$((n+1))" > "$FAKE_MARKER"\n` +
      `[ -z "\${FAKE_SUITE_LOG:-}" ] || printf 'suite\\n' >> "$FAKE_SUITE_LOG"\n` +
      `[ -z "\${FAKE_WT_LOG:-}" ] || printf '%s\\n' "$wt" >> "$FAKE_WT_LOG"\n` +
      `[ -z "\${FAKE_GATE_STARTED:-}" ] || : > "$FAKE_GATE_STARTED"\n` +
      `[ -z "\${FAKE_GATE_DELAY:-}" ] || sleep "$FAKE_GATE_DELAY"\n` +
      `mkdir -p "$wt/reports"\n` +
      `[ "\${FAKE_NO_JUNIT:-0}" = 1 ] || cp "$FAKE_JUNIT" "$wt/reports/junit-gate.xml"\n` +
      `[ -f "$FAKE_COVERAGE" ] && cp "$FAKE_COVERAGE" "$wt/reports/coverage-gate.xml"\n` +
      `printf 'salida simulada\\n' > "$wt/reports/unit-gate.log"\n` +
      `exit "\${FAKE_GATE_RC:-0}"\n`,
  );
  chmodSync(fakeGate, 0o755);
  writeFileSync(sourceCoverage, coverage);

  const baseEnv = {
    ...gitEnv,
    MAIN_HEALTH_REPO_ROOT: repoRoot,
    MAIN_HEALTH_DIR: healthDir,
    MAIN_HEALTH_UNIT_GATE: fakeGate,
    MAIN_HEALTH_POLL: "0.05",
    FAKE_MARKER: marker,
    FAKE_JUNIT: sourceJunit,
    FAKE_COVERAGE: sourceCoverage,
  };
  const run = (env = {}, args = []) => {
    const result = spawnSync("bash", [SCRIPT, REPO, "--sha", sha, ...args], {
      encoding: "utf8",
      env: { ...baseEnv, ...env },
    });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  const spawnRun = (env = {}, targetSha = sha) => spawn("bash", [SCRIPT, REPO, "--sha", targetSha], {
    env: { ...baseEnv, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const jsonPath = join(healthDir, REPO, `${sha}.json`);
  const errorPath = join(healthDir, REPO, `${sha}.error.json`);
  const lockPath = join(healthDir, REPO, `${sha}.lock`);
  return {
    root, repo, healthDir, sha, marker, sourceJunit, jsonPath, errorPath, lockPath, gitEnv, baseEnv,
    run, spawnRun,
    setJunit: (cases) => writeFileSync(sourceJunit, junit(cases)),
    setRawJunit: (xml) => writeFileSync(sourceJunit, xml),
    setRawCoverage: (xml) => writeFileSync(sourceCoverage, xml),
  };
}

const passingCases = [
  { classname: "tests.test_app", name: "test_f", outcome: "passed" },
  { classname: "tests.test_app", name: "test_optional", outcome: "skipped", reason: "needs db" },
];

test("main-health mide main y escribe todos los campos del JSON", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  const result = fx.run();
  assert.equal(result.code, 0, result.out);
  const data = JSON.parse(readFileSync(fx.jsonPath, "utf8"));
  assert.deepEqual(data, {
    sha: fx.sha,
    repo: REPO,
    status: "green",
    tests: 2,
    total: 90,
    floor: 80,
    failed: [],
    errors: [],
    skipped: 1,
    skipped_by_reason: { "needs db": 1 },
    uncovered_by_file: { "src/app.py": [2] },
    duration: data.duration,
    at: data.at,
    gate_rc: 0,
  });
  assert.equal(typeof data.duration, "number");
  assert.ok(data.duration >= 0);
  assert.equal(typeof data.at, "number");
  assert.equal(existsSync(join(fx.healthDir, REPO, `wt-${fx.sha.slice(0, 7)}`, REPO)), false);
  assert.doesNotMatch(sh("git", ["worktree", "list", "--porcelain"], { cwd: fx.repo }), /wt-/);
});

test("main-health devuelve la caché inmediatamente sin volver a correr la suite", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  assert.equal(fx.run().code, 0);
  const cached = readFileSync(fx.jsonPath, "utf8");
  const result = fx.run({ FAKE_GATE_RC: "99" });
  assert.equal(result.code, 0, result.out);
  assert.equal(result.out.trim(), cached.trim());
  assert.equal(readFileSync(fx.marker, "utf8").trim(), "1");
});

test("main-health imprime una caché roja, sale 1 y no corre la suite", (t) => {
  const fx = fixture(t);
  mkdirSync(dirname(fx.jsonPath), { recursive: true });
  const cached = JSON.stringify({ sha: fx.sha, repo: REPO, status: "red", failed: ["tests.test_app::test_f"] }) + "\n";
  writeFileSync(fx.jsonPath, cached);
  const result = fx.run({ FAKE_GATE_RC: "99" });
  assert.equal(result.code, 1, result.out);
  assert.equal(result.out, cached);
  assert.equal(existsSync(fx.marker), false, result.out);
});

test("main-health rechaza nombres de repo con traversal antes de escribir rutas", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  const escapeRepo = join(fx.root, "escape");
  symlinkSync(fx.repo, escapeRepo);
  const result = spawnSync("bash", [SCRIPT, "../escape", "--sha", fx.sha], {
    encoding: "utf8",
    env: fx.baseEnv,
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /repo.*inválido|nombre.*repo/i);
  assert.equal(existsSync(join(escapeRepo, `${fx.sha}.json`)), false);
  assert.equal(existsSync(fx.marker), false);
});

test("main-health espera un lock vivo hasta que aparece su JSON", async (t) => {
  const fx = fixture(t);
  mkdirSync(fx.lockPath, { recursive: true });
  writeFileSync(join(fx.lockPath, "owner"), `${process.pid} dueño-vivo\n`);
  const child = fx.spawnRun();
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(existsSync(fx.marker), false, output);
  mkdirSync(dirname(fx.jsonPath), { recursive: true });
  writeFileSync(fx.jsonPath, JSON.stringify({ sha: fx.sha, status: "green" }) + "\n");
  assert.equal(await closed, 0, output);
  assert.equal(existsSync(fx.marker), false, output);
});

test("main-health no roba un lock mientras su dueño todavía publica el token", async (t) => {
  const fx = fixture(t);
  mkdirSync(fx.lockPath, { recursive: true });
  const fakeBin = join(fx.root, "fake-bin");
  const signal = join(fx.root, "primer-cat-pid");
  const realCat = sh("bash", ["-c", "command -v cat"]);
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "cat"),
    `#!/bin/bash\nif [ "$1" = "$FAKE_LOCK_PID" ] && [ ! -f "$FAKE_CAT_SIGNAL" ]; then : > "$FAKE_CAT_SIGNAL"; exit 0; fi\n` +
    `exec "${realCat}" "$@"\n`);
  chmodSync(join(fakeBin, "cat"), 0o755);
  const child = fx.spawnRun({
    PATH: `${fakeBin}:${process.env.PATH}`,
    FAKE_LOCK_PID: join(fx.lockPath, "owner"),
    FAKE_CAT_SIGNAL: signal,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const deadline = Date.now() + 2000;
  while (!existsSync(signal) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(existsSync(signal), true, output);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const survived = existsSync(fx.lockPath);
  if (survived) {
    writeFileSync(join(fx.lockPath, "owner"), `${process.pid} dueño-publicado\n`);
    writeFileSync(fx.jsonPath, JSON.stringify({ sha: fx.sha, status: "green" }) + "\n");
  }
  await closed;
  assert.equal(survived, true, `se robó el lock durante su inicialización\n${output}`);
  assert.equal(existsSync(fx.marker), false, output);
});

test("dos productores concurrentes del mismo SHA ejecutan una sola suite", async (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  const fakeBin = join(fx.root, "fake-bin");
  const publicationSignal = join(fx.root, "publicacion-demorada");
  const suiteLog = join(fx.root, "suite.log");
  const realMkdir = sh("bash", ["-c", "command -v mkdir"]);
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "mkdir"),
    `#!/bin/bash\n` +
    `"${realMkdir}" "$@"; rc=$?\n` +
    `last="\${!#}"\n` +
    `if [ "$rc" -eq 0 ] && [[ "$last" == *.lock ]] && "${realMkdir}" "$FAKE_PUBLICATION_SIGNAL" 2>/dev/null; then sleep 0.2; fi\n` +
    `exit "$rc"\n`);
  chmodSync(join(fakeBin, "mkdir"), 0o755);
  const env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    MAIN_HEALTH_LOCK_GRACE: "0.01",
    FAKE_PUBLICATION_SIGNAL: publicationSignal,
    FAKE_SUITE_LOG: suiteLog,
    FAKE_GATE_DELAY: "0.1",
  };
  const collect = (child) => new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => resolve({ code, output }));
  });
  const first = collect(fx.spawnRun(env));
  const deadline = Date.now() + 2000;
  while (!existsSync(publicationSignal) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(existsSync(publicationSignal), true);
  const second = collect(fx.spawnRun(env));
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0], results.map(({ output }) => output).join("\n"));
  assert.equal(readFileSync(suiteLog, "utf8").trim().split("\n").length, 1);
  assert.equal(results[0].output.trim(), results[1].output.trim());
});

test("dos SHA con el mismo prefijo serializan la ruta compartida del worktree", async (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  let otherSha = "";
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    writeFileSync(join(fx.repo, "src/app.py"), `def f():\n    return ${attempt + 1}\n`);
    sh("git", ["add", "src/app.py"], { cwd: fx.repo, env: fx.gitEnv });
    sh("git", ["commit", "-q", "-m", `candidato ${attempt}`], { cwd: fx.repo, env: fx.gitEnv });
    const candidate = sh("git", ["rev-parse", "HEAD"], { cwd: fx.repo, env: fx.gitEnv });
    if (candidate[0] === fx.sha[0]) { otherSha = candidate; break; }
  }
  assert.notEqual(otherSha, "", "no se encontró una colisión del primer dígito");
  const worktreeLog = join(fx.root, "worktrees.log");
  const env = {
    MAIN_HEALTH_WORKTREE_PREFIX_LENGTH: "1",
    FAKE_WT_LOG: worktreeLog,
    FAKE_GATE_DELAY: "0.15",
  };
  const collect = (child) => new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => resolve({ code, output }));
  });
  const results = await Promise.all([
    collect(fx.spawnRun(env, fx.sha)),
    collect(fx.spawnRun(env, otherSha)),
  ]);
  assert.deepEqual(results.map(({ code }) => code), [0, 0], results.map(({ output }) => output).join("\n"));
  const paths = readFileSync(worktreeLog, "utf8").trim().split("\n");
  assert.equal(paths.length, 2);
  assert.equal(paths[0], paths[1]);
  assert.match(paths[0], new RegExp(`/wt-${fx.sha[0]}/${REPO}$`));
});

test("un waiter terminado no elimina el worktree activo del dueño del path-lock", async (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  let otherSha = "";
  for (let attempt = 1; attempt <= 64; attempt += 1) {
    writeFileSync(join(fx.repo, "src/app.py"), `def f():\n    return ${attempt + 1}\n`);
    sh("git", ["add", "src/app.py"], { cwd: fx.repo, env: fx.gitEnv });
    sh("git", ["commit", "-q", "-m", `waiter ${attempt}`], { cwd: fx.repo, env: fx.gitEnv });
    const candidate = sh("git", ["rev-parse", "HEAD"], { cwd: fx.repo, env: fx.gitEnv });
    if (candidate[0] === fx.sha[0]) { otherSha = candidate; break; }
  }
  assert.notEqual(otherSha, "", "no se encontró una colisión del primer dígito");
  const started = join(fx.root, "owner-started");
  const env = {
    MAIN_HEALTH_WORKTREE_PREFIX_LENGTH: "1",
    FAKE_GATE_STARTED: started,
    FAKE_GATE_DELAY: "0.5",
  };
  const collect = (child) => new Promise((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("close", (code) => resolve({ code, output }));
  });
  const ownerChild = fx.spawnRun(env, fx.sha);
  const ownerResult = collect(ownerChild);
  const startedDeadline = Date.now() + 3000;
  while (!existsSync(started) && Date.now() < startedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(started), true);
  const worktree = join(fx.healthDir, REPO, `wt-${fx.sha[0]}`, REPO);
  assert.equal(existsSync(worktree), true);

  const waiterChild = fx.spawnRun(env, otherSha);
  const waiterResult = collect(waiterChild);
  const waiterLock = join(fx.healthDir, REPO, `${otherSha}.lock`);
  const waiterDeadline = Date.now() + 3000;
  while (!existsSync(waiterLock) && Date.now() < waiterDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(existsSync(waiterLock), true);
  waiterChild.kill("SIGTERM");
  const waiter = await waiterResult;
  assert.equal(waiter.code, 143, waiter.output);
  assert.equal(existsSync(worktree), true, "el waiter eliminó el worktree del dueño activo");
  assert.match(sh("git", ["worktree", "list", "--porcelain"], { cwd: fx.repo }), new RegExp(`worktree .*/wt-${fx.sha[0]}/${REPO}`));
  const owner = await ownerResult;
  assert.equal(owner.code, 0, owner.output);
});

test("main-health roba un lock cuyo PID murió", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  mkdirSync(fx.lockPath, { recursive: true });
  writeFileSync(join(fx.lockPath, "owner"), "99999999 dueño-muerto\n");
  const result = fx.run();
  assert.equal(result.code, 0, result.out);
  assert.equal(readFileSync(fx.marker, "utf8").trim(), "1");
  assert.equal(existsSync(fx.lockPath), false);
});

test("main-health recupera y limpia un worktree residual al robar un lock muerto", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  const residual = join(fx.healthDir, REPO, `wt-${fx.sha.slice(0, 7)}`, REPO);
  mkdirSync(dirname(residual), { recursive: true });
  sh("git", ["worktree", "add", "-q", "--detach", residual, fx.sha], { cwd: fx.repo });
  mkdirSync(fx.lockPath, { recursive: true });
  writeFileSync(join(fx.lockPath, "owner"), "99999999 dueño-muerto\n");
  const result = fx.run();
  assert.equal(result.code, 0, result.out);
  assert.equal(existsSync(residual), false, result.out);
  assert.doesNotMatch(sh("git", ["worktree", "list", "--porcelain"], { cwd: fx.repo }), /wt-/);
});

test("main-health escribe error JSON y sale 2 cuando no hay junit", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  const result = fx.run({ FAKE_NO_JUNIT: "1", FAKE_GATE_RC: "1" });
  assert.equal(result.code, 2, result.out);
  assert.equal(existsSync(fx.jsonPath), false);
  const error = JSON.parse(readFileSync(fx.errorPath, "utf8"));
  assert.equal(error.sha, fx.sha);
  assert.match(error.reason, /junit/i);
  assert.equal(typeof error.at, "number");
  assert.match(error.log_tail, /salida simulada/);
});

test("main-health publica error JSON cuando falla la instalación", (t) => {
  const fx = fixture(t, { packageManager: "pnpm" });
  fx.setJunit(passingCases);
  const fakeBin = join(fx.root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "pnpm"), "#!/bin/bash\necho 'falló install simulado' >&2\nexit 42\n");
  chmodSync(join(fakeBin, "pnpm"), 0o755);
  const result = fx.run({ PATH: `${fakeBin}:${process.env.PATH}` });
  assert.equal(result.code, 2, result.out);
  assert.equal(existsSync(fx.jsonPath), false);
  const error = JSON.parse(readFileSync(fx.errorPath, "utf8"));
  assert.match(error.reason, /instalación.*pnpm/i);
  assert.match(error.log_tail, /falló install simulado/);
});

test("main-health publica error JSON cuando el JUnit está malformado", (t) => {
  const fx = fixture(t);
  fx.setRawJunit("<testsuites><testsuite>");
  const result = fx.run();
  assert.equal(result.code, 2, result.out);
  assert.equal(existsSync(fx.jsonPath), false);
  const error = JSON.parse(readFileSync(fx.errorPath, "utf8"));
  assert.match(error.reason, /JUnit.*malformado/i);
  assert.equal(typeof error.log_tail, "string");
});

test("main-health publica error JSON cuando Cobertura está malformada", (t) => {
  const fx = fixture(t);
  fx.setJunit(passingCases);
  fx.setRawCoverage("<coverage><packages>");
  const result = fx.run();
  assert.equal(result.code, 2, result.out);
  assert.equal(existsSync(fx.jsonPath), false);
  const error = JSON.parse(readFileSync(fx.errorPath, "utf8"));
  assert.match(error.reason, /Cobertura.*malformado/i);
  assert.equal(typeof error.log_tail, "string");
});

test("main-health conserva una suite roja como medición roja y sale 1", (t) => {
  const fx = fixture(t);
  fx.setJunit([
    { classname: "tests.test_app", name: "test_f", outcome: "failure", reason: "boom" },
    { classname: "tests.test_app", name: "test_setup", outcome: "error", reason: "bad fixture" },
  ]);
  const result = fx.run({ FAKE_GATE_RC: "1" });
  assert.equal(result.code, 1, result.out);
  const data = JSON.parse(readFileSync(fx.jsonPath, "utf8"));
  assert.equal(data.status, "red");
  assert.deepEqual(data.failed, ["tests.test_app::test_f"]);
  assert.deepEqual(data.errors, ["tests.test_app::test_setup"]);
  assert.equal(data.gate_rc, 1);
});

test("main-health lee fail_under de un pyproject TOML multilineal válido", (t) => {
  const fx = fixture(t, { pyprojectFloor: 95 });
  fx.setJunit(passingCases);
  const result = fx.run();
  assert.equal(result.code, 1, result.out);
  const data = JSON.parse(readFileSync(fx.jsonPath, "utf8"));
  assert.equal(data.floor, 95);
  assert.equal(data.total, 90);
  assert.equal(data.status, "red");
});

test("main-health da precedencia a pyproject.toml sobre setup.cfg", (t) => {
  const fx = fixture(t, { pyprojectFloor: 95, setupFloor: 80 });
  fx.setJunit(passingCases);
  const result = fx.run();
  assert.equal(result.code, 1, result.out);
  const data = JSON.parse(readFileSync(fx.jsonPath, "utf8"));
  assert.equal(data.floor, 95);
  assert.equal(data.total, 90);
  assert.equal(data.status, "red");
});
