import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runRgr } from "./fixture-runner.mjs";

const skillRoot = new URL("../", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", skillRoot));
const rgrLogLibrary = fileURLToPath(new URL("harness/rgr-log.sh", skillRoot));

test("test:desktop includes the tmux worker harness suite", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", skillRoot), "utf8"));
  const command = packageJson.scripts["test:desktop"];

  assert.ok(command.split(/\s+/).includes("skills/tmux-worker-loop/harness/harness.test.mjs"));
});

test("skills README distinguishes installed harness files from cycle artifacts", async () => {
  const readme = await readFile(new URL("../README.md", skillRoot), "utf8");
  const lines = readme.split("\n");
  const installedStart = lines.findIndex((line) => line.includes("Archivos instalables de `harness/`"));
  const artifactsStart = lines.findIndex((line) => line.includes("Artefactos efímeros de cada ciclo"));

  assert.ok(installedStart >= 0);
  assert.ok(artifactsStart > installedStart);
  const installedLines = lines.slice(installedStart, artifactsStart);
  const artifactLines = lines.slice(artifactsStart);
  for (const file of [
    "rgr.sh", "verify-rgr.sh", "probe-repo.sh", "fitness.sh", "gate-layout.sh",
    "rgr-log.sh", "fixture-runner.mjs", "harness.test.mjs",
  ]) {
    assert.ok(installedLines.some((line) => line.includes(`\`${file}\``)), `missing installed harness file: ${file}`);
  }
  for (const executable of ["rgr.sh", "verify-rgr.sh", "probe-repo.sh", "fitness.sh", "gate-layout.sh"]) {
    const line = installedLines.find((candidate) => candidate.includes(`\`${executable}\``));
    assert.ok(line.includes("ejecutable"), `missing executable category: ${executable}`);
  }
  assert.ok(installedLines.find((line) => line.includes("`rgr-log.sh`"))?.includes("biblioteca sourceada"));
  assert.ok(installedLines.find((line) => line.includes("`fixture-runner.mjs`"))?.includes("sin aserciones"));
  for (const artifact of ["harness.<slot>.env", "worktrees.env", ".rgr-index", "harness.provenance"]) {
    assert.ok(artifactLines.some((line) => line.includes(`\`${artifact}\``)), `missing cycle artifact: ${artifact}`);
  }
  assert.ok(artifactLines.some((line) => line.includes("no se instalan")));
});

test("the Implementer prompt delegates RGR evidence to the harness", async () => {
  const prompt = await readFile(new URL("implementer_prompt_template.md", skillRoot), "utf8");

  for (const command of ["rgr.sh red", "rgr.sh green", "rgr.sh verify-catches", "rgr.sh refactor"]) {
    assert.ok(prompt.includes(command), `missing harness command: ${command}`);
  }
  assert.ok(prompt.includes("derived from a real fixture run"));
  assert.ok(prompt.includes("word boundary"));
  assert.ok(prompt.includes("print the resolved path"));
  assert.ok(prompt.includes("confirm it is the file you intend"));
  assert.ok(prompt.includes("tests-diff="));
  assert.ok(prompt.includes("BASELINE_REF"));
  assert.ok(prompt.includes("rgr.sh is the only sanctioned exception"));
  assert.ok(prompt.includes("Never push"));
  assert.ok(prompt.includes("fitness.sh"));
  assert.ok(prompt.includes("skills/README.md"));
  assert.ok(!prompt.includes("TESTS-TOUCHED-IN-REFACTOR"));
  assert.ok(!prompt.includes("exact pytest summary lines"));
});

test("the Reviewer prompt trusts only covered gate evidence and audits semantic risk", async () => {
  const prompt = await readFile(new URL("reviewer_prompt_template.md", skillRoot), "utf8");

  assert.ok(prompt.includes("verify-rgr.md"));
  assert.ok(prompt.includes("verify it independently"));
  assert.ok(prompt.includes("not covered"));
  assert.ok(prompt.includes("warnings and exceptions"));
  assert.ok(!prompt.includes("are established evidence"));
  assert.ok(prompt.includes("catches=n/a"));
  assert.ok(prompt.includes("not mutation-verified"));
  assert.ok(prompt.includes("scope creep"));
  assert.ok(prompt.includes("$TEST_CMD_*"));
  assert.ok(prompt.includes("no sensor enforces"));
  assert.ok(prompt.includes("if I revert the fix, does this test go red?"));
  assert.ok(!prompt.includes("The log is the Implementer's claim, not evidence."));
  assert.ok(!prompt.includes("**A. Was RED real?**"));
  assert.ok(!prompt.includes("**B. Was REFACTOR behavior-preserving?**"));
  assert.ok(!prompt.includes("**D. Does the cycle count match the plan?**"));
});

test("the Brain prompt assigns repository fitness rules to fitness.sh", async () => {
  const prompt = await readFile(new URL("brain_prompt_template.md", skillRoot), "utf8");

  assert.ok(prompt.includes("fitness.sh"));
  assert.ok(!prompt.includes("Alembic revision ids must be ≤32 chars"));
  assert.ok(!prompt.includes("YYYYMMDD_<short-slug>"));
});

test("SKILL setup provisions and probes declared worktrees before dispatch", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.ok(skill.includes('S="${TMUX_WORKER_SKILL_SRC:-$HOME/.claude/skills/tmux-worker-loop}"'));
  assert.ok(skill.includes('cp -R "$S/harness" "$D"/'));
  assert.ok(skill.includes('skill_source=$(cd "$S" && pwd -P)'));
  assert.ok(skill.includes('skill_head=$(git -C "$skill_source" rev-parse HEAD)'));
  assert.ok(skill.includes('rgr_sha=$(git -C "$skill_source" hash-object "$skill_source/harness/rgr.sh")'));
  assert.ok(skill.includes("rgr-sha=$rgr_sha"));
  assert.ok(skill.indexOf('cp -R "$S/harness" "$D"/') < skill.indexOf("rgr-sha=$rgr_sha"));
  assert.ok(skill.includes('"$D/gate-layout.sh" "$win" "$main" "$brain" "$reviewer" "$impl"'));
  assert.ok(skill.includes("worktrees.env"));
  assert.ok(skill.includes("pwd -P"));
  const declared = skill.indexOf("Write `worktrees.env`");
  const provisioned = skill.indexOf("Provision dependencies", declared);
  const probed = skill.indexOf('probe-repo.sh "$slot"', provisioned);
  const rendered = skill.indexOf("Render each template", probed);
  assert.ok(declared >= 0 && declared < provisioned && provisioned < probed && probed < rendered);
  assert.ok(!skill.includes('[ "$n" = 4 ] && [ "$ids" = 4 ] && [ "$uniq" = 4 ]'));
});

test("SKILL gates semantic review on verify-rgr evidence", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  const gate = skill.indexOf('CYCLE_DIR="$D" "$D/harness/verify-rgr.sh"');
  const review = skill.indexOf("Run the Reviewer's **diff pass**", gate);
  assert.ok(gate >= 0 && gate < review);
  assert.ok(skill.includes("verify-rgr.md"));
  assert.ok(skill.includes("harness.<slot>.env"));
  assert.ok(skill.includes("DECLARED EXCEPTIONS"));
  assert.ok(skill.includes("--scope key=value"));
  assert.ok(!skill.includes("code + tests + KB + `rgr.log`"));
  assert.ok(!skill.includes("reads plan.md, the diff, and rgr.log"));
  assert.ok(!skill.includes("Check `<CYCLE_DIR>/rgr.log` exists"));
});

test("SKILL closes verified cycles with a steering loop and explicit limits", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.ok(skill.includes("## Steering loop"));
  assert.ok(skill.includes("MISSING"));
  assert.ok(skill.includes("DEPS_OK"));
  assert.ok(skill.includes('git update-ref --stdin'));
  assert.ok(skill.includes("refs/rgr/<cycle-id>"));
  assert.ok(skill.includes("git gc"));
  assert.ok(skill.includes("voluntary sentinels"));
  assert.ok(skill.includes('"Never push" has no sensor'));
  assert.ok(!skill.includes("demand the exact pytest summary lines"));
  assert.ok(!skill.includes("Implementer works in strict **RED → GREEN → REFACTOR** cycles, one behavior per cycle, and\nappends each cycle"));
});

test("SKILL inventories the complete harness and its generated state", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  for (const file of [
    "rgr.sh", "verify-rgr.sh", "probe-repo.sh", "fitness.sh", "gate-layout.sh", "rgr-log.sh",
    "fixture-runner.mjs", "harness.test.mjs", "harness.<slot>.env", "worktrees.env", ".rgr-index", "verify-rgr.md",
    "harness.provenance",
  ]) {
    assert.ok(skill.includes(`\`${file}\``), `missing SKILL inventory entry for ${file}`);
  }
  assert.match(skill, /`rgr-log\.sh`[^\n]*sourced library/);
  assert.match(skill, /`fixture-runner\.mjs`[^\n]*outside `TEST_GLOBS`[^\n]*no assertions/);
});

test("engine handoffs preserve the harness contract and cycle-directory access", async () => {
  const engines = await readFile(new URL("references/engines.md", skillRoot), "utf8");
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.ok(engines.includes("harness.<slot>.env"));
  assert.ok(engines.includes("rgr.sh"));
  assert.ok(engines.includes("CYCLE_DIR"));
  assert.ok(engines.includes("--add-dir $D"));
  assert.ok(engines.includes('git -C "$WT" rev-parse --path-format=absolute --git-common-dir'));
  assert.ok(engines.includes("--add-dir $GIT_COMMON_DIR"));
  assert.ok(skill.includes('git -C "$WT" rev-parse --path-format=absolute --git-common-dir'));
  assert.ok(skill.includes("--add-dir $GIT_COMMON_DIR"));
  assert.ok(engines.includes("Codex sandbox has no network"));
});

test("provisioned panes mirror the executable harness workflow", async () => {
  const reference = await readFile(new URL("references/provisioned-panes.md", skillRoot), "utf8");

  assert.ok(reference.includes('S="${TMUX_WORKER_SKILL_SRC:-$HOME/.claude/skills/tmux-worker-loop}"'));
  assert.ok(reference.includes('cp -R "$S/harness" "$CYCLE_DIR"/'));
  assert.ok(reference.includes("expect_engine"));
  assert.ok(reference.includes("|| exit 1"));
  assert.ok(reference.includes("verify-rgr.md"));
  assert.ok(reference.includes("harness.<slot>.env"));
  assert.ok(reference.includes("worktrees.env"));
  assert.ok(reference.includes("harness.provenance"));
  assert.ok(!reference.includes("expect_model"));
  assert.ok(!reference.includes("code + tests + KB + `rgr.log`"));
  assert.ok(!reference.includes("for each cycle, was RED real"));
});

test("SKILL derives test execution and baselines from the probed slot contract", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");
  const workflow = skill.match(/```dot[\s\S]*?```/)?.[0] ?? "";

  assert.ok(workflow.includes("Provision dependencies"));
  assert.ok(workflow.includes("probe-repo.sh"));
  assert.ok(workflow.indexOf("Provision dependencies") < workflow.indexOf("probe-repo.sh"));
  assert.ok(skill.includes("$TEST_CMD_*"));
  assert.ok(!skill.includes("pytest -q --tb=no"));
  assert.ok(!skill.includes("baseline worktree on `origin/main`"));
});

function callRgrLog(functionName, ...args) {
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      '. "$1"\nfunction_name=$2\nshift 2\n"$function_name" "$@"',
      "rgr-log-test",
      rgrLogLibrary,
      functionName,
      ...args,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.replace(/\n$/, "");
}

function parseRgrLogLine(line) {
  const fields = callRgrLog("rgr_log_parse", line)
    .split("\n")
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      assert.notEqual(separator, -1, `invalid parsed pair: ${pair}`);
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    });
  return Object.fromEntries(fields);
}

function parseRgrLog(log) {
  let cycle = null;
  return log.trimEnd().split("\n").filter(Boolean).map((line) => {
    const parsed = parseRgrLogLine(line);
    if (parsed.record === "CYCLE") cycle = parsed.cycle;
    if (["RED", "GREEN", "CATCHES", "REFACTOR"].includes(parsed.record)) {
      parsed.cycle = cycle;
    }
    return { line, ...parsed };
  });
}

function findRgrRecord(log, record, cycle = null) {
  return parseRgrLog(log).find(
    (entry) => entry.record === record && (cycle === null || entry.cycle === String(cycle)),
  );
}

function rgrRecords(log, record) {
  return parseRgrLog(log).filter((entry) => entry.record === record);
}

function buildRgrLogLine(parsed) {
  const args = [parsed.record];
  if (parsed.record === "CYCLE") args.push(parsed.cycle);
  for (const [key, value] of Object.entries(parsed)) {
    if (["line", "record", "cycle"].includes(key)) continue;
    args.push(key, value);
  }
  return callRgrLog("rgr_log_build", ...args);
}

function replaceRgrLogField(log, record, key, value, cycle = null) {
  const target = findRgrRecord(log, record, cycle);
  assert.ok(target, `missing ${record} record`);
  const replacement = buildRgrLogLine({ ...target, [key]: value });
  return log.replace(target.line, replacement);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeGitBlob(cwd, content) {
  const result = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd,
    input: content,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initGitRepo(prefix) {
  const root = await mkdtemp(`${tmpdir()}/${prefix}-`);
  git(root, "init", "-q");
  git(root, "config", "user.email", "rgr@example.invalid");
  git(root, "config", "user.name", "RGR Harness");
  return root;
}

// FIXTURE ENVIRONMENT CONTRACT
// When this harness runs its own tests under a JUnit reporter, NODE_OPTIONS is
// inherited by the fixture's child suites. Their output then stops being the
// TAP/JUnit format the fixture requested and looks like a child-test failure.
// Every fixture rgr invocation must remove that parent-only reporter setting.
async function createRgrFixture(testSource, { captureBaseline = true } = {}) {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-cycle-`);
  const worktree = await initGitRepo("rgr-worktree");
  await writeFile(`${worktree}/.gitignore`, "node_modules/\ndist/\n");
  await writeFile(`${worktree}/package.json`, '{"type":"module"}\n');
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "baseline");
  const baseline = git(worktree, "rev-parse", "HEAD");
  await writeFile(`${worktree}/behavior.test.mjs`, testSource);
  await writeFile(`${cycleDir}/worktrees.env`, `fixture=${await realpath(worktree)}\n`);
  await writeFile(
    `${cycleDir}/harness.fixture.env`,
    [
      "STACK=node",
      "TEST_CMD_N=1",
      "TEST_CMD_1=node --test",
      "TEST_ONE_CMD=node --test --test-reporter=tap",
      "TEST_GLOBS=*.test.mjs",
      "DOC_GLOBS=README.md docs/**",
      "IGNORE_GLOBS=package-lock.json",
      "SNAPSHOT_EXCLUDE=node_modules dist build .next coverage",
      "PASS_FORMAT=node-tap",
      "FAILSET_FORMAT=node-junit",
      "BASELINE_FAILSET=",
      "BASELINE_FAILURES_N=0",
      "BASELINE_AT=",
      "DEPS_OK=yes",
      "TEST_TIMEOUT=5",
      "LINT_CMD=",
      "TYPECHECK_CMD=",
      "COVERAGE_CMD=",
      `BASELINE_REF=${baseline}`,
      "FITNESS=",
      "MISSING=lint,coverage,ci",
      "",
    ].join("\n"),
  );
  const harnessSha = git(worktree, "hash-object", fileURLToPath(new URL("harness/rgr.sh", skillRoot)));
  const skillHead = git(fileURLToPath(skillRoot), "rev-parse", "HEAD");
  await writeFile(
    `${cycleDir}/harness.provenance`,
    `source=${fileURLToPath(skillRoot)}\nhead=${skillHead}\nrgr-sha=${harnessSha}\n`,
  );
  const fixture = { cycleDir, worktree };
  if (captureBaseline) {
    const baseline = runRgr(fixture, "baseline");
    assert.equal(baseline.status, 0, baseline.stderr);
  }
  return fixture;
}

function runVerify(cycleDir, ...args) {
  return spawnSync(fileURLToPath(new URL("harness/verify-rgr.sh", skillRoot)), args, {
    cwd: repoRoot,
    env: { ...process.env, CYCLE_DIR: cycleDir },
    encoding: "utf8",
  });
}

function anchoredDynamicAllowOutside(cycleDir, path, slot, interval, reason) {
  const baseArgs = [
    "--allow-outside", path,
    "--scope", `slot=${slot}`,
    "--scope", `interval=${interval}`,
  ];
  const unanchored = runVerify(cycleDir, ...baseArgs, "--reason", reason);
  assert.equal(unanchored.status, 2, unanchored.stdout);
  const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const remedy = unanchored.stdout.match(new RegExp(
    `^check=declaration type=allow-outside subject=${escapedPath} .*error=missing-to-tree actual=([0-9a-f]{40}) remedy=".*--scope to-tree=\\1.*"$`,
    "m",
  ));
  assert.ok(remedy, unanchored.stdout);
  return {
    tree: remedy[1],
    args: [...baseArgs, "--scope", `to-tree=${remedy[1]}`, "--reason", reason],
  };
}

// G1 FIXTURE CONTRACT
// The first real g1 verification found that the original positive fixture put
// feature.mjs after BASELINE_REF, so it claimed a clean cycle with unjustified
// production already present. Commit the failing production state first; the
// only BASELINE→RED change is then the test that demonstrates the behavior.
async function createClosedRgrFixture(testName = "verified cycle", { captureCatches = true } = {}) {
  const fixture = await createRgrFixture(
    `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest(${JSON.stringify(testName)}, () => assert.equal(value, 1));\n`,
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  git(fixture.worktree, "add", "feature.mjs");
  git(fixture.worktree, "commit", "-qm", "feature baseline");
  const baseline = git(fixture.worktree, "rev-parse", "HEAD");
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace(/^BASELINE_REF=.*$/m, `BASELINE_REF=${baseline}`);
  await writeFile(envPath, envText);
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.equal(
    runRgr(fixture, "red", testName, "--test-file", "behavior.test.mjs", "--name", testName).status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  if (captureCatches) {
    assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  }
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture export is already cohesive").status, 0);
  return fixture;
}

function moveCycleRefs(fixture, fromCycle, toCycle) {
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const oldPrefix = `refs/rgr/${cycleId}/${fromCycle}`;
  const refs = git(fixture.worktree, "for-each-ref", "--format=%(refname) %(objectname)", oldPrefix)
    .split("\n")
    .filter(Boolean);
  for (const line of refs) {
    const separator = line.indexOf(" ");
    const oldRef = line.slice(0, separator);
    const object = line.slice(separator + 1);
    const newRef = oldRef.replace(`${oldPrefix}/`, `refs/rgr/${cycleId}/${toCycle}/`);
    git(fixture.worktree, "update-ref", newRef, object);
    git(fixture.worktree, "update-ref", "-d", oldRef);
  }
}

function copyCycleRefs(fixture, fromCycle, toCycle) {
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const oldPrefix = `refs/rgr/${cycleId}/${fromCycle}`;
  const refs = git(fixture.worktree, "for-each-ref", "--format=%(refname) %(objectname)", oldPrefix)
    .split("\n")
    .filter(Boolean);
  for (const line of refs) {
    const separator = line.indexOf(" ");
    const oldRef = line.slice(0, separator);
    const object = line.slice(separator + 1);
    const newRef = oldRef.replace(`${oldPrefix}/`, `refs/rgr/${cycleId}/${toCycle}/`);
    git(fixture.worktree, "update-ref", newRef, object);
  }
}

function runFitness(cycleDir, ...args) {
  return spawnSync(fileURLToPath(new URL("harness/fitness.sh", skillRoot)), args, {
    cwd: repoRoot,
    env: { ...process.env, CYCLE_DIR: cycleDir },
    encoding: "utf8",
  });
}

test("expect_engine gates all three worker launches", async () => {
  const engines = await readFile(new URL("references/engines.md", skillRoot), "utf8");
  const modelGate = engines.match(/MENU='Do you trust the contents of'[\s\S]*?```/)?.[0];
  assert.ok(modelGate);
  const calls = modelGate
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => /^expect_engine \"\$(brain|reviewer|impl)\"/.test(line));

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call, /\|\| exit 1$/);
  }
});

test("SKILL delegates layout validation to the executable gate", async () => {
  const skill = await readFile(new URL("SKILL.md", skillRoot), "utf8");

  assert.ok(skill.includes('"$D/gate-layout.sh" "$win" "$main" "$brain" "$reviewer" "$impl"'));
  assert.ok(!skill.includes('[ "$n" = 4 ] && [ "$ids" = 4 ] && [ "$uniq" = 4 ]'));
});

test("probe-repo is executable and documents its slot contract", async () => {
  const scriptUrl = new URL("harness/probe-repo.sh", skillRoot);
  const metadata = await stat(scriptUrl).catch(() => null);

  assert.ok(metadata, "probe-repo.sh must exist");
  assert.notEqual(metadata.mode & 0o111, 0, "probe-repo.sh must be executable");
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env bash/);
  assert.match(source, /WHY THIS EXISTS/);
  assert.match(source, /Usage: probe-repo\.sh <slot>/);
  assert.match(source, /Env: CYCLE_DIR/);
  assert.match(source, /^set -u$/m);
  assert.doesNotMatch(source, /^set -e|pipefail/m);
});

test("probe-repo emits the claude-cowork Node contract for a declared slot", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-node-`);
  const physicalRoot = await realpath(repoRoot);
  await writeFile(`${cycleDir}/worktrees.env`, `rgr=${physicalRoot}\n`);

  const result = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["rgr"],
    { cwd: repoRoot, env: { ...process.env, CYCLE_DIR: cycleDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const envText = await readFile(`${cycleDir}/harness.rgr.env`, "utf8").catch(() => null);
  assert.ok(envText, "probe must write harness.rgr.env");
  assert.match(envText, /^STACK=node$/m);
  assert.match(envText, /^TEST_CMD_N=3$/m);
  assert.match(envText, /^TEST_CMD_1=npm test -w server$/m);
  assert.match(envText, /^TEST_CMD_2=npm test -w web$/m);
  assert.match(envText, /^TEST_CMD_3=npm run test:desktop$/m);
  assert.match(envText, /^TEST_ONE_CMD=node --import tsx --test --test-reporter=tap$/m);
  assert.match(envText, /^PASS_FORMAT=node-tap$/m);
  assert.match(envText, /^SNAPSHOT_EXCLUDE=node_modules dist build \.next coverage$/m);
  assert.match(envText, /^DEPS_OK=yes$/m);
  assert.match(envText, /^MISSING=.*lint/m);
  assert.doesNotMatch(envText, /tests:all/);
});

test("probe-repo rejects a declared repo without a detectable test command", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-unknown-cycle-`);
  const worktree = await mkdtemp(`${tmpdir()}/rgr-probe-unknown-worktree-`);
  await writeFile(`${worktree}/package.json`, '{"scripts":{}}\n');
  await writeFile(`${cycleDir}/worktrees.env`, `unknown=${await realpath(worktree)}\n`);

  const result = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["unknown"],
    { env: { ...process.env, CYCLE_DIR: cycleDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no detectable test command.*define the harness contract explicitly/);
});

test("probe-repo rejects duplicate slots and duplicate physical paths", async () => {
  const physicalRoot = await realpath(repoRoot);
  const cases = [
    `rgr=${physicalRoot}\nrgr=/private/tmp/another-worktree\n`,
    `rgr=${physicalRoot}\nsecond=${physicalRoot}\n`,
  ];

  for (const [index, registry] of cases.entries()) {
    const cycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-duplicate-${index}-`);
    await writeFile(`${cycleDir}/worktrees.env`, registry);
    const result = spawnSync(
      fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
      ["rgr"],
      { env: { ...process.env, CYCLE_DIR: cycleDir }, encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate (slot|physical path)/);
  }
});

test("probe-repo detects pytest and the Alembic fitness rule statically", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-python-cycle-`);
  const worktree = await initGitRepo("rgr-probe-python-worktree");
  await mkdir(`${worktree}/alembic/versions`, { recursive: true });
  await writeFile(`${worktree}/pyproject.toml`, "[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n");
  await writeFile(`${worktree}/alembic.ini`, "[alembic]\nscript_location = alembic\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "fixture");
  await writeFile(`${cycleDir}/worktrees.env`, `api=${await realpath(worktree)}\n`);

  const result = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["api"],
    { env: { ...process.env, CYCLE_DIR: cycleDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const envText = await readFile(`${cycleDir}/harness.api.env`, "utf8").catch(() => null);
  assert.ok(envText, "probe must write harness.api.env");
  assert.match(envText, /^STACK=python$/m);
  assert.match(envText, /^PASS_FORMAT=pytest$/m);
  assert.match(envText, /^SNAPSHOT_EXCLUDE=\.venv venv __pycache__ \.pytest_cache \*\.egg-info$/m);
  assert.match(envText, /^FITNESS=alembic32$/m);
});

test("probe-repo emits the failure-baseline contract for Node suites", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-failset-`);
  const physicalRoot = await realpath(repoRoot);
  await writeFile(`${cycleDir}/worktrees.env`, `rgr=${physicalRoot}\n`);

  const result = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["rgr"],
    { cwd: repoRoot, env: { ...process.env, CYCLE_DIR: cycleDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const envText = await readFile(`${cycleDir}/harness.rgr.env`, "utf8");
  assert.match(envText, /^FAILSET_FORMAT=node-junit$/m);
  assert.match(envText, /^BASELINE_FAILSET=$/m);
  assert.match(envText, /^BASELINE_FAILURES_N=0$/m);
  assert.match(envText, /^BASELINE_AT=$/m);
});

test("probe-repo emits the failure-baseline contract for pytest suites", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-py-failset-`);
  const worktree = await initGitRepo("rgr-probe-py-failset-worktree");
  await writeFile(`${worktree}/pyproject.toml`, "[tool.pytest.ini_options]\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "fixture");
  await writeFile(`${cycleDir}/worktrees.env`, `api=${await realpath(worktree)}\n`);

  const result = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["api"],
    { env: { ...process.env, CYCLE_DIR: cycleDir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const envText = await readFile(`${cycleDir}/harness.api.env`, "utf8");
  assert.match(envText, /^FAILSET_FORMAT=pytest-rc$/m);
  assert.match(envText, /^BASELINE_FAILSET=$/m);
});

test("gate-layout is executable and documents its five-argument contract", async () => {
  const scriptUrl = new URL("harness/gate-layout.sh", skillRoot);
  const metadata = await stat(scriptUrl).catch(() => null);

  assert.ok(metadata, "gate-layout.sh must exist");
  assert.notEqual(metadata.mode & 0o111, 0, "gate-layout.sh must be executable");
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env bash/);
  assert.match(source, /WHY THIS EXISTS/);
  assert.match(source, /Usage: gate-layout\.sh <window> <main> <brain> <reviewer> <implementer>/);
  assert.match(source, /^set -u$/m);
  assert.doesNotMatch(source, /^set -e|pipefail/m);
});

test("gate-layout rejects a three-pane tmux window", async () => {
  const binDir = await mkdtemp(`${tmpdir()}/rgr-layout-bin-`);
  await writeFile(`${binDir}/tmux`, "#!/bin/sh\nprintf '%s\\n' '%11' '%12' '%13'\n");
  await chmod(`${binDir}/tmux`, 0o755);

  const result = spawnSync(
    fileURLToPath(new URL("harness/gate-layout.sh", skillRoot)),
    ["fixture:0", "%11", "%12", "%13", "%13"],
    { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /LAYOUT FAIL: panes=3 ids=4 uniq=3/);
});

test("fitness is executable and documents its slot contract", async () => {
  const scriptUrl = new URL("harness/fitness.sh", skillRoot);
  const metadata = await stat(scriptUrl).catch(() => null);

  assert.ok(metadata, "fitness.sh must exist");
  assert.notEqual(metadata.mode & 0o111, 0, "fitness.sh must be executable");
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env bash/);
  assert.match(source, /WHY THIS EXISTS/);
  assert.match(source, /Usage: fitness\.sh <slot>/);
  assert.match(source, /Env: CYCLE_DIR/);
  assert.match(source, /^set -u$/m);
  assert.doesNotMatch(source, /^set -e|pipefail/m);
});

test("fitness rejects overlong Alembic revisions in both supported declarations", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-fitness-cycle-`);
  const worktree = await initGitRepo("rgr-fitness-worktree");
  await mkdir(`${worktree}/alembic/versions`, { recursive: true });
  await writeFile(`${worktree}/alembic/README`, "migration fixtures\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-qm", "baseline");
  const baseline = git(worktree, "rev-parse", "HEAD");
  const plainRevision = "1234567890123456789012345678901234567890";
  const typedRevision = "abcdefghijabcdefghijabcdefghijabcdefghij";
  await writeFile(`${worktree}/alembic/versions/plain.py`, `revision = "${plainRevision}"\n`);
  await writeFile(`${worktree}/alembic/versions/typed.py`, `revision: str = "${typedRevision}"\n`);
  await writeFile(`${cycleDir}/worktrees.env`, `api=${await realpath(worktree)}\n`);
  await writeFile(
    `${cycleDir}/harness.api.env`,
    `BASELINE_REF=${baseline}\nFITNESS=alembic32\n`,
  );

  const result = runFitness(cycleDir, "api");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /alembic\/versions\/plain\.py/);
  assert.match(result.stderr, new RegExp(plainRevision));
  assert.match(result.stderr, /alembic\/versions\/typed\.py/);
  assert.match(result.stderr, new RegExp(typedRevision));
});

test("rgr is executable and documents its subcommands and cycle environment", async () => {
  const scriptUrl = new URL("harness/rgr.sh", skillRoot);
  const metadata = await stat(scriptUrl).catch(() => null);

  assert.ok(metadata, "rgr.sh must exist");
  assert.notEqual(metadata.mode & 0o111, 0, "rgr.sh must be executable");
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env bash/);
  assert.match(source, /WHY THIS EXISTS/);
  assert.match(source, /Usage: rgr\.sh \[--repo <slot>\] <red\|green\|verify-catches\|refactor\|baseline\|repair>/);
  assert.match(source, /Env: CYCLE_DIR/);
  assert.match(source, /^set -u$/m);
  assert.doesNotMatch(source, /^set -e|pipefail/m);
});

test("plan case 12: rgr rejects cwd outside every declared worktree", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("outside cwd", () => {});\n',
    { captureBaseline: false },
  );
  const result = spawnSync(
    fileURLToPath(new URL("harness/rgr.sh", skillRoot)),
    ["red", "outside cwd", "--test-file", "behavior.test.mjs", "--name", "outside cwd"],
    {
      cwd: repoRoot,
      env: { ...process.env, CYCLE_DIR: fixture.cycleDir },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 4);
  assert.match(result.stderr, /cwd resolves outside declared worktrees/);
  const physicalWorktree = await realpath(fixture.worktree);
  assert.ok(result.stderr.includes(`fixture=${physicalWorktree}`));
});

test("plan case 47: rgr resolves a declared worktree reached through a symlink", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("symlink slot", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  const linkRoot = await mkdtemp(`${tmpdir()}/rgr-worktree-link-`);
  const linkedWorktree = `${linkRoot}/linked`;
  await symlink(fixture.worktree, linkedWorktree);
  await writeFile(`${fixture.cycleDir}/worktrees.env`, `fixture=${linkedWorktree}\n`);

  const result = runRgr(fixture, "red", "resolve symlink slot", "--test-file", "behavior.test.mjs", "--name", "symlink slot");
  assert.equal(result.status, 0, result.stderr);
});

test("rgr log construction and parsing have one shared library owner", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("shared log owner", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "share the log format", "--test-file", "behavior.test.mjs", "--name", "shared log owner").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture export is already cohesive").status, 0);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");

  const metadata = await stat(rgrLogLibrary).catch(() => null);
  assert.ok(metadata, "rgr-log.sh must exist");
  assert.equal(metadata.mode & 0o111, 0, "rgr-log.sh is sourced, not executed");
  const library = await readFile(rgrLogLibrary, "utf8");
  assert.match(library, /WHY THIS EXISTS/);
  assert.match(library, /revisions 6, 7, 8, and 11/);
  assert.match(library, /FORMAT FROZEN: 2026-09-10/);
  assert.match(library, /actual suite process status/);
  assert.match(library, /constructor, parser, verify-rgr\.sh, and\s+# the fixture tests in the same cycle/);

  for (const parsed of parseRgrLog(log)) {
    assert.equal(buildRgrLogLine(parsed), parsed.line);
  }

  const refactor = findRgrRecord(log, "REFACTOR", 1);
  assert.match(refactor["status-suite-1"], /^[0-9a-f]{40}$/);
  assert.equal(refactor["suite-tests"], "1");
  assert.equal(refactor.pass, "1");
  assert.equal(refactor["suite-fail"], "0");
  assert.equal(refactor.note, "NONE: direct fixture export is already cohesive");

  const rgrSource = await readFile(new URL("harness/rgr.sh", skillRoot), "utf8");
  const verifySource = await readFile(new URL("harness/verify-rgr.sh", skillRoot), "utf8");
  for (const source of [rgrSource, verifySource]) {
    assert.match(source, /\. "\$script_dir\/rgr-log\.sh"/);
    assert.doesNotMatch(
      source,
      /^(?:log_escape|plain_log_field|quoted_log_field|plain_field|quoted_field|cycle_phase_line|phase_line)\(\)/m,
    );
  }
});

test("rgr log first-record preserves malformed-input failure status", async () => {
  const logPath = `${await mkdtemp(`${tmpdir()}/rgr-malformed-log-`)}/rgr.log`;
  await writeFile(
    logPath,
    "not-a-record\nBASELINE at=x slot=rgr seq=001 failset=deadbeef fails=0 by=impl\n",
  );
  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      '. "$1"\nrgr_log_first_record "$2" BASELINE',
      "rgr-log-test",
      rgrLogLibrary,
      logPath,
    ],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
});

test("rgr red rejects a selected test that passes on its first run", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("already works", () => {});\n',
  );

  const result = runRgr(
    fixture,
    "red",
    "behavior already exists",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "already works",
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /passed on the first run.*already exists.*asserts nothing.*wrong thing/i);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8").catch(() => "");
  assert.equal(rgrRecords(log, "CYCLE").length, 0);
});

test("plan case 26: rgr red fails closed when PASS_FORMAT is none", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("unclassified red", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace("PASS_FORMAT=node-tap", "PASS_FORMAT=none");
  await writeFile(envPath, envText);

  const result = runRgr(fixture, "red", "fail closed", "--test-file", "behavior.test.mjs", "--name", "unclassified red");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PASS_FORMAT=none cannot classify RED/);
});

test("plan case 40: rgr refuses to classify tests when dependencies are unprovisioned", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("dependency gate", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace("DEPS_OK=yes", "DEPS_OK=no");
  await writeFile(envPath, envText);

  const result = runRgr(fixture, "red", "require provisioned deps", "--test-file", "behavior.test.mjs", "--name", "dependency gate");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEPS_OK=no.*provision dependencies/);
});

test("plan case 19a: rgr red rejects a name that matches no test", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("present name", () => {});\n',
    { captureBaseline: false },
  );
  const result = runRgr(
    fixture,
    "red",
    "reject unmatched selector",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "absent name",
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /name-ok=no pass=1/);
  assert.equal(git(fixture.worktree, "for-each-ref", "--format=%(refname)", "refs/rgr"), "");
});

test("rgr red rejects a test that is broken during module loading", async () => {
  const fixture = await createRgrFixture(
    'import "./missing-module.mjs";\nimport test from "node:test";\ntest("loads behavior", () => {});\n',
  );

  const result = runRgr(
    fixture,
    "red",
    "load the behavior",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "loads behavior",
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /class=broken/);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8").catch(() => "");
  assert.equal(rgrRecords(log, "CYCLE").length, 0);
});

test("plan case 19b: rgr red classifies a missing test file as broken", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("present file", () => {});\n',
    { captureBaseline: false },
  );
  const result = runRgr(
    fixture,
    "red",
    "reject missing test file",
    "--test-file",
    "missing.test.mjs",
    "--name",
    "missing test",
  );

  assert.equal(result.status, 3);
  assert.match(result.stderr, /class=broken/);
  assert.equal(git(fixture.worktree, "for-each-ref", "--format=%(refname)", "refs/rgr"), "");
});

test("plan case 21: rgr red does not record a cycle for a missing test file", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("control file", () => {});\n',
    { captureBaseline: false },
  );
  const result = runRgr(
    fixture,
    "red",
    "missing RED file",
    "--test-file",
    "absent.test.mjs",
    "--name",
    "absent RED",
  );

  assert.equal(result.status, 3);
  assert.match(result.stderr, /class=broken/);
  assert.equal(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8").catch(() => ""), "");
});

test("rgr red records an explicitly allowed import failure", async () => {
  const fixture = await createRgrFixture(
    'import "./new-module.mjs";\nimport test from "node:test";\ntest("loads new module", () => {});\n',
  );

  const result = runRgr(
    fixture,
    "red",
    "introduce a new module",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "loads new module",
    "--allow-import-red",
    "module does not exist before this cycle",
  );
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const header = findRgrRecord(log, "HEADER");
  const cycle = findRgrRecord(log, "CYCLE", 1);
  const red = findRgrRecord(log, "RED", 1);
  assert.equal(header.version, "v1");
  assert.equal(cycle.repo, "fixture");
  assert.equal(cycle.behavior, "introduce a new module");
  assert.equal(red.class, "broken");
  assert.equal(red["allow-import-red"], "module does not exist before this cycle");
  const tree = red.tree;
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.worktree, "cat-file", "-t", tree), "tree");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red`), tree);
});

test("rgr red records an assertion failure with a valid tree", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("missing behavior", () => assert.equal(1, 2));\n',
  );

  const result = runRgr(
    fixture,
    "red",
    "implement missing behavior",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "missing behavior",
  );
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const red = findRgrRecord(log, "RED", 1);
  assert.equal(red.class, "assertion");
  const tree = red.tree;
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.worktree, "cat-file", "-t", tree), "tree");
});

test("plan case 20: assertion data containing Cannot find module remains an assertion", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("error text is data", () => assert.equal("Cannot find module", "expected value"));\n',
    { captureBaseline: false },
  );
  const result = runRgr(
    fixture,
    "red",
    "classify assertion data structurally",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "error text is data",
  );

  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(findRgrRecord(log, "RED", 1).class, "assertion");
});

test("plan case 43: selectors preserve regex and shell metacharacters as literal names", async () => {
  for (const selectedName of ["suma (a+b) [ok]", 'dice "hola"; rm -rf $HOME']) {
    const source = [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      `test(${JSON.stringify(selectedName)}, () => assert.equal(1, 2));`,
      'test("unselected control", () => assert.fail("selector leaked"));',
      "",
    ].join("\n");
    const fixture = await createRgrFixture(source, { captureBaseline: false });
    const result = runRgr(
      fixture,
      "red",
      "literal metacharacter selector",
      "--test-file",
      "behavior.test.mjs",
      "--name",
      selectedName,
    );
    assert.equal(result.status, 0, `${selectedName}: ${result.stderr}`);
    const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
    const red = findRgrRecord(log, "RED", 1);
    assert.equal(red.name, selectedName);
    assert.equal(red.fail, "1");
  }
});

test("plan case 44: TEST_ONE_CMD and a quoted selector round-trip unchanged", async () => {
  const selectedName = 'round trip "quoted selector"';
  const fixture = await createRgrFixture(
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest(${JSON.stringify(selectedName)}, () => assert.equal(1, 2));\n`,
    { captureBaseline: false },
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const expectedCommand = "node --test --test-reporter=tap --test-concurrency='1'";
  const envText = (await readFile(envPath, "utf8")).replace(
    "TEST_ONE_CMD=node --test --test-reporter=tap",
    `TEST_ONE_CMD=${expectedCommand}`,
  );
  await writeFile(envPath, envText);
  const result = runRgr(fixture, "red", "round trip one command", "--test-file", "behavior.test.mjs", "--name", selectedName);

  assert.equal(result.status, 0, result.stderr);
  const red = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "RED", 1);
  assert.equal(red.cmd, expectedCommand);
  assert.equal(red.name, selectedName);
});

test("rgr red anchors the exact slot environment for its cycle", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("env evidence", () => assert.equal(1, 2));\n',
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const expectedEnv = await readFile(envPath, "utf8");
  const red = runRgr(
    fixture,
    "red",
    "anchor slot environment",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "env evidence",
  );
  assert.equal(red.status, 0, red.stderr);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const envBlob = findRgrRecord(log, "CYCLE", 1).env;
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.match(envBlob, /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/env`), envBlob);
  assert.equal(git(fixture.worktree, "cat-file", "blob", envBlob), expectedEnv.trimEnd());
});

test("rgr rejects slot environment drift after RED", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("stable env", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "stable slot env", "--test-file", "behavior.test.mjs", "--name", "stable env").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const changedEnv = (await readFile(envPath, "utf8"))
    .replace("IGNORE_GLOBS=package-lock.json", "IGNORE_GLOBS=package-lock.json generated.lock");
  await writeFile(envPath, changedEnv);

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 2, green.stderr);
  assert.match(green.stderr, /slot environment changed after RED.*anchored env/i);
});

test("rgr green rejects an open cycle whose selected test is still red", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("still red", () => assert.equal(1, 2));\n',
  );
  const red = runRgr(
    fixture,
    "red",
    "make selected test pass",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "still red",
  );
  assert.equal(red.status, 0, red.stderr);

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 2);
  assert.match(green.stderr, /selected test is still red/i);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(rgrRecords(log, "GREEN").length, 0);
});

test("plan case 35: rgr green rejects a test renamed after RED", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("original selected name", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "bind selected name", "--test-file", "behavior.test.mjs", "--name", "original selected name").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  await writeFile(
    `${fixture.worktree}/behavior.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("renamed selected test", () => assert.equal(value, 1));\n',
  );

  const result = runRgr(fixture, "green");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /selected RED name was not reported ok/);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(rgrRecords(log, "GREEN").length, 0);
});

test("plan case 36: rgr green rejects a test file deleted after RED", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("deleted selected test", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "bind deleted test", "--test-file", "behavior.test.mjs", "--name", "deleted selected test").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  await rm(`${fixture.worktree}/behavior.test.mjs`);

  const result = runRgr(fixture, "green");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /selected test is still red/);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(rgrRecords(log, "GREEN").length, 0);
});

test("plan case 41: rgr green rejects a dynamically skipped selected test", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { skipNow, value } from "./feature.mjs";\ntest("dynamic skip", { skip: skipNow }, () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const skipNow = false;\nexport const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "reject dynamic skip", "--test-file", "behavior.test.mjs", "--name", "dynamic skip").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const skipNow = true;\nexport const value = 1;\n");

  const result = runRgr(fixture, "green");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /marked # SKIP instead of executing/);
});

test("plan case 42: rgr green rejects a dynamically todo selected test", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { todoNow, value } from "./feature.mjs";\ntest("dynamic todo", { todo: todoNow }, () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const todoNow = false;\nexport const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "reject dynamic todo", "--test-file", "behavior.test.mjs", "--name", "dynamic todo").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const todoNow = true;\nexport const value = 0;\n");

  const result = runRgr(fixture, "green");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /marked # TODO instead of executing/);
});

test("plan case 49: an escaped hash in the test name is not a TAP directive", async () => {
  const selectedName = "caso # SKIP raro";
  const fixture = await createRgrFixture(
    `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest(${JSON.stringify(selectedName)}, () => assert.equal(value, 1));\n`,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "escaped hash name", "--test-file", "behavior.test.mjs", "--name", selectedName).status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  const result = runRgr(fixture, "green");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  const green = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "GREEN", 1);
  assert.equal(green.directive, "none");
  assert.equal(green["name-ok"], "yes");
  const catches = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "CATCHES", 1);
  assert.equal(catches.catches, "yes");
});

test("TAP names support realistic escapes and reject control characters", async () => {
  for (const selectedName of ["mutation # SKIP text", "mutation \\ path"]) {
    const fixture = await createRgrFixture(
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest(${JSON.stringify(selectedName)}, () => assert.equal(value, 1));\n`,
      { captureBaseline: false },
    );
    await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
    git(fixture.worktree, "add", "feature.mjs");
    git(fixture.worktree, "commit", "-qm", "escaped catches baseline");
    const baseline = git(fixture.worktree, "rev-parse", "HEAD");
    const envPath = `${fixture.cycleDir}/harness.fixture.env`;
    const envText = (await readFile(envPath, "utf8")).replace(/^BASELINE_REF=.*$/m, `BASELINE_REF=${baseline}`);
    await writeFile(envPath, envText);
    assert.equal(runRgr(fixture, "baseline").status, 0);
    assert.equal(runRgr(fixture, "red", "escaped catches gate", "--test-file", "behavior.test.mjs", "--name", selectedName).status, 0);
    await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
    assert.equal(runRgr(fixture, "green").status, 0);
    assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
    assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture export is cohesive").status, 0);
    const catches = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "CATCHES", 1);
    assert.equal(catches.catches, "yes");
    const result = runVerify(fixture.cycleDir);
    assert.equal(result.status, 0, result.stdout);
  }

  const controls = [
    ["\r", "carriage return (CR, U+000D)"],
    ["\n", "line feed (LF, U+000A)"],
    ["\t", "horizontal tab (TAB, U+0009)"],
    ["\b", "backspace (BS, U+0008)"],
    ["\f", "form feed (FF, U+000C)"],
    ["\v", "vertical tab (VT, U+000B)"],
  ];
  for (const [character, description] of controls) {
    const fixture = await createRgrFixture('import test from "node:test";\ntest("ordinary", () => {});\n');
    const result = runRgr(
      fixture,
      "red",
      "reject control name",
      "--test-file",
      "behavior.test.mjs",
      "--name",
      `name ${character} hidden`,
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      result.stderr.trim(),
      `rgr: test name contains control character ${description} at position 6`,
    );
  }
});

test("plan case 50: quoted and backslash names survive writer and verifier round-trip", async () => {
  for (const selectedName of ['dice "hola"', "ruta \\ literal"]) {
    const fixture = await createRgrFixture(
      `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest(${JSON.stringify(selectedName)}, () => assert.equal(value, 1));\n`,
      { captureBaseline: false },
    );
    await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
    git(fixture.worktree, "add", "feature.mjs");
    git(fixture.worktree, "commit", "-qm", "escaped-name production baseline");
    const baseline = git(fixture.worktree, "rev-parse", "HEAD");
    const envPath = `${fixture.cycleDir}/harness.fixture.env`;
    const envText = (await readFile(envPath, "utf8")).replace(/^BASELINE_REF=.*$/m, `BASELINE_REF=${baseline}`);
    await writeFile(envPath, envText);
    assert.equal(runRgr(fixture, "baseline").status, 0);
    assert.equal(runRgr(fixture, "red", "escaped log name", "--test-file", "behavior.test.mjs", "--name", selectedName).status, 0);
    await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
    assert.equal(runRgr(fixture, "green").status, 0);
    assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
    assert.equal(runRgr(fixture, "refactor", "NONE: direct export is cohesive").status, 0);
    const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
    assert.equal(findRgrRecord(log, "RED", 1).name, selectedName);
    assert.equal(findRgrRecord(log, "CATCHES", 1).catches, "yes");
    assert.equal(runVerify(fixture.cycleDir).status, 0);
  }
});

test("plan case 51: --repo must agree with the cwd slot", async () => {
  const fixture = await createRgrFixture('import test from "node:test";\ntest("repo slot", () => {});\n');
  const otherWorktree = await initGitRepo("rgr-other-worktree");
  const declared = await readFile(`${fixture.cycleDir}/worktrees.env`, "utf8");
  await writeFile(`${fixture.cycleDir}/worktrees.env`, `${declared}other=${await realpath(otherWorktree)}\n`);

  const result = runRgr(fixture, "--repo", "other", "baseline");

  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "rgr: --repo 'other' disagrees with cwd slot 'fixture'");
});

test("plan case 18a: rgr green rejects a replacement name selector", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("bound name", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "bind name", "--test-file", "behavior.test.mjs", "--name", "bound name").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const result = runRgr(fixture, "green", "--name", "different name");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /green --name differs from the open RED/);
});

test("plan case 18b: rgr green rejects a replacement test-file selector", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("bound file", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "bind file", "--test-file", "behavior.test.mjs", "--name", "bound file").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const result = runRgr(fixture, "green", "--test-file", "other.test.mjs");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /green --test-file differs from the open RED/);
});

test("rgr green records a passing selected test and suite totals", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("implemented behavior", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  const red = runRgr(
    fixture,
    "red",
    "implement the feature value",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "implemented behavior",
  );
  assert.equal(red.status, 0, red.stderr);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 0, green.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "GREEN", 1);
  assert.deepEqual(
    Object.fromEntries([
      "target-exit", "target-tests", "target-pass", "target-fail", "skipped", "todo",
      "name-ok", "directive", "tests-diff", "suite-tests", "suite-fail", "new-fails",
    ].map((key) => [key, recorded[key]])),
    {
      "target-exit": "0", "target-tests": "1", "target-pass": "1", "target-fail": "0",
      skipped: "0", todo: "0", "name-ok": "yes", directive: "none", "tests-diff": "EMPTY",
      "suite-tests": "1", "suite-fail": "0", "new-fails": "0",
    },
  );
  const tree = recorded.tree;
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.worktree, "cat-file", "-t", tree), "tree");
});

test("plan case 39: three spaced TEST_CMD values round-trip and execute", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("three command behavior", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/one.test.mjs`, 'import test from "node:test";\ntest("one command", () => {});\n');
  await writeFile(`${fixture.worktree}/two.test.mjs`, 'import test from "node:test";\ntest("two command", () => {});\n');
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  let envText = await readFile(envPath, "utf8");
  envText = envText
    .replace("TEST_CMD_N=1", "TEST_CMD_N=3")
    .replace(
      "TEST_CMD_1=node --test",
      "TEST_CMD_1=node --test behavior.test.mjs\nTEST_CMD_2=node --test one.test.mjs\nTEST_CMD_3=node --test two.test.mjs",
    );
  await writeFile(envPath, envText);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.equal(runRgr(fixture, "red", "execute three commands", "--test-file", "behavior.test.mjs", "--name", "three command behavior").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const green = findRgrRecord(log, "GREEN", 1);
  assert.equal(green["suite-tests"], "3");
  for (const index of [1, 2, 3]) {
    assert.match(green[`run-suite-${index}`], /^[0-9a-f]{40}$/);
    assert.match(green[`status-suite-${index}`], /^[0-9a-f]{40}$/);
  }
});

test("rgr refactor rejects any test-file change after GREEN", async () => {
  const failingTest = 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("stable test", () => assert.equal(value, 1));\n';
  const fixture = await createRgrFixture(failingTest);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "stabilize value", "--test-file", "behavior.test.mjs", "--name", "stable test").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  await writeFile(`${fixture.worktree}/behavior.test.mjs`, `${failingTest}\n`);

  const refactor = runRgr(fixture, "refactor", "NONE: no production structure to improve");
  assert.equal(refactor.status, 2);
  assert.match(refactor.stderr, /test.*changed.*behavior/i);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(rgrRecords(log, "REFACTOR").length, 0);
});

test("rgr refactor rejects a changed test-count tuple", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { extra, value } from "./feature.mjs";\ntest("primary behavior", () => assert.equal(value, 1));\nif (extra) test("extra behavior", () => assert.ok(extra));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0; export const extra = false;\n");
  assert.equal(
    runRgr(fixture, "red", "enable primary", "--test-file", "behavior.test.mjs", "--name", "primary behavior").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1; export const extra = false;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1; export const extra = true;\n");

  const refactor = runRgr(fixture, "refactor", "enable extracted registration branch");
  assert.equal(refactor.status, 2);
  assert.match(refactor.stderr, /test count.*subtests.*behavior/i);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(rgrRecords(log, "REFACTOR").length, 0);
});

test("rgr refactor records a clean behavior-preserving phase", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("stable behavior", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "stabilize feature", "--test-file", "behavior.test.mjs", "--name", "stable behavior").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "const value = 1;\nexport { value };\n");

  const refactor = runRgr(fixture, "refactor", "extracted the exported binding");
  assert.equal(refactor.status, 0, refactor.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "REFACTOR", 1);
  assert.deepEqual(
    Object.fromEntries(
      ["exit", "suite-tests", "pass", "suite-fail", "same", "tests-diff", "note"].map((key) => [key, recorded[key]]),
    ),
    {
      exit: "0",
      "suite-tests": "1",
      pass: "1",
      "suite-fail": "0",
      same: "yes",
      "tests-diff": "EMPTY",
      note: "extracted the exported binding",
    },
  );
  const tree = recorded.tree;
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.worktree, "cat-file", "-t", tree), "tree");
});

test("rgr refactor records normative summed suite totals", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("normative totals", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "record normative totals", "--test-file", "behavior.test.mjs", "--name", "normative totals").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture export is already cohesive").status, 0);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "REFACTOR", 1);
  assert.equal(recorded["suite-tests"], "1");
  assert.equal(recorded["suite-fail"], "0");
  assert.equal(recorded.tests, undefined);
  assert.equal(recorded.fail, undefined);
});

test("rgr baseline captures and records the current Node failure set", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("existing failure", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );

  const result = runRgr(fixture, "baseline");
  assert.equal(result.status, 0, result.stderr);
  const envText = await readFile(`${fixture.cycleDir}/harness.fixture.env`, "utf8");
  const envFailset = envText.match(/^BASELINE_FAILSET=([0-9a-f]{40})$/m)?.[1];
  assert.ok(envFailset, "baseline must update the env with its anchored blob");
  assert.equal(git(fixture.worktree, "cat-file", "blob", envFailset), "behavior.test.mjs::existing failure");
  assert.match(envText, /^BASELINE_FAILURES_N=1$/m);
  assert.match(envText, /^BASELINE_AT=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const header = findRgrRecord(log, "HEADER");
  const baseline = findRgrRecord(log, "BASELINE");
  assert.equal(header.version, "v1");
  assert.match(baseline.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(baseline.slot, "fixture");
  assert.equal(baseline.seq, "001");
  assert.match(baseline.failset, /^[0-9a-f]{40}$/);
  assert.equal(baseline.failset, envFailset);
  assert.equal(baseline.fails, "1");
  assert.equal(baseline.by, "impl");
});

test("plan case 58: failsets distinguish identical test names by file", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("duplicate name", () => assert.fail("only this file fails"));\n',
    { captureBaseline: false },
  );
  await writeFile(
    `${fixture.worktree}/passing.test.mjs`,
    'import test from "node:test";\ntest("duplicate name", () => {});\n',
  );

  assert.equal(runRgr(fixture, "baseline").status, 0);
  const baseline = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "BASELINE");
  assert.equal(git(fixture.worktree, "cat-file", "blob", baseline.failset), "behavior.test.mjs::duplicate name");
});

test("plan case 19c: rgr rejects a suite glob that matches zero tests", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("present glob control", () => {});\n',
    { captureBaseline: false },
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace(
    "TEST_CMD_1=node --test",
    "TEST_CMD_1=node --test 'missing-*.test.mjs'",
  );
  await writeFile(envPath, envText);

  const result = runRgr(fixture, "baseline");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suite 1 reported tests=0/);
});

test("rgr baseline anchors its first failure set at immutable 001 and current refs", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("anchored baseline", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );

  assert.equal(runRgr(fixture, "baseline").status, 0);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const baseline = findRgrRecord(log, "BASELINE");
  assert.equal(baseline.slot, "fixture");
  assert.equal(baseline.seq, "001");
  const blob = baseline.failset;
  assert.match(blob, /^[0-9a-f]{40}$/, "BASELINE must record its anchored blob and numbered ref");
  assert.equal(git(fixture.worktree, "cat-file", "-t", blob), "blob");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/001`), blob);
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/current`), blob);
});

test("rgr baseline recapture preserves numbered refs and advances current", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("first baseline", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  assert.equal(runRgr(fixture, "baseline").status, 0);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const first = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/001`);
  await writeFile(
    `${fixture.worktree}/behavior.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("second baseline", () => assert.equal(2, 3));\n',
  );

  assert.equal(runRgr(fixture, "baseline").status, 0);
  const second = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/002`);
  assert.notEqual(second, first);
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/001`), first);
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/current`), second);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const baselines = rgrRecords(log, "BASELINE");
  assert.equal(baselines.length, 2);
  assert.deepEqual(baselines.map((record) => record.seq), ["001", "002"]);
});

test("plan case 68: numbered baseline refs cannot be overwritten", async () => {
  const fixture = await createRgrFixture('import test from "node:test";\ntest("baseline immutability", () => {});\n', { captureBaseline: false });
  assert.equal(runRgr(fixture, "baseline").status, 0);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const ref = `refs/rgr/${cycleId}/baseline/001`;
  const original = git(fixture.worktree, "rev-parse", ref);
  const replacement = writeGitBlob(fixture.worktree, "forged baseline\n");
  const overwrite = spawnSync("git", ["update-ref", ref, replacement, ""], { cwd: fixture.worktree, encoding: "utf8" });

  assert.notEqual(overwrite.status, 0);
  assert.match(overwrite.stderr, /reference already exists/);
  assert.equal(git(fixture.worktree, "rev-parse", ref), original);
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.deepEqual(rgrRecords(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "BASELINE").map((entry) => entry.seq), ["001", "002"]);
});

test("plan case 57: baseline recapture reports its diff without rewriting a closed cycle", async () => {
  const fixture = await createClosedRgrFixture("baseline recapture cycle");
  await writeFile(
    `${fixture.worktree}/ambient.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("recaptured environment", () => assert.fail("ambient"));\n',
  );
  assert.equal(runRgr(fixture, "baseline").status, 0);

  const result = runVerify(fixture.cycleDir);
  const report = await readFile(`${fixture.cycleDir}/verify-rgr.md`, "utf8");
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");

  assert.equal(result.status, 0, report);
  assert.equal(rgrRecords(log, "BASELINE").length, 2);
  assert.match(report, /warning baseline-recaptured from=001 to=002 added=1 removed=1/);
  assert.match(report, /baseline-added seq=002 value="ambient\.test\.mjs::recaptured environment"/);
  assert.match(report, /baseline-removed seq=002 value="behavior\.test\.mjs::baseline recapture cycle"/);
});

test("plan case 70: a closed cycle remains bound to its immutable baseline after recapture", async () => {
  const fixture = await createClosedRgrFixture("immutable cycle baseline");
  const before = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const cycleBaseline = findRgrRecord(before, "GREEN", 1).baseline;
  await writeFile(`${fixture.worktree}/later-environment.test.mjs`, 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("later environment", () => assert.fail("later"));\n');
  assert.equal(runRgr(fixture, "baseline").status, 0);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const current = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/current`);

  const result = runVerify(fixture.cycleDir);

  assert.notEqual(current, cycleBaseline);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "GREEN", 1).baseline, cycleBaseline);
});

test("rgr green accepts suite failures already present in the baseline", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("environmental failure", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  assert.equal(runRgr(fixture, "baseline").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  await writeFile(
    `${fixture.worktree}/selected.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("new behavior", () => assert.equal(value, 1));\n',
  );
  assert.equal(
    runRgr(fixture, "red", "implement new behavior", "--test-file", "selected.test.mjs", "--name", "new behavior").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 0, green.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "GREEN", 1);
  assert.equal(recorded["suite-tests"], "2");
  assert.equal(recorded["suite-fail"], "1");
  assert.equal(recorded["new-fails"], "0");
  assert.match(recorded.tree, /^[0-9a-f]{40}$/);
});

test("rgr green rejects and names a suite failure absent from the baseline", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("environmental failure", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  assert.equal(runRgr(fixture, "baseline").status, 0);
  await writeFile(
    `${fixture.worktree}/unrelated.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("new regression", () => assert.equal(2, 3));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  await writeFile(
    `${fixture.worktree}/selected.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("selected fix", () => assert.equal(value, 1));\n',
  );
  assert.equal(
    runRgr(fixture, "red", "implement selected fix", "--test-file", "selected.test.mjs", "--name", "selected fix").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 2);
  assert.match(green.stderr, /unrelated\.test\.mjs::new regression/);
  assert.doesNotMatch(green.stderr, /behavior\.test\.mjs::environmental failure/);
  assert.match(green.stderr, /re-capture from this pane with rgr baseline/);
});

test("plan case 55: a baseline from another environment reports every new failure", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("selected environment change", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/ambient.mjs`, "export const ambient = true;\n");
  await writeFile(`${fixture.worktree}/ambient-one.test.mjs`, 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ambient } from "./ambient.mjs";\ntest("ambient one", () => assert.equal(ambient, true));\n');
  await writeFile(`${fixture.worktree}/ambient-two.test.mjs`, 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { ambient } from "./ambient.mjs";\ntest("ambient two", () => assert.equal(ambient, true));\n');
  assert.equal(runRgr(fixture, "baseline").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  await writeFile(`${fixture.worktree}/ambient.mjs`, "export const ambient = false;\n");
  assert.equal(runRgr(fixture, "red", "environment changed", "--test-file", "behavior.test.mjs", "--name", "selected environment change").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const green = runRgr(fixture, "green");

  assert.equal(green.status, 2);
  assert.match(green.stderr, /ambient-one\.test\.mjs::ambient one/);
  assert.match(green.stderr, /ambient-two\.test\.mjs::ambient two/);
  assert.match(green.stderr, /re-capture from this pane with rgr baseline/);
});

test("rgr green refuses to run without a captured failure baseline", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("requires baseline", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "require baseline", "--test-file", "behavior.test.mjs", "--name", "requires baseline").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 1);
  assert.match(green.stderr, /run rgr baseline from this pane/i);
});

test("rgr green anchors its normalized failure set as a Git blob", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("blob evidence", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "record failure set", "--test-file", "behavior.test.mjs", "--name", "blob evidence").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const blob = findRgrRecord(log, "GREEN", 1).failset;
  assert.match(blob, /^[0-9a-f]{40}$/, "GREEN must record its failure-set blob");
  assert.equal(git(fixture.worktree, "cat-file", "-t", blob), "blob");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/green-failset`), blob);
});

test("rgr green records the exact anchored baseline blob it compared", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("baseline binding", () => assert.equal(value, 1));\n',
  );
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const baseline = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/baseline/current`);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "bind baseline", "--test-file", "behavior.test.mjs", "--name", "baseline binding").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(findRgrRecord(log, "GREEN", 1).baseline, baseline);
});

test("rgr refactor rejects a failure that disappears from the GREEN set", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { environment } from "./environment.mjs";\ntest("environmental failure", () => assert.equal(environment, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/environment.mjs`, "export const environment = 0;\n");
  assert.equal(runRgr(fixture, "baseline").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  await writeFile(
    `${fixture.worktree}/selected.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("selected behavior", () => assert.equal(value, 1));\n',
  );
  assert.equal(
    runRgr(fixture, "red", "selected behavior", "--test-file", "selected.test.mjs", "--name", "selected behavior").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  await writeFile(`${fixture.worktree}/environment.mjs`, "export const environment = 1;\n");

  const refactor = runRgr(fixture, "refactor", "changed environment behavior");
  assert.equal(refactor.status, 2);
  assert.match(refactor.stderr, /failure set changed/i);
  assert.match(refactor.stderr, /removed.*behavior\.test\.mjs::environmental failure/is);
});

test("rgr refactor anchors the unchanged failure set as a Git blob", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("stable blob", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "stable blob", "--test-file", "behavior.test.mjs", "--name", "stable blob").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct export is already clear").status, 0);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const blob = findRgrRecord(log, "REFACTOR", 1).failset;
  assert.match(blob, /^[0-9a-f]{40}$/, "REFACTOR must record its failure-set blob");
  assert.equal(git(fixture.worktree, "cat-file", "-t", blob), "blob");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/refactor-failset`), blob);
});

test("rgr refactor keeps the GREEN baseline binding after a recapture", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("stable baseline", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "stable baseline", "--test-file", "behavior.test.mjs", "--name", "stable baseline").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  const beforeRecapture = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const greenBaseline = findRgrRecord(beforeRecapture, "GREEN", 1).baseline;
  assert.match(greenBaseline, /^[0-9a-f]{40}$/);
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: no structural change").status, 0);

  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  assert.equal(findRgrRecord(log, "REFACTOR", 1).baseline, greenBaseline);
});

test("rgr verify-catches reverts an existing fix blob and records catches yes", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("mutation check", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "mutation check", "--test-file", "behavior.test.mjs", "--name", "mutation check").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const catches = runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs");
  assert.equal(catches.status, 0, catches.stderr);
  assert.equal(await readFile(`${fixture.worktree}/feature.mjs`, "utf8"), "export const value = 1;\n");
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "CATCHES", 1);
  assert.equal(recorded.catches, "yes");
  assert.equal(recorded.files, "feature.mjs");
  const failset = recorded["catches-failset"];
  assert.match(failset, /^[0-9a-f]{40}$/, "CATCHES must record its anchored reverted-run failure set");
  assert.equal(git(fixture.worktree, "cat-file", "blob", failset), "behavior.test.mjs::mutation check");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/catches-failset`), failset);
});

test("rgr verify-catches does not call an unrelated load failure a caught assertion", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("unrelated catches failure", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/helper.mjs`, "export const oldValue = 0;\n");
  await writeFile(
    `${fixture.worktree}/feature.mjs`,
    'import { oldValue } from "./helper.mjs";\nexport const value = oldValue;\n',
  );
  git(fixture.worktree, "add", "helper.mjs", "feature.mjs");
  git(fixture.worktree, "commit", "-qm", "unrelated catches baseline");
  const baseline = git(fixture.worktree, "rev-parse", "HEAD");
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace(/^BASELINE_REF=.*$/m, `BASELINE_REF=${baseline}`);
  await writeFile(envPath, envText);
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.equal(
    runRgr(
      fixture,
      "red",
      "reject unrelated catches failure",
      "--test-file",
      "behavior.test.mjs",
      "--name",
      "unrelated catches failure",
    ).status,
    0,
  );
  await writeFile(`${fixture.worktree}/helper.mjs`, "export const newValue = 1;\n");
  await writeFile(
    `${fixture.worktree}/feature.mjs`,
    'import { newValue } from "./helper.mjs";\nexport const value = newValue;\n',
  );
  assert.equal(runRgr(fixture, "green").status, 0);

  const catches = runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs");
  assert.equal(catches.status, 0, catches.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "CATCHES", 1);
  assert.equal(recorded.catches, "no");
  assert.match(recorded["run-targeted"], /^[0-9a-f]{40}$/);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(
    git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/catches-run/targeted`),
    recorded["run-targeted"],
  );
  const rawRun = git(fixture.worktree, "cat-file", "blob", recorded["run-targeted"]);
  assert.doesNotMatch(rawRun, /^not ok \d+ - unrelated catches failure$/m);
  assert.equal(git(fixture.worktree, "cat-file", "blob", recorded["catches-failset"]), "");
  assert.equal(runRgr(fixture, "refactor", "NONE: direct imports expose the load failure").status, 0);
  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^warning cycle=1 catches=no\b/m);
});

test("plan case 65: verify-rgr rejects catches yes without a catches failset", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("required catches evidence", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "require catches evidence", "--test-file", "behavior.test.mjs", "--name", "required catches evidence").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture export is already cohesive").status, 0);
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  const catches = findRgrRecord(log, "CATCHES", 1);
  delete catches["catches-failset"];
  await writeFile(logPath, log.replace(catches.line, buildRgrLogLine(catches)));

  const result = runVerify(fixture.cycleDir);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b cycle=1\/catches-failset error=missing-object-id/);
});

test("verify-rgr reports pre-anchor catches as an evidence frontier", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("legacy catches evidence", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  git(fixture.worktree, "add", "feature.mjs");
  git(fixture.worktree, "commit", "-qm", "legacy catches baseline");
  const baseline = git(fixture.worktree, "rev-parse", "HEAD");
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace(/^BASELINE_REF=.*$/m, `BASELINE_REF=${baseline}`);
  await writeFile(envPath, envText);
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.equal(runRgr(fixture, "red", "legacy catches frontier", "--test-file", "behavior.test.mjs", "--name", "legacy catches evidence").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture export is already cohesive").status, 0);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  const catches = findRgrRecord(log, "CATCHES", 1);
  delete catches["run-targeted"];
  await writeFile(logPath, log.replace(catches.line, buildRgrLogLine(catches)));
  git(fixture.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/1/catches-run/targeted`);

  const result = runVerify(
    fixture.cycleDir,
    "--frontier", "catches", "--scope", "until-cycle=1", "--reason", "legacy catches fixture",
  );

  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^unverified dimension=catches cycles=1 count=1$/m);
  assert.match(result.stdout, /^exception type=frontier subject=catches scope=until-cycle=1 reason="legacy catches fixture"$/m);
  assert.match(result.stdout, /^warning cycle=1 catches=unverifiable reason=legacy-no-targeted-run not-mutation-verified=yes$/m);
});

test("rgr rejects a nonzero suite process even when its JUnit is parseable", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("parseable nonzero suite", () => assert.equal(1, 1));\n',
    { captureBaseline: false },
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace(
    "TEST_CMD_1=node --test",
    "TEST_CMD_1=node --test; exit 64",
  );
  await writeFile(envPath, envText);

  const result = runRgr(fixture, "baseline");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /suite 1 exited 64/);
});

test("plan case 27: rgr preserves infrastructure exit 3 and 64 in its rejection", async () => {
  for (const childExit of [3, 64]) {
    const fixture = await createRgrFixture(
      'import test from "node:test";\ntest("parseable exit control", () => {});\n',
      { captureBaseline: false },
    );
    const envPath = `${fixture.cycleDir}/harness.fixture.env`;
    const envText = (await readFile(envPath, "utf8")).replace(
      "TEST_CMD_1=node --test",
      `TEST_CMD_1=node --test; exit ${childExit}`,
    );
    await writeFile(envPath, envText);
    const result = runRgr(fixture, "baseline");

    assert.equal(result.status, 2, `child exit ${childExit}`);
    assert.match(result.stderr, new RegExp(`suite 1 exited ${childExit}\\b`));
    assert.notEqual(result.status, childExit);
  }
});

test("rgr verify-catches records n-a when reverting a newly added file breaks loading", async () => {
  const fixture = await createRgrFixture(
    'import { value } from "./new-feature.mjs";\nimport assert from "node:assert/strict";\nimport test from "node:test";\ntest("new file behavior", () => assert.equal(value, 1));\n',
  );
  assert.equal(
    runRgr(
      fixture,
      "red",
      "add new module",
      "--test-file",
      "behavior.test.mjs",
      "--name",
      "new file behavior",
      "--allow-import-red",
      "module is new",
    ).status,
    0,
  );
  await writeFile(`${fixture.worktree}/new-feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const catches = runRgr(fixture, "verify-catches", "--fix-file", "new-feature.mjs");
  assert.equal(catches.status, 0, catches.stderr);
  assert.equal(await readFile(`${fixture.worktree}/new-feature.mjs`, "utf8"), "export const value = 1;\n");
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "CATCHES", 1);
  assert.equal(recorded.catches, "n/a");
  assert.equal(recorded.files, "new-feature.mjs");
  assert.match(recorded["catches-failset"], /^[0-9a-f]{40}$/);
  assert.equal(recorded.reason, "new-file");
});

test("plan case 46: verify-rgr reports catches n-a as not mutation-verified", async () => {
  const fixture = await createRgrFixture(
    'import { value } from "./new-feature.mjs";\nimport assert from "node:assert/strict";\nimport test from "node:test";\ntest("new file warning", () => assert.equal(value, 1));\n',
  );
  assert.equal(runRgr(fixture, "red", "new file warning", "--test-file", "behavior.test.mjs", "--name", "new file warning", "--allow-import-red", "new module").status, 0);
  await writeFile(`${fixture.worktree}/new-feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "new-feature.mjs").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct export is cohesive").status, 0);

  const result = runVerify(
    fixture.cycleDir,
    "--frontier", "catches", "--scope", "until-cycle=1", "--reason", "new-file mutation cannot be replayed",
  );
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /warning cycle=1 catches=n\/a not-mutation-verified=yes reason=new-file/);
});

test("rgr verify-catches reverts and restores every repeated fix-file", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { left } from "./left.mjs";\nimport { right } from "./right.mjs";\ntest("combined fix", () => assert.equal(left + right, 2));\n',
  );
  await writeFile(`${fixture.worktree}/left.mjs`, "export const left = 0;\n");
  await writeFile(`${fixture.worktree}/right.mjs`, "export const right = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "combined fix", "--test-file", "behavior.test.mjs", "--name", "combined fix").status,
    0,
  );
  await writeFile(`${fixture.worktree}/left.mjs`, "export const left = 1;\n");
  await writeFile(`${fixture.worktree}/right.mjs`, "export const right = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const catches = runRgr(
    fixture,
    "verify-catches",
    "--fix-file",
    "left.mjs",
    "--fix-file",
    "right.mjs",
  );
  assert.equal(catches.status, 0, catches.stderr);
  assert.equal(await readFile(`${fixture.worktree}/left.mjs`, "utf8"), "export const left = 1;\n");
  assert.equal(await readFile(`${fixture.worktree}/right.mjs`, "utf8"), "export const right = 1;\n");
});

test("rgr blocks on an interrupted catches crumb and repair restores GREEN", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("repair mutation", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "repair mutation", "--test-file", "behavior.test.mjs", "--name", "repair mutation").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const green = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/green`);
  const red = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red`);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  await writeFile(
    `${fixture.cycleDir}/.rgr-catches-inflight`,
    `repo=fixture green=${green} red=${red} files=feature.mjs\n`,
  );

  const blocked = runRgr(fixture, "refactor", "NONE: blocked");
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /rgr repair/);
  const repaired = runRgr(fixture, "repair");
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(await readFile(`${fixture.worktree}/feature.mjs`, "utf8"), "export const value = 1;\n");
  assert.equal(await stat(`${fixture.cycleDir}/.rgr-catches-inflight`).catch(() => null), null);
});

test("rgr snapshots exclude protected dependency trees without any gitignore", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("protected snapshot", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  await rm(`${fixture.worktree}/.gitignore`);
  await mkdir(`${fixture.worktree}/node_modules/package`, { recursive: true });
  await writeFile(`${fixture.worktree}/node_modules/package/index.js`, "large dependency tree\n");

  const red = runRgr(
    fixture,
    "red",
    "protected snapshot",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "protected snapshot",
  );
  assert.equal(red.status, 0, red.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const tree = findRgrRecord(log, "RED", 1).tree;
  assert.match(tree, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(git(fixture.worktree, "ls-tree", "-r", "--name-only", tree), /^node_modules\//m);
});

test("plan case 17: a tracked but ignored file remains in the RED tree", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("tracked ignored tree", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/tracked.cache`, "tracked evidence\n");
  await writeFile(`${fixture.worktree}/.gitignore`, "node_modules/\ndist/\ntracked.cache\n");
  git(fixture.worktree, "add", "-f", "tracked.cache", ".gitignore");
  git(fixture.worktree, "commit", "-qm", "track ignored evidence");
  assert.equal(
    runRgr(
      fixture,
      "red",
      "capture tracked ignored file",
      "--test-file",
      "behavior.test.mjs",
      "--name",
      "tracked ignored tree",
    ).status,
    0,
  );
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const redTree = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red`);
  assert.equal(git(fixture.worktree, "cat-file", "blob", `${redTree}:tracked.cache`), "tracked evidence");
});

test("plan case 23: an anchored phase tree survives immediate fixture pruning", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("pruned tree", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  assert.equal(
    runRgr(fixture, "red", "anchor tree for pruning", "--test-file", "behavior.test.mjs", "--name", "pruned tree").status,
    0,
  );
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const tree = git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red`);
  git(fixture.worktree, "gc", "--prune=now");

  assert.equal(git(fixture.worktree, "cat-file", "-t", tree), "tree");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red`), tree);
});

test("probe-repo emits stack-specific snapshot exclusions under the normative field name", async () => {
  const nodeCycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-snapshot-node-`);
  const physicalRoot = await realpath(repoRoot);
  await writeFile(`${nodeCycleDir}/worktrees.env`, `rgr=${physicalRoot}\n`);

  const nodeResult = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["rgr"],
    { cwd: repoRoot, env: { ...process.env, CYCLE_DIR: nodeCycleDir }, encoding: "utf8" },
  );
  assert.equal(nodeResult.status, 0, nodeResult.stderr);
  const nodeEnv = await readFile(`${nodeCycleDir}/harness.rgr.env`, "utf8");
  assert.match(nodeEnv, /^SNAPSHOT_EXCLUDE=node_modules dist build \.next coverage$/m);
  assert.doesNotMatch(nodeEnv, /^PROTECTED_PATHS=/m);

  const pythonCycleDir = await mkdtemp(`${tmpdir()}/rgr-probe-snapshot-python-`);
  const pythonWorktree = await initGitRepo("rgr-probe-snapshot-python-worktree");
  await writeFile(`${pythonWorktree}/pyproject.toml`, "[tool.pytest.ini_options]\n");
  git(pythonWorktree, "add", "-A");
  git(pythonWorktree, "commit", "-qm", "fixture");
  await writeFile(`${pythonCycleDir}/worktrees.env`, `api=${await realpath(pythonWorktree)}\n`);

  const pythonResult = spawnSync(
    fileURLToPath(new URL("harness/probe-repo.sh", skillRoot)),
    ["api"],
    { env: { ...process.env, CYCLE_DIR: pythonCycleDir }, encoding: "utf8" },
  );
  assert.equal(pythonResult.status, 0, pythonResult.stderr);
  const pythonEnv = await readFile(`${pythonCycleDir}/harness.api.env`, "utf8");
  assert.match(pythonEnv, /^SNAPSHOT_EXCLUDE=\.venv venv __pycache__ \.pytest_cache \*\.egg-info$/m);
  assert.doesNotMatch(pythonEnv, /^PROTECTED_PATHS=/m);
});

test("rgr red records its only invocation as the targeted run blob", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("raw red evidence", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );

  const red = runRgr(
    fixture,
    "red",
    "raw red evidence",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "raw red evidence",
  );
  assert.equal(red.status, 0, red.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const run = findRgrRecord(log, "RED", 1)["run-targeted"];
  assert.match(run, /^[0-9a-f]{40}$/, "RED must record its raw run blob");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red-run/targeted`), run);
  assert.match(git(fixture.worktree, "cat-file", "blob", run), /not ok 1 - raw red evidence/);
});

test("rgr green anchors one raw blob for the targeted run and each indexed suite", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("raw green evidence", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "raw green evidence", "--test-file", "behavior.test.mjs", "--name", "raw green evidence").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");

  const green = runRgr(fixture, "green");
  assert.equal(green.status, 0, green.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const recorded = findRgrRecord(log, "GREEN", 1);
  const targeted = recorded["run-targeted"];
  const suite = recorded["run-suite-1"];
  assert.match(targeted, /^[0-9a-f]{40}$/, "GREEN must record the targeted run blob");
  assert.match(suite, /^[0-9a-f]{40}$/, "GREEN must record every indexed suite run blob");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/green-run/targeted`), targeted);
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/green-run/suite-1`), suite);
  assert.match(git(fixture.worktree, "cat-file", "blob", targeted), /ok 1 - raw green evidence/);
  assert.match(git(fixture.worktree, "cat-file", "blob", suite), /<testcase /);
});

test("rgr refactor anchors one raw blob for each indexed suite invocation", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("raw refactor evidence", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "raw refactor evidence", "--test-file", "behavior.test.mjs", "--name", "raw refactor evidence").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  const refactor = runRgr(fixture, "refactor", "NONE: direct implementation is already cohesive");
  assert.equal(refactor.status, 0, refactor.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const suite = findRgrRecord(log, "REFACTOR", 1)["run-suite-1"];
  assert.match(suite, /^[0-9a-f]{40}$/, "REFACTOR must record every indexed suite run blob");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(git(fixture.worktree, "rev-parse", `refs/rgr/${cycleId}/1/refactor-run/suite-1`), suite);
  assert.match(git(fixture.worktree, "cat-file", "blob", suite), /<testcase /);
});

test("rgr refactor rejects a changed indexed-suite count even when totals are equal", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("suite universe", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/companion.test.mjs`, 'import test from "node:test";\ntest("companion", () => {});\n');
  let envText = await readFile(`${fixture.cycleDir}/harness.fixture.env`, "utf8");
  envText = envText.replace("TEST_CMD_1=node --test", "TEST_CMD_1=node --test behavior.test.mjs companion.test.mjs");
  await writeFile(`${fixture.cycleDir}/harness.fixture.env`, envText);
  assert.equal(runRgr(fixture, "baseline").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(fixture, "red", "suite universe", "--test-file", "behavior.test.mjs", "--name", "suite universe").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);

  envText = (await readFile(`${fixture.cycleDir}/harness.fixture.env`, "utf8"))
    .replace("TEST_CMD_N=1", "TEST_CMD_N=2")
    .replace(
      "TEST_CMD_1=node --test behavior.test.mjs companion.test.mjs",
      "TEST_CMD_1=node --test behavior.test.mjs\nTEST_CMD_2=node --test companion.test.mjs",
    );
  await writeFile(`${fixture.cycleDir}/harness.fixture.env`, envText);
  const refactor = runRgr(fixture, "refactor", "NONE: same tests under a changed suite partition");

  assert.equal(refactor.status, 2);
  assert.match(refactor.stderr, /suite count changed from 1 to 2/i);
});

test("verify-rgr is executable and documents its gate contract", async () => {
  const scriptUrl = new URL("harness/verify-rgr.sh", skillRoot);
  const metadata = await stat(scriptUrl).catch(() => null);

  assert.ok(metadata, "verify-rgr.sh must exist");
  assert.notEqual(metadata.mode & 0o111, 0, "verify-rgr.sh must be executable");
  const source = await readFile(scriptUrl, "utf8");
  assert.match(source, /^#!\/usr\/bin\/env bash/);
  assert.match(source, /WHY THIS EXISTS/);
  assert.match(source, /Usage: verify-rgr\.sh/);
  assert.match(source, /Env: CYCLE_DIR/);
  assert.match(source, /^set -u$/m);
  assert.doesNotMatch(source, /^set -e|pipefail/m);
});

test("rgr excludes a dependency symlink without traversing through it", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("symlink snapshot", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  await rm(`${fixture.worktree}/.gitignore`);
  const dependencies = await mkdtemp(`${tmpdir()}/rgr-external-node-modules-`);
  await writeFile(`${dependencies}/package.js`, "dependency payload\n");
  await symlink(dependencies, `${fixture.worktree}/node_modules`, "dir");
  await writeFile(`${fixture.worktree}/dist_x.js`, "must remain in the snapshot\n");

  const red = runRgr(
    fixture,
    "red",
    "symlink snapshot",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "symlink snapshot",
  );
  assert.equal(red.status, 0, red.stderr);
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8");
  const tree = findRgrRecord(log, "RED", 1).tree;
  assert.match(tree, /^[0-9a-f]{40}$/, "RED must retain a valid tree when node_modules is a symlink");
  const names = git(fixture.worktree, "ls-tree", "-r", "--name-only", tree);
  assert.doesNotMatch(names, /^node_modules(?:\/|$)/m);
  assert.match(names, /^dist_x\.js$/m);
});

test("plan case 72: git check-ignore cannot inspect beneath a dependency symlink", async () => {
  const fixture = await createRgrFixture('import test from "node:test";\ntest("symlink ignore", () => {});\n', { captureBaseline: false });
  const dependencies = await mkdtemp(`${tmpdir()}/rgr-check-ignore-target-`);
  await writeFile(`${dependencies}/package.js`, "dependency payload\n");
  await symlink(dependencies, `${fixture.worktree}/node_modules`, "dir");

  const result = spawnSync("git", ["check-ignore", "node_modules/package.js"], { cwd: fixture.worktree, encoding: "utf8" });

  assert.equal(result.status, 128);
  assert.match(result.stderr, /beyond a symbolic link/);
});

test("plan case 73: repository-only ignore rules do not hide a dependency symlink", async () => {
  const fixture = await createRgrFixture('import test from "node:test";\ntest("isolated ignore", () => {});\n', { captureBaseline: false });
  await rm(`${fixture.worktree}/.gitignore`);
  git(fixture.worktree, "config", "core.excludesFile", "/dev/null");
  const dependencies = await mkdtemp(`${tmpdir()}/rgr-isolated-ignore-target-`);
  await writeFile(`${dependencies}/package.js`, "dependency payload\n");
  await symlink(dependencies, `${fixture.worktree}/node_modules`, "dir");

  const result = spawnSync("git", ["status", "--short", "--ignored", "--", "node_modules"], { cwd: fixture.worktree, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "?? node_modules\n");
});

test("plan case 74: snapshot pathspec excludes real and symlink dependency trees without gitignore", async () => {
  for (const dependencyKind of ["directory", "symlink"]) {
    const fixture = await createRgrFixture(
      'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("pathspec exclusion", () => assert.equal(1, 2));\n',
      { captureBaseline: false },
    );
    await rm(`${fixture.worktree}/.gitignore`);
    git(fixture.worktree, "config", "core.excludesFile", "/dev/null");
    if (dependencyKind === "directory") {
      await mkdir(`${fixture.worktree}/node_modules/package`, { recursive: true });
      await writeFile(`${fixture.worktree}/node_modules/package/index.js`, "dependency payload\n");
    } else {
      const dependencies = await mkdtemp(`${tmpdir()}/rgr-pathspec-target-`);
      await writeFile(`${dependencies}/index.js`, "dependency payload\n");
      await symlink(dependencies, `${fixture.worktree}/node_modules`, "dir");
    }
    await writeFile(`${fixture.worktree}/dist_x.js`, "application payload\n");
    const controlIndex = `${fixture.cycleDir}/control.index`;
    const controlEnv = { ...process.env, GIT_INDEX_FILE: controlIndex };
    for (const args of [["read-tree", "HEAD"], ["add", "-A"]]) {
      const command = spawnSync("git", args, { cwd: fixture.worktree, env: controlEnv, encoding: "utf8" });
      assert.equal(command.status, 0, command.stderr);
    }
    const controlTree = spawnSync("git", ["write-tree"], { cwd: fixture.worktree, env: controlEnv, encoding: "utf8" });
    assert.equal(controlTree.status, 0, controlTree.stderr);
    assert.match(git(fixture.worktree, "ls-tree", "-r", "--name-only", controlTree.stdout.trim()), /^node_modules(?:\/|$)/m);

    assert.equal(runRgr(fixture, "red", `${dependencyKind} pathspec exclusion`, "--test-file", "behavior.test.mjs", "--name", "pathspec exclusion").status, 0);
    const red = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "RED", 1);
    const names = git(fixture.worktree, "ls-tree", "-r", "--name-only", red.tree);
    assert.doesNotMatch(names, /^node_modules(?:\/|$)/m);
    assert.match(names, /^dist_x\.js$/m);
  }
});

test("rgr never serializes a phase when required evidence creation fails", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("evidence guard", () => assert.equal(1, 2));\n',
    { captureBaseline: false },
  );
  const dependencies = await mkdtemp(`${tmpdir()}/rgr-guard-node-modules-`);
  await writeFile(`${dependencies}/package.js`, "dependency payload\n");
  await symlink(dependencies, `${fixture.worktree}/node_modules`, "dir");
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8")).replace(
    /^SNAPSHOT_EXCLUDE=.*$/m,
    "SNAPSHOT_EXCLUDE=node_modules/**",
  );
  await writeFile(envPath, envText);

  const red = runRgr(
    fixture,
    "red",
    "evidence guard",
    "--test-file",
    "behavior.test.mjs",
    "--name",
    "evidence guard",
  );
  assert.notEqual(red.status, 0, "an evidence failure must propagate out of rgr.sh");
  const log = await readFile(`${fixture.cycleDir}/rgr.log`, "utf8").catch(() => "");
  assert.equal(rgrRecords(log, "CYCLE").length, 0);
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  assert.equal(
    git(fixture.worktree, "for-each-ref", "--format=%(refname)", `refs/rgr/${cycleId}/1`),
    "",
  );
});

test("verify-rgr rejects a pre-harness log without the RGRLOG v1 header", async () => {
  const cycleDir = await mkdtemp(`${tmpdir()}/rgr-verify-old-log-`);
  await writeFile(`${cycleDir}/rgr.log`, "CYCLE 1 :: repo=fixture :: behavior=old\n");

  const result = runVerify(cycleDir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RGRLOG v1.*pre-harness|pre-harness.*RGRLOG v1/i);
});

test("verify-rgr accepts a complete cycle whose anchored evidence is internally consistent", async () => {
  const expectedBaselineFailures = 1;
  const fixture = await createClosedRgrFixture("verified cycle");

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stderr);
  const report = await readFile(`${fixture.cycleDir}/verify-rgr.md`, "utf8");
  assert.match(report, /^## GATE$/m);
  assert.match(report, /^RESULT: PASS$/m);
  assert.match(report, /^exit=0$/m);
  assert.match(
    report,
    new RegExp(`^baseline slot=fixture fails=${expectedBaselineFailures} at=`, "m"),
  );
});

test("plan case 9: verify-rgr rejects an invented tree object id", async () => {
  const fixture = await createClosedRgrFixture("invented tree evidence");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  await writeFile(logPath, replaceRgrLogField(log, "RED", "tree", "ffffffffffffffffffffffffffffffffffffffff", 1));

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b cycle=1\/red object=ffffffffffffffffffffffffffffffffffffffff type=tree/);
});

test("plan case 22: verify-rgr rejects a real tree pasted into another cycle", async () => {
  const fixture = await createClosedRgrFixture("real tree ownership");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  copyCycleRefs(fixture, 1, 2);
  const pastedTree = findRgrRecord(log, "GREEN", 1).tree;
  const cycleTwo = parseRgrLog(log)
    .filter((record) => record.cycle === "1" && ["CYCLE", "RED", "GREEN", "REFACTOR"].includes(record.record))
    .map((record) => buildRgrLogLine({
      ...record,
      ...(record.record === "CYCLE" ? { cycle: "2", behavior: "pasted tree ownership" } : {}),
      ...(record.record === "RED" ? { tree: pastedTree } : {}),
    }));
  await writeFile(logPath, `${log.trimEnd()}\n${cycleTwo.join("\n")}\n`);

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b-prime cycle=2\/red .*expected=.* actual=/);
});

test("verify-rgr report declares its mechanical coverage boundary", async () => {
  const fixture = await createClosedRgrFixture("coverage report evidence");
  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stdout);
  const report = await readFile(`${fixture.cycleDir}/verify-rgr.md`, "utf8");

  assert.match(report, /^covered=cycle-order,refs,targeted-scalars,test-tree-invariants,suite-universe,suite-scalars,failsets,baselines,catches,provenance,outside-cycle-scope$/m);
  assert.match(report, /^not-covered=semantic-assertion-quality,refactor-behavior-equivalence,plan-test-coverage$/m);
});

test("verify-rgr computes numeric plan coverage beyond one digit", async () => {
  const fixture = await createClosedRgrFixture("numeric plan maximum");
  await writeFile(
    `${fixture.cycleDir}/plan.md`,
    "| Case | Behavior |\n|---|---|\n| 9 | early |\n| 81 | final |\n",
  );

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^warning plan-coverage cycles=1 planned-cases=81 manual-review-required=yes$/m);
});

test("verify-rgr rejects suite totals that contradict anchored run blobs", async () => {
  const fixture = await createClosedRgrFixture("suite evidence");
  assert.equal(runVerify(fixture.cycleDir).status, 0);

  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  await writeFile(logPath, replaceRgrLogField(log, "GREEN", "suite-fail", "99", 1));

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b-double-prime.*suite-fail.*expected=0.*actual=99/i);
});

test("verify-rgr rejects a suite exit that contradicts its anchored process status", async () => {
  const fixture = await createClosedRgrFixture("suite exit evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  let log = await readFile(logPath, "utf8");
  const green = findRgrRecord(log, "GREEN", 1);
  const statusKey = "status-suite-1";
  assert.ok(green[statusKey], "GREEN must anchor the actual suite process status");
  assert.match(green[statusKey], /^[0-9a-f]{40}$/);
  assert.equal(git(fixture.worktree, "cat-file", "blob", green[statusKey]), "0");
  const forgedStatus = writeGitBlob(fixture.worktree, "64\n");
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/green-status/suite-1`, forgedStatus);
  log = replaceRgrLogField(log, "GREEN", statusKey, forgedStatus, 1);
  await writeFile(logPath, log);

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b-double-prime.*suite-exit-1.*expected=64.*actual=0/i);
  assert.match(result.stdout, /check=b-double-prime.*status-suite-1.*expected=0.*actual=64/i);
});

test("verify-rgr requires the anchored suite process-status ref", async () => {
  const fixture = await createClosedRgrFixture("suite status ref evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  git(fixture.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/1/green-status/suite-1`);

  const result = runVerify(fixture.cycleDir);

  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /check=b-prime cycle=1\/green-status-suite-1 ref=.*missing=yes/);
});

test("verify-rgr rejects an invalid anchored suite process-status blob", async () => {
  const fixture = await createClosedRgrFixture("suite status blob evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  let log = await readFile(logPath, "utf8");
  const invalidStatus = writeGitBlob(fixture.worktree, "0\n64\n");
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/green-status/suite-1`, invalidStatus);
  log = replaceRgrLogField(log, "GREEN", "status-suite-1", invalidStatus, 1);
  await writeFile(logPath, log);

  const result = runVerify(fixture.cycleDir);

  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /^check=b-double-prime cycle=1\/green field=status-suite-1 error=invalid-status-blob$/m);
});

test("verify-rgr rejects a clean directive claim contradicted by a skipped run blob", async () => {
  const fixture = await createClosedRgrFixture("directive evidence");
  assert.equal(runVerify(fixture.cycleDir).status, 0);

  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  let log = await readFile(logPath, "utf8");
  const originalRun = findRgrRecord(log, "GREEN", 1)["run-targeted"];
  assert.match(originalRun, /^[0-9a-f]{40}$/);
  const skippedOutput = git(fixture.worktree, "cat-file", "blob", originalRun)
    .replace("ok 1 - directive evidence", "ok 1 - directive evidence # SKIP")
    .replace("# pass 1", "# pass 0")
    .replace("# skipped 0", "# skipped 1");
  const written = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: fixture.worktree,
    input: skippedOutput,
    encoding: "utf8",
  });
  assert.equal(written.status, 0, written.stderr);
  const skippedRun = written.stdout.trim();
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/green-run/targeted`, skippedRun);
  log = replaceRgrLogField(log, "GREEN", "run-targeted", skippedRun, 1);
  await writeFile(logPath, log);

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b-double-prime.*directive.*expected=SKIP.*actual=none/i);
});

test("verify-rgr requires exact contiguous cycles and rejects orphan cycle refs", async () => {
  const empty = await createRgrFixture('import test from "node:test";\ntest("baseline only", () => {});\n');
  const emptyResult = runVerify(empty.cycleDir);

  const gap = await createClosedRgrFixture("gap evidence");
  const gapLogPath = `${gap.cycleDir}/rgr.log`;
  const gapLog = await readFile(gapLogPath, "utf8");
  await writeFile(gapLogPath, gapLog.replace("CYCLE 1 ::", "CYCLE 2 ::"));
  moveCycleRefs(gap, 1, 2);
  const gapResult = runVerify(gap.cycleDir);

  const orphan = await createClosedRgrFixture("orphan evidence");
  const cycleId = orphan.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const redTree = git(orphan.worktree, "rev-parse", `refs/rgr/${cycleId}/1/red`);
  git(orphan.worktree, "update-ref", `refs/rgr/${cycleId}/2/red`, redTree);
  const orphanResult = runVerify(orphan.cycleDir);

  assert.equal(emptyResult.status, 2, emptyResult.stdout);
  assert.equal(gapResult.status, 2, gapResult.stdout);
  assert.equal(orphanResult.status, 2, orphanResult.stdout);
});

test("verify-rgr does not misclassify refs from a multi-cycle log as orphaned", async () => {
  const fixture = await createClosedRgrFixture("multi-cycle evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  copyCycleRefs(fixture, 1, 2);
  const refactorTree = findRgrRecord(log, "REFACTOR", 1).tree;
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/2/red`, refactorTree);
  const cycleTwoRecords = parseRgrLog(log).filter((record) =>
    record.cycle === "1" && ["CYCLE", "RED", "GREEN", "CATCHES", "REFACTOR"].includes(record.record))
    .map((record) => buildRgrLogLine({
      ...record,
      ...(record.record === "CYCLE" ? { cycle: "2", behavior: "multi-cycle evidence copy" } : {}),
      ...(record.record === "RED" ? { tree: refactorTree } : {}),
    }));
  await writeFile(logPath, `${log.trimEnd()}\n${cycleTwoRecords.join("\n")}\n`);

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stdout);
});

test("verify-rgr verifies pre-freeze REFACTOR suite-total field aliases", async () => {
  const fixture = await createClosedRgrFixture("pre-freeze total evidence");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  const refactor = findRgrRecord(log, "REFACTOR", 1);
  const legacyRefactor = {
    ...refactor,
    tests: refactor["suite-tests"],
    fail: refactor["suite-fail"],
  };
  delete legacyRefactor["suite-tests"];
  delete legacyRefactor["suite-fail"];
  await writeFile(logPath, log.replace(refactor.line, buildRgrLogLine(legacyRefactor)));

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stdout);
});

test("verify-rgr re-derives RED and GREEN targeted-run scalars", async () => {
  const fixture = await createClosedRgrFixture("targeted scalar evidence");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const originalLog = await readFile(logPath, "utf8");
  const mutations = [
    ["RED", "exit", "0"],
    ["RED", "class", "broken"],
    ["RED", "tests", "9"],
    ["RED", "pass", "9"],
    ["RED", "fail", "9"],
    ["RED", "skipped", "9"],
    ["RED", "todo", "9"],
    ["RED", "directive", "SKIP"],
    ["RED", "first", "not ok 1 - forged"],
    ["RED", "name", "forged"],
    ["GREEN", "target-exit", "7"],
    ["GREEN", "target-tests", "9"],
    ["GREEN", "target-pass", "9"],
    ["GREEN", "target-fail", "9"],
    ["GREEN", "skipped", "9"],
    ["GREEN", "todo", "9"],
    ["GREEN", "name-ok", "no"],
  ];

  for (const [record, key, value] of mutations) {
    await writeFile(logPath, replaceRgrLogField(originalLog, record, key, value, 1));
    const result = runVerify(fixture.cycleDir);
    assert.equal(result.status, 2, `${record}.${key}: ${result.stdout}`);
  }
  await writeFile(logPath, originalLog);
});

test("verify-rgr rechecks test-tree invariants and the indexed suite universe", async () => {
  const changedTreeFixture = await createClosedRgrFixture("changed test tree");
  const testPath = `${changedTreeFixture.worktree}/behavior.test.mjs`;
  const originalTest = await readFile(testPath, "utf8");
  await writeFile(testPath, `${originalTest}\n// forged test-tree change\n`);
  git(changedTreeFixture.worktree, "add", "behavior.test.mjs");
  const changedTestTree = git(changedTreeFixture.worktree, "write-tree");
  await writeFile(testPath, originalTest);
  git(changedTreeFixture.worktree, "add", "behavior.test.mjs");
  const cycleId = changedTreeFixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const changedLogPath = `${changedTreeFixture.cycleDir}/rgr.log`;
  const changedLog = await readFile(changedLogPath, "utf8");
  git(changedTreeFixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/refactor`, changedTestTree);
  await writeFile(changedLogPath, replaceRgrLogField(changedLog, "REFACTOR", "tree", changedTestTree, 1));
  const changedTreeResult = runVerify(changedTreeFixture.cycleDir);

  const suiteFixture = await createClosedRgrFixture("suite universe evidence");
  const suiteCycleId = suiteFixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const suiteLogPath = `${suiteFixture.cycleDir}/rgr.log`;
  const suiteLog = await readFile(suiteLogPath, "utf8");
  const refactor = findRgrRecord(suiteLog, "REFACTOR", 1);
  const duplicatedSuite = refactor["run-suite-1"];
  git(suiteFixture.worktree, "update-ref", `refs/rgr/${suiteCycleId}/1/refactor-run/suite-2`, duplicatedSuite);
  const forgedRefactor = buildRgrLogLine({
    ...refactor,
    "run-suite-2": duplicatedSuite,
    "suite-tests": String(Number(refactor["suite-tests"]) * 2),
    pass: String(Number(refactor.pass) * 2),
    "suite-fail": String(Number(refactor["suite-fail"]) * 2),
  });
  await writeFile(suiteLogPath, suiteLog.replace(refactor.line, forgedRefactor));
  const suiteResult = runVerify(suiteFixture.cycleDir);

  assert.equal(changedTreeResult.status, 2, changedTreeResult.stdout);
  assert.match(changedTreeResult.stdout, /^check=e cycle=1 interval=green-to-refactor files=behavior\.test\.mjs$/m);
  assert.equal(suiteResult.status, 2, suiteResult.stdout);
  assert.match(suiteResult.stdout, /^check=f cycle=1 phase=refactor error=suite-count expected=1 actual=2$/m);
});

test("verify-rgr derives failsets, immutable baselines, and catches evidence", async () => {
  const fixture = await createClosedRgrFixture("semantic evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const originalLog = await readFile(logPath, "utf8");
  const forgedFailset = writeGitBlob(fixture.worktree, "forged.test.mjs::forged failure\n");
  const originalGreenFailset = findRgrRecord(originalLog, "GREEN", 1).failset;
  const originalRefactorFailset = findRgrRecord(originalLog, "REFACTOR", 1).failset;

  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/green-failset`, forgedFailset);
  await writeFile(logPath, replaceRgrLogField(originalLog, "GREEN", "failset", forgedFailset, 1));
  const greenFailsetResult = runVerify(fixture.cycleDir);
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/green-failset`, originalGreenFailset);

  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/refactor-failset`, forgedFailset);
  await writeFile(logPath, replaceRgrLogField(originalLog, "REFACTOR", "failset", forgedFailset, 1));
  const refactorFailsetResult = runVerify(fixture.cycleDir);
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/refactor-failset`, originalRefactorFailset);

  let forgedBaselineLog = replaceRgrLogField(originalLog, "GREEN", "baseline", forgedFailset, 1);
  forgedBaselineLog = replaceRgrLogField(forgedBaselineLog, "REFACTOR", "baseline", forgedFailset, 1);
  await writeFile(logPath, forgedBaselineLog);
  const baselineOwnershipResult = runVerify(fixture.cycleDir);

  await writeFile(logPath, replaceRgrLogField(originalLog, "BASELINE", "fails", "99"));
  const baselineCountResult = runVerify(fixture.cycleDir);
  await writeFile(logPath, replaceRgrLogField(originalLog, "GREEN", "new-fails", "9", 1));
  const newFailuresResult = runVerify(fixture.cycleDir);
  await writeFile(logPath, replaceRgrLogField(originalLog, "REFACTOR", "failset-diff", "FORGED", 1));
  const failsetDiffResult = runVerify(fixture.cycleDir);
  await writeFile(logPath, originalLog);

  const catches = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("catches target evidence", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${catches.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(
    runRgr(catches, "red", "catches target evidence", "--test-file", "behavior.test.mjs", "--name", "catches target evidence").status,
    0,
  );
  await writeFile(`${catches.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(catches, "green").status, 0);
  assert.equal(runRgr(catches, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(catches, "refactor", "NONE: direct fixture export is already cohesive").status, 0);
  const catchesCycleId = catches.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const catchesLogPath = `${catches.cycleDir}/rgr.log`;
  const catchesLog = await readFile(catchesLogPath, "utf8");
  const emptyFailset = writeGitBlob(catches.worktree, "");
  git(catches.worktree, "update-ref", `refs/rgr/${catchesCycleId}/1/catches-failset`, emptyFailset);
  await writeFile(catchesLogPath, replaceRgrLogField(catchesLog, "CATCHES", "catches-failset", emptyFailset, 1));
  const catchesResult = runVerify(catches.cycleDir);

  for (const [label, result] of [
    ["green failset", greenFailsetResult],
    ["refactor failset", refactorFailsetResult],
    ["baseline ownership", baselineOwnershipResult],
    ["baseline count", baselineCountResult],
    ["new failures", newFailuresResult],
    ["failset diff", failsetDiffResult],
    ["catches", catchesResult],
  ]) {
    assert.equal(result.status, 2, `${label}: ${result.stdout}`);
  }
});

test("plan case 59: verify-rgr rejects a failset object that does not exist", async () => {
  const fixture = await createClosedRgrFixture("missing failset object");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const missing = "0000000000000000000000000000000000000000";
  const log = await readFile(logPath, "utf8");
  await writeFile(logPath, replaceRgrLogField(log, "GREEN", "failset", missing, 1));

  const result = runVerify(fixture.cycleDir);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=b cycle=1\/green-failset object=0000000000000000000000000000000000000000 type=blob/);
});

test("plan case 60: verify-rgr rejects a real failset attached to the wrong phase ref", async () => {
  const fixture = await createClosedRgrFixture("misattached failset object");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const forged = writeGitBlob(fixture.worktree, "other.test.mjs::other failure\n");
  const log = await readFile(logPath, "utf8");
  await writeFile(logPath, replaceRgrLogField(log, "GREEN", "failset", forged, 1));

  const result = runVerify(fixture.cycleDir);

  assert.equal(result.status, 2);
  assert.match(result.stdout, new RegExp(`check=b-prime cycle=1/green-failset .*expected=${forged} actual=`));
});

test("plan case 61: failset hashing is stable across suite order", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("failure a", () => assert.fail("a"));\n',
    { captureBaseline: false },
  );
  await writeFile(`${fixture.worktree}/b.test.mjs`, 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("failure b", () => assert.fail("b"));\n');
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const baseEnv = await readFile(envPath, "utf8");
  await writeFile(envPath, baseEnv.replace("TEST_CMD_N=1", "TEST_CMD_N=2").replace("TEST_CMD_1=node --test", "TEST_CMD_1=node --test behavior.test.mjs\nTEST_CMD_2=node --test b.test.mjs"));
  assert.equal(runRgr(fixture, "baseline").status, 0);
  const first = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "BASELINE").failset;
  await writeFile(envPath, baseEnv.replace("TEST_CMD_N=1", "TEST_CMD_N=2").replace("TEST_CMD_1=node --test", "TEST_CMD_1=node --test b.test.mjs\nTEST_CMD_2=node --test behavior.test.mjs"));
  assert.equal(runRgr(fixture, "baseline").status, 0);
  const baselines = rgrRecords(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "BASELINE");

  assert.equal(baselines[1].failset, first);
});

test("plan case 62: an anchored failset blob survives immediate git pruning", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("persistent failset", () => assert.fail("persist"));\n',
    { captureBaseline: false },
  );
  assert.equal(runRgr(fixture, "baseline").status, 0);
  const baseline = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "BASELINE");
  const before = git(fixture.worktree, "cat-file", "blob", baseline.failset);

  git(fixture.worktree, "gc", "--prune=now");

  assert.equal(git(fixture.worktree, "cat-file", "blob", baseline.failset), before);
});

test("plan case 77: Git rejects phase-run leaf and namespace conflicts in both directions", async () => {
  const repo = await initGitRepo("rgr-ref-conflict");
  const blob = writeGitBlob(repo, "raw run\n");
  git(repo, "update-ref", "refs/rgr/cycle/1/green-run", blob);
  const leafFirst = spawnSync("git", ["update-ref", "refs/rgr/cycle/1/green-run/targeted", blob], { cwd: repo, encoding: "utf8" });
  git(repo, "update-ref", "refs/rgr/cycle/1/refactor-run/targeted", blob);
  const namespaceFirst = spawnSync("git", ["update-ref", "refs/rgr/cycle/1/refactor-run", blob], { cwd: repo, encoding: "utf8" });

  assert.notEqual(leafFirst.status, 0);
  assert.match(leafFirst.stderr, /cannot lock ref/);
  assert.notEqual(namespaceFirst.status, 0);
  assert.match(namespaceFirst.stderr, /cannot lock ref/);
});

test("plan case 67: an anchored JUnit blob for roughly 800 tests stays below 10 KB", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\nfor (let i = 0; i < 799; i += 1) test(`bulk ${i}`, () => {});\ntest("bulk selected", () => assert.equal(value, 1));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "red", "bulk evidence", "--test-file", "behavior.test.mjs", "--name", "bulk selected").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  const green = findRgrRecord(await readFile(`${fixture.cycleDir}/rgr.log`, "utf8"), "GREEN", 1);
  const blob = green["run-suite-1"];
  git(fixture.worktree, "gc", "--prune=now");
  const measured = spawnSync("git", ["cat-file", "--batch-check=%(objectsize:disk)"], {
    cwd: fixture.worktree,
    input: `${blob}\n`,
    encoding: "utf8",
  });
  assert.equal(measured.status, 0, measured.stderr);
  const diskBytes = Number(measured.stdout.trim());

  // Measured 2026-09-10: 131,328 raw bytes, 3,706 bytes on disk after git gc.
  assert.ok(diskBytes < 10_000, `measured anchored JUnit blob: ${diskBytes} bytes`);
});

test("verify-rgr derives phase failsets even when both forged blobs agree", async () => {
  const fixture = await createRgrFixture(
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("derived target", () => assert.equal(value, 1));\n',
    { captureBaseline: false },
  );
  await writeFile(
    `${fixture.worktree}/persistent.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("persistent baseline failure", () => assert.equal(1, 2));\n',
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(fixture, "baseline").status, 0);
  assert.equal(
    runRgr(fixture, "red", "derive phase failsets", "--test-file", "behavior.test.mjs", "--name", "derived target").status,
    0,
  );
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 1;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: fixture behavior is already direct").status, 0);

  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const emptyFailset = writeGitBlob(fixture.worktree, "");
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/green-failset`, emptyFailset);
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/refactor-failset`, emptyFailset);
  const logPath = `${fixture.cycleDir}/rgr.log`;
  let forgedLog = await readFile(logPath, "utf8");
  forgedLog = replaceRgrLogField(forgedLog, "GREEN", "failset", emptyFailset, 1);
  forgedLog = replaceRgrLogField(forgedLog, "REFACTOR", "failset", emptyFailset, 1);
  await writeFile(logPath, forgedLog);

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /check=b-double-prime cycle=1\/green field=failset error=not-derived-from-suite-runs/);
  assert.match(result.stdout, /check=b-double-prime cycle=1\/refactor field=failset error=not-derived-from-suite-runs/);
});

test("verify-rgr enforces phase order, remaining suite scalars, and hash warnings", async () => {
  const fixture = await createClosedRgrFixture("phase audit evidence");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const originalLog = await readFile(logPath, "utf8");
  const lines = originalLog.trimEnd().split("\n");
  const redIndex = lines.findIndex((line) => line.startsWith("  RED"));
  const greenIndex = lines.findIndex((line) => line.startsWith("  GREEN"));
  [lines[redIndex], lines[greenIndex]] = [lines[greenIndex], lines[redIndex]];
  await writeFile(logPath, `${lines.join("\n")}\n`);
  const orderResult = runVerify(fixture.cycleDir);

  await writeFile(logPath, replaceRgrLogField(originalLog, "REFACTOR", "exit", "7", 1));
  const exitResult = runVerify(fixture.cycleDir);
  await writeFile(logPath, replaceRgrLogField(originalLog, "REFACTOR", "pass", "99", 1));
  const passResult = runVerify(fixture.cycleDir);
  await writeFile(
    logPath,
    `${originalLog.split("\n").filter((line) => !line.startsWith("BASELINE ")).join("\n")}`,
  );
  const missingBaselineResult = runVerify(fixture.cycleDir);

  await writeFile(logPath, replaceRgrLogField(originalLog, "REFACTOR", "hash", "fffffff", 1));
  const hashResult = runVerify(fixture.cycleDir);
  const hashReport = await readFile(`${fixture.cycleDir}/verify-rgr.md`, "utf8");

  assert.equal(orderResult.status, 2, orderResult.stdout);
  assert.equal(exitResult.status, 2, exitResult.stdout);
  assert.equal(passResult.status, 2, passResult.stdout);
  assert.equal(missingBaselineResult.status, 2, missingBaselineResult.stdout);
  assert.equal(hashResult.status, 0, hashResult.stdout);
  assert.match(hashReport, /^warning harness-hash-changed /m);
});

test("verify-rgr rejects production outside cycles and validates explicit exceptions", async () => {
  const g1 = await createClosedRgrFixture("g1 evidence");
  const g1CycleId = g1.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const g1LogPath = `${g1.cycleDir}/rgr.log`;
  const g1Log = await readFile(g1LogPath, "utf8");
  await writeFile(`${g1.worktree}/outside.mjs`, "export const outside = true;\n");
  git(g1.worktree, "add", "outside.mjs");
  const outsideTree = git(g1.worktree, "write-tree");
  await rm(`${g1.worktree}/outside.mjs`);
  git(g1.worktree, "add", "-u");
  git(g1.worktree, "update-ref", `refs/rgr/${g1CycleId}/1/red`, outsideTree);
  await writeFile(g1LogPath, replaceRgrLogField(g1Log, "RED", "tree", outsideTree, 1));
  const g1Result = runVerify(g1.cycleDir);

  const g2 = await createClosedRgrFixture("g2 evidence");
  const g2CycleId = g2.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const g2LogPath = `${g2.cycleDir}/rgr.log`;
  const g2Log = await readFile(g2LogPath, "utf8");
  copyCycleRefs(g2, 1, 2);
  await writeFile(`${g2.worktree}/between.mjs`, "export const between = true;\n");
  git(g2.worktree, "add", "between.mjs");
  const betweenTree = git(g2.worktree, "write-tree");
  await rm(`${g2.worktree}/between.mjs`);
  git(g2.worktree, "add", "-u");
  git(g2.worktree, "update-ref", `refs/rgr/${g2CycleId}/2/red`, betweenTree);
  const cycleOneRecords = parseRgrLog(g2Log).filter((record) =>
    record.cycle === "1" && ["CYCLE", "RED", "GREEN", "REFACTOR"].includes(record.record));
  const cycleTwoRecords = cycleOneRecords.map((record) => buildRgrLogLine({
    ...record,
    ...(record.record === "CYCLE" ? { cycle: "2", behavior: "g2 evidence copy" } : {}),
    ...(record.record === "RED" ? { tree: betweenTree } : {}),
  }));
  await writeFile(g2LogPath, `${g2Log.trimEnd()}\n${cycleTwoRecords.join("\n")}\n`);
  const g2Result = runVerify(g2.cycleDir);

  const g3 = await createClosedRgrFixture("g3 evidence");
  await writeFile(`${g3.worktree}/feature.mjs`, "export const value = 2;\n");
  const g3Result = runVerify(g3.cycleDir);
  const g3Allow = anchoredDynamicAllowOutside(
    g3.cycleDir, "feature.mjs", "fixture", "refactor-to-current", "measured fixture exception",
  );
  const allowedResult = runVerify(g3.cycleDir, ...g3Allow.args);
  const allowedReport = await readFile(`${g3.cycleDir}/verify-rgr.md`, "utf8");
  const missingReasonResult = runVerify(g3.cycleDir, "--allow-outside", "feature.mjs");
  const unknownArgumentResult = runVerify(g3.cycleDir, "--unknown");
  await writeFile(`${g3.worktree}/feature.mjs`, "export const value = 1;\n");
  await writeFile(`${g3.cycleDir}/harness.provenance`, "rgr-sha=0000000000000000000000000000000000000000\n");
  const provenanceResult = runVerify(g3.cycleDir);

  assert.equal(g1Result.status, 2, g1Result.stdout);
  assert.equal(g2Result.status, 2, g2Result.stdout);
  assert.equal(g3Result.status, 2, g3Result.stdout);
  assert.equal(allowedResult.status, 0, allowedResult.stdout);
  assert.match(
    allowedReport,
    new RegExp(`^exception type=allow-outside subject=feature\\.mjs scope=slot=fixture,interval=refactor-to-current,to-tree=${g3Allow.tree} reason="measured fixture exception"$`, "m"),
  );
  assert.equal(missingReasonResult.status, 1, missingReasonResult.stdout);
  assert.equal(unknownArgumentResult.status, 1, unknownArgumentResult.stdout);
  assert.equal(provenanceResult.status, 2, provenanceResult.stdout);
});

test("plan case 29: verify-rgr permits DOC_GLOBS changes outside cycles", async () => {
  const fixture = await createClosedRgrFixture("documentation scope");
  await writeFile(`${fixture.worktree}/README.md`, "fixture documentation\n");

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 0, result.stdout);
  assert.doesNotMatch(result.stdout, /check=g .*README\.md/);
});

test("plan case 34: verify-rgr treats implementer prompt templates as production", async () => {
  const fixture = await createClosedRgrFixture("prompt production scope");
  await writeFile(`${fixture.worktree}/implementer_prompt_template.md`, "behavioral prompt change\n");

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(
    result.stdout,
    /check=g slot=fixture interval=refactor-to-current file=implementer_prompt_template\.md/,
  );
});

test("verify-rgr audits production in a declared slot with no cycles", async () => {
  const fixture = await createClosedRgrFixture("active slot evidence");
  const idleRepo = await initGitRepo("rgr-idle-slot");
  await writeFile(`${idleRepo}/idle.mjs`, "export const value = 0;\n");
  git(idleRepo, "add", "idle.mjs");
  git(idleRepo, "commit", "-qm", "idle baseline");
  const idleBaseline = git(idleRepo, "rev-parse", "HEAD");
  await writeFile(`${idleRepo}/idle.mjs`, "export const value = 1;\n");

  const fixtureEnv = await readFile(`${fixture.cycleDir}/harness.fixture.env`, "utf8");
  await writeFile(
    `${fixture.cycleDir}/harness.idle.env`,
    fixtureEnv.replace(/^BASELINE_REF=.*$/m, `BASELINE_REF=${idleBaseline}`),
  );
  const declared = await readFile(`${fixture.cycleDir}/worktrees.env`, "utf8");
  await writeFile(
    `${fixture.cycleDir}/worktrees.env`,
    `${declared}idle=${await realpath(idleRepo)}\n`,
  );

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /check=g slot=idle interval=baseline-to-current file=idle\.mjs/);
});

test("verify-rgr authenticates the copied writer against its declared source and head", async () => {
  const fixture = await createClosedRgrFixture("source provenance evidence");
  const provenancePath = `${fixture.cycleDir}/harness.provenance`;
  const original = await readFile(provenancePath, "utf8");
  const staleSource = await initGitRepo("rgr-stale-source");
  await mkdir(`${staleSource}/harness`, { recursive: true });
  await writeFile(`${staleSource}/harness/rgr.sh`, "#!/usr/bin/env bash\n# stale writer\n");
  git(staleSource, "add", "harness/rgr.sh");
  git(staleSource, "commit", "-qm", "stale harness source");
  const staleHead = git(staleSource, "rev-parse", "HEAD");
  const staleProvenance = original
    .replace(/^source=.*$/m, `source=${staleSource}`)
    .replace(/^head=.*$/m, `head=${staleHead}`);
  await writeFile(provenancePath, staleProvenance);
  const sourceResult = runVerify(fixture.cycleDir);

  await writeFile(provenancePath, original.replace(/^head=.*$/m, "head=0000000000000000000000000000000000000000"));
  const headResult = runVerify(fixture.cycleDir);

  assert.equal(sourceResult.status, 2);
  assert.match(sourceResult.stdout, /check=provenance field=source-rgr-sha/);
  assert.equal(headResult.status, 2);
  assert.match(headResult.stdout, /check=provenance field=head/);
});

test("plan case 45: a cycle-local gate rejects a missing or changed writer copy", async () => {
  const fixture = await createClosedRgrFixture("cycle-local provenance");
  const copiedHarness = `${fixture.cycleDir}/harness`;
  await mkdir(copiedHarness, { recursive: true });
  for (const file of ["verify-rgr.sh", "rgr-log.sh", "rgr.sh"]) {
    const source = await readFile(new URL(`harness/${file}`, skillRoot), "utf8");
    await writeFile(`${copiedHarness}/${file}`, source);
  }
  await chmod(`${copiedHarness}/verify-rgr.sh`, 0o755);
  const runCopiedGate = () => spawnSync(`${copiedHarness}/verify-rgr.sh`, [], {
    cwd: repoRoot,
    env: { ...process.env, CYCLE_DIR: fixture.cycleDir },
    encoding: "utf8",
  });
  assert.equal(runCopiedGate().status, 0);

  await rm(`${copiedHarness}/rgr.sh`);
  const missing = runCopiedGate();
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /check=provenance field=rgr-sha .*actual=missing/);

  await writeFile(`${copiedHarness}/rgr.sh`, "#!/usr/bin/env bash\n# changed copy\n");
  const changed = runCopiedGate();
  assert.equal(changed.status, 2);
  assert.match(changed.stdout, /check=provenance field=rgr-sha/);
});

test("verify-rgr writes a usage-error report when it rejects arguments", async () => {
  const fixture = await createClosedRgrFixture("usage error evidence");
  const result = runVerify(fixture.cycleDir, "--allow-outside", "feature.mjs");
  const report = await readFile(`${fixture.cycleDir}/verify-rgr.md`, "utf8").catch(() => null);

  assert.equal(result.status, 1, result.stdout);
  assert.ok(report, "argument rejection must leave verify-rgr.md evidence");
  assert.match(report, /^RESULT: USAGE-ERROR$/m);
  assert.match(report, /^exit=1$/m);
  assert.match(
    report,
    /^reason="verify-rgr: --allow-outside requires <subject> \[--scope key=value\]\.\.\. --reason <reason>"$/m,
  );
});

test("verify-rgr treats Main declarations as one scoped argv family", async () => {
  const fixture = await createClosedRgrFixture("declaration family evidence");
  const fixtureCycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const fixtureLogPath = `${fixture.cycleDir}/rgr.log`;
  const fixtureLog = await readFile(fixtureLogPath, "utf8");
  await writeFile(fixtureLogPath, replaceRgrLogField(fixtureLog, "CYCLE", "env", "unverifiable", 1));
  git(fixture.worktree, "update-ref", "-d", `refs/rgr/${fixtureCycleId}/1/env`);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 2;\n");
  const familyAllow = anchoredDynamicAllowOutside(
    fixture.cycleDir, "feature.mjs", "fixture", "refactor-to-current", "measured outside-cycle exception",
  );
  const declared = runVerify(
    fixture.cycleDir,
    ...familyAllow.args,
    "--frontier", "env",
    "--scope", "until-cycle=1",
    "--reason", "historical env boundary",
    "--debt", "refactor-equivalence",
    "--scope", "cycle=1",
    "--reason", "reviewed historical debt",
  );
  assert.equal(declared.status, 0, declared.stdout || declared.stderr);
  assert.match(declared.stdout, /^DECLARED EXCEPTIONS$/m);
  assert.match(
    declared.stdout,
    new RegExp(`^exception type=allow-outside subject=feature\\.mjs scope=slot=fixture,interval=refactor-to-current,to-tree=${familyAllow.tree} reason="measured outside-cycle exception"$`, "m"),
  );
  assert.match(
    declared.stdout,
    /^exception type=frontier subject=env scope=until-cycle=1 reason="historical env boundary"$/m,
  );
  assert.match(
    declared.stdout,
    /^exception type=debt subject=refactor-equivalence scope=cycle=1 reason="reviewed historical debt"$/m,
  );

  const debtCannotWaive = runVerify(
    fixture.cycleDir,
    "--debt", "refactor-equivalence",
    "--scope", "cycle=1",
    "--reason", "disclosure does not waive violations",
  );
  assert.equal(debtCannotWaive.status, 2, debtCannotWaive.stdout);
  assert.match(debtCannotWaive.stdout, /^check=g slot=fixture interval=refactor-to-current file=feature\.mjs$/m);

  const outsideDebtScope = runVerify(
    fixture.cycleDir,
    "--debt", "refactor-equivalence",
    "--scope", "cycle=2",
    "--reason", "nonexistent cycle must not be covered",
  );
  assert.equal(outsideDebtScope.status, 2, outsideDebtScope.stdout);
  assert.match(outsideDebtScope.stdout, /^check=declaration type=debt subject=refactor-equivalence scope=cycle=2 error=unknown-cycle$/m);

  const logOwned = await createClosedRgrFixture("log declaration rejection");
  const logPath = `${logOwned.cycleDir}/rgr.log`;
  await writeFile(
    logPath,
    `${(await readFile(logPath, "utf8")).trimEnd()}\nEXCEPTION type=debt subject=refactor-equivalence scope=cycle=1 reason="self declared"\n`,
  );
  const selfDeclared = runVerify(logOwned.cycleDir);
  assert.equal(selfDeclared.status, 2, selfDeclared.stdout || selfDeclared.stderr);
  assert.match(selfDeclared.stderr, /rgr\.log contains an invalid line/);
});

test("verify-rgr documents that evidence frontiers close the past", async () => {
  const source = await readFile(new URL("harness/verify-rgr.sh", skillRoot), "utf8");

  assert.match(source, /A frontier declares a closed past, never a future/);
  assert.match(source, /Moving it forward signals\s+# that the evidence requirement is not implementable/);
});

test("verify-rgr interval-scoped outside exceptions do not hide other intervals", async () => {
  const fixture = await createClosedRgrFixture("scoped outside evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  let log = await readFile(logPath, "utf8");
  const originalRedTree = findRgrRecord(log, "RED", 1).tree;
  const originalRefactorTree = findRgrRecord(log, "REFACTOR", 1).tree;
  await writeFile(`${fixture.worktree}/shared.mjs`, "export const outside = true;\n");
  git(fixture.worktree, "read-tree", originalRedTree);
  git(fixture.worktree, "add", "shared.mjs");
  const firstOutsideTree = git(fixture.worktree, "write-tree");
  git(fixture.worktree, "read-tree", originalRefactorTree);
  git(fixture.worktree, "add", "shared.mjs");
  const secondOutsideTree = git(fixture.worktree, "write-tree");
  await rm(`${fixture.worktree}/shared.mjs`);
  git(fixture.worktree, "read-tree", "HEAD");
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/1/red`, firstOutsideTree);
  log = replaceRgrLogField(log, "RED", "tree", firstOutsideTree, 1);
  copyCycleRefs(fixture, 1, 2);
  git(fixture.worktree, "update-ref", `refs/rgr/${cycleId}/2/red`, secondOutsideTree);
  const cycleTwoRecords = parseRgrLog(log)
    .filter((record) => record.cycle === "1" && ["CYCLE", "RED", "GREEN", "REFACTOR"].includes(record.record))
    .map((record) => buildRgrLogLine({
      ...record,
      ...(record.record === "CYCLE" ? { cycle: "2", behavior: "second scoped interval" } : {}),
      ...(record.record === "RED" ? { tree: secondOutsideTree } : {}),
    }));
  await writeFile(logPath, `${log.trimEnd()}\n${cycleTwoRecords.join("\n")}\n`);

  const result = runVerify(
    fixture.cycleDir,
    "--allow-outside", "shared.mjs",
    "--scope", "interval=baseline-to-red-1",
    "--reason", "measured bootstrap interval",
  );
  const report = await readFile(`${fixture.cycleDir}/verify-rgr.md`, "utf8");

  assert.equal(result.status, 2, result.stdout);
  assert.match(
    report,
    /^exception type=allow-outside subject=shared\.mjs scope=interval=baseline-to-red-1 reason="measured bootstrap interval"$/m,
  );
  assert.doesNotMatch(report, /^check=g slot=fixture interval=baseline-to-red-1 file=shared\.mjs$/m);
  assert.match(report, /^check=g slot=fixture interval=refactor-to-red-2 file=shared\.mjs$/m);
});

test("verify-rgr slot-scoped outside exceptions do not hide another repository", async () => {
  const primary = await createClosedRgrFixture("primary slot exception");
  const secondary = await createClosedRgrFixture("secondary slot exception");
  const primaryId = primary.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const secondaryId = secondary.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const secondaryRefs = git(
    secondary.worktree,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `refs/rgr/${secondaryId}`,
  ).split("\n").filter(Boolean);
  for (const line of secondaryRefs) {
    const separator = line.indexOf(" ");
    const sourceRef = line.slice(0, separator);
    const object = line.slice(separator + 1);
    const targetRef = sourceRef
      .replace(`refs/rgr/${secondaryId}/1/`, `refs/rgr/${primaryId}/2/`)
      .replace(`refs/rgr/${secondaryId}/baseline/`, `refs/rgr/${primaryId}/baseline/`);
    git(secondary.worktree, "update-ref", targetRef, object);
  }

  const primaryWorktrees = await readFile(`${primary.cycleDir}/worktrees.env`, "utf8");
  await writeFile(
    `${primary.cycleDir}/worktrees.env`,
    `${primaryWorktrees}secondary=${await realpath(secondary.worktree)}\n`,
  );
  await writeFile(
    `${primary.cycleDir}/harness.secondary.env`,
    await readFile(`${secondary.cycleDir}/harness.fixture.env`, "utf8"),
  );
  const secondaryLog = await readFile(`${secondary.cycleDir}/rgr.log`, "utf8");
  const transplanted = parseRgrLog(secondaryLog)
    .filter((record) => record.record === "BASELINE" || record.cycle === "1")
    .map((record) => buildRgrLogLine({
      ...record,
      ...(record.record === "BASELINE" ? { slot: "secondary" } : {}),
      ...(record.record === "CYCLE" ? { cycle: "2", repo: "secondary" } : {}),
    }));
  const primaryLogPath = `${primary.cycleDir}/rgr.log`;
  const primaryLog = await readFile(primaryLogPath, "utf8");
  await writeFile(primaryLogPath, `${primaryLog.trimEnd()}\n${transplanted.join("\n")}\n`);

  await writeFile(`${primary.worktree}/shared.mjs`, "export const outside = 'primary';\n");
  await writeFile(`${secondary.worktree}/shared.mjs`, "export const outside = 'secondary';\n");
  const primaryAllow = anchoredDynamicAllowOutside(
    primary.cycleDir, "shared.mjs", "fixture", "refactor-to-current", "primary-only measured exception",
  );
  const result = runVerify(primary.cycleDir, ...primaryAllow.args);
  const report = await readFile(`${primary.cycleDir}/verify-rgr.md`, "utf8");

  assert.equal(result.status, 2);
  assert.doesNotMatch(report, /^check=g slot=fixture interval=refactor-to-current file=shared\.mjs$/m);
  assert.match(report, /^check=g slot=secondary interval=refactor-to-current file=shared\.mjs$/m);
  assert.match(
    report,
    new RegExp(`^exception type=allow-outside subject=shared\\.mjs scope=slot=fixture,interval=refactor-to-current,to-tree=${primaryAllow.tree} reason="primary-only measured exception"$`, "m"),
  );
});

test("verify-rgr uses the anchored cycle env when mutable globs are widened", async () => {
  const fixture = await createClosedRgrFixture("anchored env gate evidence");
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 2;\n");
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const widenedEnv = (await readFile(envPath, "utf8"))
    .replace("IGNORE_GLOBS=package-lock.json", "IGNORE_GLOBS=package-lock.json feature.mjs");
  await writeFile(envPath, widenedEnv);

  const result = runVerify(fixture.cycleDir);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stdout, /^check=g slot=fixture interval=refactor-to-current file=feature\.mjs$/m);
});

test("verify-rgr requires the anchored env ref claimed by each cycle", async () => {
  const fixture = await createClosedRgrFixture("env ref evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  git(fixture.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/1/env`);

  const result = runVerify(fixture.cycleDir);

  assert.equal(result.status, 2);
  assert.match(result.stdout, new RegExp(`check=b-prime cycle=1/env ref=refs/rgr/${cycleId}/1/env missing=yes`));
});

test("verify-rgr rejects an env evidence marker without a Main-declared frontier", async () => {
  const fixture = await createClosedRgrFixture("env frontier evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  const log = await readFile(logPath, "utf8");
  await writeFile(logPath, replaceRgrLogField(log, "CYCLE", "env", "unverifiable", 1));
  git(fixture.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/1/env`);

  const unauthenticated = runVerify(fixture.cycleDir);
  assert.equal(unauthenticated.status, 2, unauthenticated.stdout);

  const authorized = runVerify(
    fixture.cycleDir,
    "--frontier", "env", "--scope", "until-cycle=1", "--reason", "historical env fixture",
  );
  assert.equal(authorized.status, 0, authorized.stdout);
  assert.match(authorized.stdout, /^unverified dimension=env cycles=1 count=1$/m);
  assert.match(authorized.stdout, /^exception type=frontier subject=env scope=until-cycle=1 reason="historical env fixture"$/m);

  const beyondBoundary = runVerify(
    fixture.cycleDir,
    "--frontier", "env", "--scope", "until-cycle=0", "--reason", "empty env frontier",
  );
  assert.equal(beyondBoundary.status, 2, beyondBoundary.stdout);
});

test("verify-rgr reports historical suite exit and process-status frontiers", async () => {
  const fixture = await createClosedRgrFixture("suite exit frontier evidence");
  const cycleId = fixture.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${fixture.cycleDir}/rgr.log`;
  await writeFile(
    `${fixture.worktree}/behavior.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("suite exit frontier evidence", () => assert.ok(value >= 1));\ntest("suite frontier second cycle", () => assert.equal(value, 2));\n',
  );
  assert.equal(runRgr(fixture, "red", "second suite evidence cycle", "--test-file", "behavior.test.mjs", "--name", "suite frontier second cycle").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 2;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture value is already minimal").status, 0);

  await writeFile(
    `${fixture.worktree}/behavior.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("suite exit frontier evidence", () => assert.ok(value >= 1));\ntest("suite frontier second cycle", () => assert.ok(value >= 2));\ntest("suite frontier third cycle", () => assert.equal(value, 3));\n',
  );
  assert.equal(runRgr(fixture, "red", "first anchored suite evidence", "--test-file", "behavior.test.mjs", "--name", "suite frontier third cycle").status, 0);
  await writeFile(`${fixture.worktree}/feature.mjs`, "export const value = 3;\n");
  assert.equal(runRgr(fixture, "green").status, 0);
  assert.equal(runRgr(fixture, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(fixture, "refactor", "NONE: direct fixture value is already minimal").status, 0);

  let legacyLog = await readFile(logPath, "utf8");
  for (const cycle of [1, 2]) {
    for (const phase of ["GREEN", "REFACTOR"]) {
      const record = findRgrRecord(legacyLog, phase, cycle);
      delete record["suite-exit-1"];
      delete record["status-suite-1"];
      record["suite-exits"] = "unverifiable";
      legacyLog = legacyLog.replace(record.line, buildRgrLogLine(record));
    }
  }
  await writeFile(logPath, legacyLog);
  for (const cycle of [1, 2]) {
    git(fixture.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/${cycle}/green-status/suite-1`);
    git(fixture.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/${cycle}/refactor-status/suite-1`);
  }

  const unauthenticated = runVerify(fixture.cycleDir);
  assert.equal(unauthenticated.status, 2, unauthenticated.stdout);
  assert.match(
    unauthenticated.stdout,
    /^check=frontier dimension=suite-exits cycle=1 error=undeclared-or-beyond-boundary remedy="--frontier suite-exits --scope until-cycle=2 --reason <text>"$/m,
  );
  assert.match(
    unauthenticated.stdout,
    /^check=frontier dimension=suite-status cycle=1 error=undeclared-or-beyond-boundary remedy="--frontier suite-status --scope until-cycle=2 --reason <text>"$/m,
  );

  const authorized = runVerify(
    fixture.cycleDir,
    "--frontier", "suite-exits", "--scope", "until-cycle=2", "--reason", "historical suite exits",
    "--frontier", "suite-status", "--scope", "until-cycle=2", "--reason", "historical suite process status",
  );
  assert.equal(authorized.status, 0, authorized.stdout);
  assert.match(authorized.stdout, /^unverified dimension=suite-exits cycles=1-2 count=2$/m);
  assert.match(authorized.stdout, /^unverified dimension=suite-status cycles=1-2 count=2$/m);
  assert.match(authorized.stdout, /^exception type=frontier subject=suite-exits scope=until-cycle=2 reason="historical suite exits"$/m);
  assert.match(authorized.stdout, /^exception type=frontier subject=suite-status scope=until-cycle=2 reason="historical suite process status"$/m);

  const aliased = runVerify(
    fixture.cycleDir,
    "--frontier", "suite-exit", "--scope", "until-cycle=2", "--reason", "legacy spelling",
    "--frontier", "suite-status", "--scope", "until-cycle=2", "--reason", "historical suite process status",
  );
  assert.equal(aliased.status, 0, aliased.stdout);
  assert.match(aliased.stdout, /^exception type=frontier subject=suite-exits scope=until-cycle=2 reason="legacy spelling"$/m);
  assert.match(aliased.stdout, /^warning declaration alias=suite-exit canonical=suite-exits$/m);

  const noEvidence = await createClosedRgrFixture("no anchored catches evidence", { captureCatches: false });
  const absent = runVerify(noEvidence.cycleDir);
  assert.equal(absent.status, 2, absent.stdout);
  assert.match(
    absent.stdout,
    /^check=frontier dimension=catches cycle=1 error=undeclared-or-beyond-boundary evidence="no anchored evidence in any cycle"$/m,
  );
});

test("verify-rgr summarizes cycles without mutation verification as unverified catches", async () => {
  const fixture = await createClosedRgrFixture("missing catches frontier", { captureCatches: false });

  const unauthenticated = runVerify(fixture.cycleDir);
  assert.equal(unauthenticated.status, 2, unauthenticated.stdout);

  const authorized = runVerify(
    fixture.cycleDir,
    "--frontier", "catches", "--scope", "until-cycle=1", "--reason", "historical catches",
  );
  assert.equal(authorized.status, 0, authorized.stdout);
  assert.match(authorized.stdout, /^unverified dimension=catches cycles=1 count=1$/m);
  assert.match(authorized.stdout, /^exception type=frontier subject=catches scope=until-cycle=1 reason="historical catches"$/m);
});

test("verify-rgr rejects frontiers that cross anchored evidence or cover future cycles", async () => {
  const gap = await createClosedRgrFixture("frontier gap first cycle");
  const cycleId = gap.cycleDir.split("/").at(-1).replace(/^tmux-worker-cycle-/, "");
  const logPath = `${gap.cycleDir}/rgr.log`;
  await writeFile(
    `${gap.worktree}/behavior.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("frontier gap first cycle", () => assert.ok(value >= 1));\ntest("frontier gap second cycle", () => assert.equal(value, 2));\n',
  );
  assert.equal(runRgr(gap, "red", "anchor middle frontier evidence", "--test-file", "behavior.test.mjs", "--name", "frontier gap second cycle").status, 0);
  await writeFile(`${gap.worktree}/feature.mjs`, "export const value = 2;\n");
  assert.equal(runRgr(gap, "green").status, 0);
  assert.equal(runRgr(gap, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(gap, "refactor", "NONE: direct fixture value is already minimal").status, 0);

  await writeFile(
    `${gap.worktree}/behavior.test.mjs`,
    'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("frontier gap first cycle", () => assert.ok(value >= 1));\ntest("frontier gap second cycle", () => assert.ok(value >= 2));\ntest("frontier gap third cycle", () => assert.equal(value, 3));\n',
  );
  assert.equal(runRgr(gap, "red", "expose late frontier regression", "--test-file", "behavior.test.mjs", "--name", "frontier gap third cycle").status, 0);
  await writeFile(`${gap.worktree}/feature.mjs`, "export const value = 3;\n");
  assert.equal(runRgr(gap, "green").status, 0);
  assert.equal(runRgr(gap, "verify-catches", "--fix-file", "feature.mjs").status, 0);
  assert.equal(runRgr(gap, "refactor", "NONE: direct fixture value is already minimal").status, 0);

  let gapLog = await readFile(logPath, "utf8");
  for (const cycle of [1, 3]) {
    for (const phase of ["GREEN", "REFACTOR"]) {
      const record = findRgrRecord(gapLog, phase, cycle);
      delete record["status-suite-1"];
      gapLog = gapLog.replace(record.line, buildRgrLogLine(record));
    }
    git(gap.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/${cycle}/green-status/suite-1`);
    git(gap.worktree, "update-ref", "-d", `refs/rgr/${cycleId}/${cycle}/refactor-status/suite-1`);
  }
  await writeFile(logPath, gapLog);

  const crossing = runVerify(
    gap.cycleDir,
    "--frontier", "suite-status", "--scope", "until-cycle=3", "--reason", "must not cross evidence",
  );
  assert.equal(crossing.status, 2, crossing.stdout);
  assert.match(
    crossing.stdout,
    /^check=declaration type=frontier subject=suite-status scope=until-cycle=3 error=anchored-evidence-conflict detail="evidence exists at cycle 2; frontier cannot cover it"$/m,
  );
  assert.match(
    crossing.stdout,
    /^check=frontier dimension=suite-status cycle=3 error=evidence-regression first-anchored-cycle=2$/m,
  );

  const future = await createClosedRgrFixture("future frontier evidence", { captureCatches: false });
  const preauthorized = runVerify(
    future.cycleDir,
    "--frontier", "catches", "--scope", "until-cycle=2", "--reason", "must not cover future cycles",
  );
  assert.equal(preauthorized.status, 2, preauthorized.stdout);
  assert.match(
    preauthorized.stdout,
    /^check=declaration type=frontier subject=catches scope=until-cycle=2 error=future-cycle-boundary last-cycle=1$/m,
  );
});

test("verify-rgr rejects unused future and stale allow-outside declarations", async () => {
  const fixture = await createClosedRgrFixture("allow-outside temporal scope");
  const future = runVerify(
    fixture.cycleDir,
    "--allow-outside", "outside.mjs",
    "--scope", "slot=fixture",
    "--scope", "interval=refactor-to-red-2",
    "--reason", "must not pre-authorize cycle two",
  );
  assert.equal(future.status, 2, future.stdout);
  assert.match(
    future.stdout,
    /^check=declaration type=allow-outside subject=outside\.mjs scope=slot=fixture,interval=refactor-to-red-2 error=unknown-interval last-cycle=1$/m,
  );

  await writeFile(`${fixture.worktree}/outside.mjs`, "export const state = 'authorized';\n");
  const anchored = anchoredDynamicAllowOutside(
    fixture.cycleDir, "outside.mjs", "fixture", "refactor-to-current", "measured current exception",
  );
  const accepted = runVerify(fixture.cycleDir, ...anchored.args);
  assert.equal(accepted.status, 0, accepted.stdout);

  await writeFile(`${fixture.worktree}/outside.mjs`, "export const state = 'changed later';\n");
  const stale = runVerify(fixture.cycleDir, ...anchored.args);
  assert.equal(stale.status, 2, stale.stdout);
  const mismatch = stale.stdout.match(
    /^check=declaration type=allow-outside subject=outside\.mjs .*error=tree-mismatch expected=([0-9a-f]{40}) actual=([0-9a-f]{40})$/m,
  );
  assert.ok(mismatch, stale.stdout);
  assert.equal(mismatch[1], anchored.tree);
  assert.notEqual(mismatch[1], mismatch[2]);
  assert.match(stale.stdout, /^check=g slot=fixture interval=refactor-to-current file=outside\.mjs$/m);

  const unused = runVerify(
    fixture.cycleDir,
    "--allow-outside", "absent.mjs",
    "--scope", "slot=fixture",
    "--scope", "interval=baseline-to-red-1",
    "--reason", "nonexistent subject must not linger",
  );
  assert.equal(unused.status, 2, unused.stdout);
  assert.match(
    unused.stdout,
    /^check=declaration type=allow-outside subject=absent\.mjs scope=slot=fixture,interval=baseline-to-red-1 error=declared-but-unused$/m,
  );
});

test("rgr times out a hung test command and raises an Implementer question", async () => {
  const fixture = await createRgrFixture(
    'import test from "node:test";\ntest("timeout fixture", () => {});\n',
    { captureBaseline: false },
  );
  const envPath = `${fixture.cycleDir}/harness.fixture.env`;
  const envText = (await readFile(envPath, "utf8"))
    .replace("TEST_CMD_1=node --test", "TEST_CMD_1=node -e 'setTimeout(() => {}, 10000)'")
    .replace("TEST_TIMEOUT=5", "TEST_TIMEOUT=1");
  await writeFile(envPath, envText);

  const started = Date.now();
  const result = runRgr(fixture, "baseline");
  assert.equal(result.status, 5, result.stderr);
  assert.ok(Date.now() - started < 5000, "watchdog must stop the child near TEST_TIMEOUT");
  assert.match(`${result.stdout}${result.stderr}`, /===IMPL:QUESTION===.*test command timed out/s);
  assert.match(await readFile(`${fixture.cycleDir}/sentinels.log`, "utf8"), /^===IMPL:QUESTION===$/m);
});

test("runRgr removes parent-only Node test settings from the child", async () => {
  const previousOptions = process.env.NODE_OPTIONS;
  const previousCoverage = process.env.NODE_V8_COVERAGE;
  process.env.NODE_OPTIONS = "--test-reporter=junit";
  process.env.NODE_V8_COVERAGE = `${tmpdir()}/parent-only-coverage`;
  try {
    const fixture = await createRgrFixture(
      'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("intentional fixture red", () => assert.fail("expected fixture failure"));\n',
      { captureBaseline: false },
    );
    const capturePath = `${fixture.cycleDir}/child-environment.txt`;
    const wrapperPath = `${fixture.cycleDir}/capture-rgr-environment.sh`;
    await writeFile(
      wrapperPath,
      `#!/usr/bin/env bash
printf 'NODE_OPTIONS=%s\\n' "\${NODE_OPTIONS-<unset>}" > "$RGR_CAPTURE_FILE"
printf 'NODE_V8_COVERAGE=%s\\n' "\${NODE_V8_COVERAGE-<unset>}" >> "$RGR_CAPTURE_FILE"
printf 'NODE_TEST_CONTEXT=%s\\n' "\${NODE_TEST_CONTEXT-<unset>}" >> "$RGR_CAPTURE_FILE"
exec "$RGR_REAL_EXECUTABLE" "$@"
`,
    );
    await chmod(wrapperPath, 0o755);
    fixture.rgrExecutable = wrapperPath;
    fixture.rgrEnvironment = {
      RGR_CAPTURE_FILE: capturePath,
      RGR_REAL_EXECUTABLE: fileURLToPath(new URL("harness/rgr.sh", skillRoot)),
    };
    const result = runRgr(
      fixture,
      "red",
      "child environment is explicit",
      "--test-file",
      "behavior.test.mjs",
      "--name",
      "intentional fixture red",
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual((await readFile(capturePath, "utf8")).trimEnd().split("\n"), [
      "NODE_OPTIONS=<unset>",
      "NODE_V8_COVERAGE=<unset>",
      "NODE_TEST_CONTEXT=<unset>",
    ]);
  } finally {
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
    if (previousCoverage === undefined) delete process.env.NODE_V8_COVERAGE;
    else process.env.NODE_V8_COVERAGE = previousCoverage;
  }
});

test("plan case 79: only exec-boundary env cleanup removes inherited Node coverage", async () => {
  const root = await mkdtemp(`${tmpdir()}/rgr-coverage-cleanup-`);
  const coverageDir = `${root}/coverage`;
  await mkdir(coverageDir);
  const probe = `${root}/probe.mjs`;
  const parent = `${root}/parent.mjs`;
  await writeFile(probe, 'process.stdout.write(process.env.NODE_V8_COVERAGE ?? "<unset>");\n');
  await writeFile(parent, `
import { spawnSync } from "node:child_process";
const deleted = { ...process.env };
delete deleted.NODE_V8_COVERAGE;
const deleteResult = spawnSync(process.execPath, [${JSON.stringify(probe)}], { env: deleted, encoding: "utf8" });
const execResult = spawnSync("/usr/bin/env", ["-u", "NODE_V8_COVERAGE", process.execPath, ${JSON.stringify(probe)}], { env: process.env, encoding: "utf8" });
process.stdout.write(JSON.stringify({ deleted: deleteResult.stdout, exec: execResult.stdout }));
`);
  const measured = spawnSync(process.execPath, [parent], {
    env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
    encoding: "utf8",
  });
  assert.equal(measured.status, 0, measured.stderr);
  const observed = JSON.parse(measured.stdout);

  assert.equal(observed.deleted, coverageDir);
  assert.equal(observed.exec, "<unset>");
});

test("fixture runner is assertion-free because it is outside TEST_GLOBS", async () => {
  const fixtureRunnerUrl = new URL("harness/fixture-runner.mjs", skillRoot);
  const source = await readFile(fixtureRunnerUrl, "utf8");
  const assertionSyntax = [
    /\bfrom\s+["']node:assert(?:\/strict)?["']/,
    /\brequire\(\s*["']node:assert(?:\/strict)?["']\s*\)/,
    /\bassert(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/,
  ];

  assert.ok(assertionSyntax.some((pattern) => pattern.test('import assert from "node:assert/strict";')));
  assert.ok(assertionSyntax.some((pattern) => pattern.test("assert.equal(actual, expected);")));
  for (const pattern of assertionSyntax) {
    assert.doesNotMatch(source, pattern, `${fileURLToPath(fixtureRunnerUrl)} contains assertion syntax`);
  }
});

test("plan case 81: GREEN excludes fixture plumbing but protects test assertions", async () => {
  const source = 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { value } from "./feature.mjs";\ntest("glob boundary", () => assert.equal(value, 1));\n';
  const plumbing = await createRgrFixture(source, { captureBaseline: false });
  await writeFile(`${plumbing.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(plumbing, "baseline").status, 0);
  assert.equal(runRgr(plumbing, "red", "fixture plumbing", "--test-file", "behavior.test.mjs", "--name", "glob boundary").status, 0);
  await writeFile(`${plumbing.worktree}/feature.mjs`, "export const value = 1;\n");
  await writeFile(`${plumbing.worktree}/fixture-runner.mjs`, "export const plumbing = true;\n");
  assert.equal(runRgr(plumbing, "green").status, 0);
  assert.equal(findRgrRecord(await readFile(`${plumbing.cycleDir}/rgr.log`, "utf8"), "GREEN", 1)["tests-diff"], "EMPTY");

  const protectedTest = await createRgrFixture(source, { captureBaseline: false });
  await writeFile(`${protectedTest.worktree}/feature.mjs`, "export const value = 0;\n");
  assert.equal(runRgr(protectedTest, "baseline").status, 0);
  assert.equal(runRgr(protectedTest, "red", "protected assertion", "--test-file", "behavior.test.mjs", "--name", "glob boundary").status, 0);
  await writeFile(`${protectedTest.worktree}/feature.mjs`, "export const value = 1;\n");
  await writeFile(`${protectedTest.worktree}/harness.test.mjs`, 'import test from "node:test";\ntest("new assertion surface", () => {});\n');
  const rejected = runRgr(protectedTest, "green");

  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /tests changed between RED and GREEN: harness\.test\.mjs/);
});
