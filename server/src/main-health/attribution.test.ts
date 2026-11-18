import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attributeMainHealth, parsePullRequest, type GitPort } from "./attribution.js";
import type { MainHealthMeasurement } from "./store.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function measurement(sha: string, status: "green" | "red", overrides: Partial<MainHealthMeasurement> = {}): MainHealthMeasurement {
  return {
    sha,
    repo: "api",
    status,
    tests: 1,
    total: 100,
    floor: 90,
    failed: [],
    errors: [],
    skipped: 0,
    skipped_by_reason: {},
    uncovered_by_file: {},
    duration: 10,
    at: 1,
    gate_rc: status === "green" ? 0 : 1,
    ...overrides,
  };
}

test("attribution usa el verde first-parent y cruza PR, autor, líneas y roja nueva", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-attribution-"));
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "tests"), { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, "src", "app.py"), "covered = True\n");
    writeFileSync(join(repoDir, "tests", "test_app.py"), "def test_ok(): assert True\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: baseline verde");
    const baselineSha = git(repoDir, "rev-parse", "HEAD");

    git(repoDir, "checkout", "-b", "feature");
    writeFileSync(join(repoDir, "src", "app.py"), "covered = True\ndangerous = True\n");
    writeFileSync(join(repoDir, "tests", "test_app.py"), "def test_ok(): assert True\ndef test_breaks(): assert False\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: introducir regresión (#73)");
    const secondParentGreenSha = git(repoDir, "rev-parse", "HEAD");

    git(repoDir, "checkout", "main");
    git(repoDir, "merge", "--no-ff", "feature", "-m", "Merge pull request #42 from feature");
    const redSha = git(repoDir, "rev-parse", "HEAD");
    const redId = "tests.test_app::test_breaks";
    const unattributedId = "external.module::boom";
    const red = measurement(redSha, "red", {
      failed: [redId],
      errors: [unattributedId],
      uncovered_by_file: { "src/app.py": [2] },
      at: 30,
    });
    const commands: string[][] = [];
    const port: GitPort = {
      run: async (args, cwd) => {
        commands.push(args);
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      },
    };

    const report = await attributeMainHealth({
      repoDir,
      red,
      measurements: [
        measurement(secondParentGreenSha, "green", { at: 20 }),
        measurement(baselineSha, "green", { at: 10 }),
      ],
    }, port);

    assert.equal(report.status, "attributed");
    assert.equal(report.reason, null);
    assert.equal(report.greenSha, baselineSha);
    assert.deepEqual(report.newRed, [redId, unattributedId]);
    assert.deepEqual(report.unattributedRed, [unattributedId]);
    assert.deepEqual(report.culpritShas, [redSha]);
    assert.equal(report.commits.length, 1);
    assert.deepEqual(report.commits[0], {
      sha: redSha,
      author: { name: "Ada Tester", email: "ada@example.com" },
      pr: 42,
      message: "Merge pull request #42 from feature",
      files: ["src/app.py", "tests/test_app.py"],
      addedLinesByFile: { "src/app.py": [2], "tests/test_app.py": [2] },
      uncoveredAddedByFile: { "src/app.py": [2] },
      newRed: [redId],
    });
    assert.ok(commands.some((args) => args.join(" ") === `rev-list --first-parent --reverse ${baselineSha}..${redSha}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attribution conserva coordenadas finales de cobertura cuando un commit posterior desplaza líneas", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-lines-"));
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, "src", "shift.py"), "top = 1\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: baseline");
    const greenSha = git(repoDir, "rev-parse", "HEAD");

    writeFileSync(join(repoDir, "src", "shift.py"), "top = 1\ntarget = 2\n");
    git(repoDir, "commit", "-am", "feat: añadir objetivo");
    const authorSha = git(repoDir, "rev-parse", "HEAD");

    writeFileSync(join(repoDir, "src", "shift.py"), "inserted = 0\ntop = 1\ntarget = 2\n");
    git(repoDir, "commit", "-am", "refactor: insertar encabezado");
    const redSha = git(repoDir, "rev-parse", "HEAD");

    const report = await attributeMainHealth({
      repoDir,
      red: measurement(redSha, "red", { uncovered_by_file: { "src/shift.py": [3] } }),
      measurements: [measurement(greenSha, "green")],
    });

    assert.deepEqual(report.culpritShas, [authorSha]);
    assert.deepEqual(report.commits.map((commit) => ({
      sha: commit.sha,
      added: commit.addedLinesByFile,
      uncovered: commit.uncoveredAddedByFile,
    })), [
      { sha: authorSha, added: { "src/shift.py": [2] }, uncovered: { "src/shift.py": [3] } },
      { sha: redSha, added: { "src/shift.py": [1] }, uncovered: {} },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attribution conserva paths Unicode con espacios mediante salida NUL", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-paths-"));
  const repoDir = join(root, "repo");
  const relativeFile = "src/área con espacio.py";
  mkdirSync(join(repoDir, "src"), { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, relativeFile), "covered = 1\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: baseline");
    const greenSha = git(repoDir, "rev-parse", "HEAD");

    writeFileSync(join(repoDir, relativeFile), "covered = 1\nuncovered = 2\n");
    git(repoDir, "commit", "-am", "feat: añadir línea Unicode");
    const redSha = git(repoDir, "rev-parse", "HEAD");

    const input = {
      repoDir,
      red: measurement(redSha, "red", {
        uncovered_by_file: { "generated/missing.py": [1], [relativeFile]: [2] },
      }),
      measurements: [measurement(greenSha, "green")],
    };
    const report = await attributeMainHealth(input);

    assert.deepEqual(report.commits[0].files, [relativeFile]);
    assert.deepEqual(report.commits[0].addedLinesByFile, { [relativeFile]: [2] });
    assert.deepEqual(report.commits[0].uncoveredAddedByFile, { [relativeFile]: [2] });
    assert.deepEqual(report.culpritShas, [redSha]);

    const failingPort: GitPort = {
      run: async (args, cwd) => {
        if (args.includes("blame") && args.at(-1) === relativeFile) throw new Error("falló blame tocado");
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      },
    };
    await assert.rejects(() => attributeMainHealth(input, failingPort), /falló blame tocado/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attribution trata __proto__ como path Git sin indexar prototipos", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-proto-"));
  const repoDir = join(root, "repo");
  const relativeFile = "__proto__";
  mkdirSync(repoDir, { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, relativeFile), "covered\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: baseline");
    const greenSha = git(repoDir, "rev-parse", "HEAD");

    writeFileSync(join(repoDir, relativeFile), "covered\nuncovered\n");
    git(repoDir, "commit", "-am", "feat: tocar path especial");
    const redSha = git(repoDir, "rev-parse", "HEAD");
    const bySpecialPath = Object.fromEntries([[relativeFile, [2]]]) as Record<string, number[]>;

    const report = await attributeMainHealth({
      repoDir,
      red: measurement(redSha, "red", { uncovered_by_file: bySpecialPath }),
      measurements: [measurement(greenSha, "green")],
    });

    assert.deepEqual(report.commits[0].files, [relativeFile]);
    assert.deepEqual(report.commits[0].addedLinesByFile, bySpecialPath);
    assert.deepEqual(report.commits[0].uncoveredAddedByFile, bySpecialPath);
    assert.doesNotThrow(() => JSON.stringify(report));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attribution trata pathspecs mágicos y backslash como filenames literales", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-literal-"));
  const repoDir = join(root, "repo");
  const files = ["*.ts", ":(exclude)x", "back\\slash.ts", "other.ts"];
  mkdirSync(repoDir, { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    for (const file of files) writeFileSync(join(repoDir, file), "base\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: baseline literal");
    const greenSha = git(repoDir, "rev-parse", "HEAD");

    for (const file of files) writeFileSync(join(repoDir, file), "base\nadded\n");
    git(repoDir, "commit", "-am", "feat: tocar paths literales");
    const redSha = git(repoDir, "rev-parse", "HEAD");
    const uncovered = Object.fromEntries(files.slice(0, 3).map((file) => [file, [2]]));

    const report = await attributeMainHealth({
      repoDir,
      red: measurement(redSha, "red", { uncovered_by_file: uncovered }),
      measurements: [measurement(greenSha, "green")],
    });

    assert.deepEqual(report.commits[0].files, files);
    assert.deepEqual(report.commits[0].addedLinesByFile, Object.fromEntries(files.map((file) => [file, [2]])));
    assert.deepEqual(report.commits[0].uncoveredAddedByFile, uncovered);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attribution relaciona IDs por segmentos exactos y no app dentro de happy", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-ids-"));
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, "tests"), { recursive: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, "README.md"), "baseline\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "chore: baseline");
    const greenSha = git(repoDir, "rev-parse", "HEAD");

    writeFileSync(join(repoDir, "app.py"), "app = True\n");
    writeFileSync(join(repoDir, "tests", "test_app.py"), "def test_break(): assert False\n");
    writeFileSync(join(repoDir, "src", "core.py"), "raise RuntimeError\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: añadir regresiones");
    const redSha = git(repoDir, "rev-parse", "HEAD");
    const falsePositive = "tests.test_happy::test_no";
    const exactTest = "tests.test_app::test_break";
    const exactModule = "src.core::ImportError";

    const report = await attributeMainHealth({
      repoDir,
      red: measurement(redSha, "red", { failed: [falsePositive, exactTest], errors: [exactModule] }),
      measurements: [measurement(greenSha, "green")],
    });

    assert.deepEqual(report.commits[0].newRed, [exactTest, exactModule]);
    assert.deepEqual(report.unattributedRed, [falsePositive]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("attribution reporta explícitamente que no existe medición verde previa", async () => {
  const sha = "a".repeat(40);
  const port: GitPort = { run: async () => { throw new Error("git no debe ejecutarse sin verdes"); } };
  const report = await attributeMainHealth({ repoDir: "/repo/inexistente", red: measurement(sha, "red"), measurements: [] }, port);

  assert.deepEqual(report, {
    status: "no_prior_green",
    reason: "sin medición verde previa",
    redSha: sha,
    greenSha: null,
    commits: [],
    culpritShas: [],
    newRed: [],
    unattributedRed: [],
  });
});

test("attribution rechaza un SHA con aspecto de opción antes de invocar git", async () => {
  let called = false;
  const port: GitPort = {
    run: async () => {
      called = true;
      throw new Error("git no debe ejecutarse");
    },
  };

  await assert.rejects(
    () => attributeMainHealth({ repoDir: "/repo", red: measurement("--all", "red"), measurements: [] }, port),
    /SHA rojo inválido/,
  );
  await assert.rejects(
    () => attributeMainHealth({ repoDir: "/repo", red: measurement("a".repeat(40), "green"), measurements: [] }, port),
    /requiere una medición roja/,
  );
  await assert.rejects(
    () => attributeMainHealth({
      repoDir: "/repo",
      red: measurement("a".repeat(40), "red", { repo: "../api" }),
      measurements: [],
    }, port),
    /repo rojo inválido/,
  );
  await assert.rejects(
    () => attributeMainHealth({
      repoDir: "/repo",
      red: { ...measurement("a".repeat(40), "red"), tests: "uno" } as unknown as MainHealthMeasurement,
      measurements: [],
    }, port),
    /medición roja inválida/,
  );
  await assert.rejects(
    () => attributeMainHealth({
      repoDir: "/repo",
      red: measurement("a".repeat(40), "red"),
      measurements: [measurement("--all", "green")],
    }, port),
    /SHA candidato inválido/,
  );
  assert.equal(called, false);
});

test("attribution propaga un fallo al consultar parents en vez de tratarlo como root", async () => {
  const greenSha = "a".repeat(40);
  const redSha = "b".repeat(40);
  const port: GitPort = {
    run: async (args) => {
      if (args[0] === "rev-list" && args.includes("--reverse")) return `${redSha}\n`;
      if (args[0] === "rev-list" && args.includes("--parents")) throw new Error("falló consulta de parents");
      if (args[0] === "rev-list") return `${redSha}\n${greenSha}\n`;
      if (args[0] === "show") return "Ada Tester\0ada@example.com\0feat: cambio\n";
      if (args[0] === "rev-parse") throw new Error("falló consulta de parents");
      if (args[0] === "diff-tree") return "";
      throw new Error(`comando inesperado: ${args.join(" ")}`);
    },
  };

  await assert.rejects(
    () => attributeMainHealth({
      repoDir: "/repo",
      red: measurement(redSha, "red"),
      measurements: [measurement(greenSha, "green")],
    }, port),
    /falló consulta de parents/,
  );
});

test("attribution obtiene el diff de un commit raíz real sin confundirlo con un error Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-root-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir, { recursive: true });
  try {
    git(repoDir, "init", "-b", "main");
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, "root.txt"), "primera línea\n");
    git(repoDir, "add", ".");
    git(repoDir, "commit", "-m", "feat: commit raíz");
    const redSha = git(repoDir, "rev-parse", "HEAD");
    const syntheticGreenSha = "a".repeat(40);
    const port: GitPort = {
      run: async (args, cwd) => {
        if (args[0] === "rev-list" && args.includes("--parents")) {
          return execFileSync("git", args, { cwd, encoding: "utf8" });
        }
        if (args[0] === "rev-list" && args.includes("--reverse")) return `${redSha}\n`;
        if (args[0] === "rev-list" && args.includes("--first-parent")) return `${redSha}\n${syntheticGreenSha}\n`;
        return execFileSync("git", args, { cwd, encoding: "utf8" });
      },
    };

    const report = await attributeMainHealth({
      repoDir,
      red: measurement(redSha, "red"),
      measurements: [measurement(syntheticGreenSha, "green")],
    }, port);

    assert.deepEqual(report.commits[0].files, ["root.txt"]);
    assert.deepEqual(report.commits[0].addedLinesByFile, { "root.txt": [1] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parsePullRequest reconoce el sufijo squash (#N)", () => {
  assert.equal(parsePullRequest("feat: entregar salud (#73)\n\nCo-Authored-By: Pair <pair@example.com>"), 73);
});
