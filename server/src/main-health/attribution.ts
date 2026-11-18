import { execFile } from "node:child_process";
import type { MainHealthMeasurement } from "./store.js";

export interface GitPort {
  run(args: string[], cwd: string): Promise<string>;
}

export interface AttributionCommit {
  sha: string;
  author: { name: string; email: string };
  pr: number | null;
  message: string;
  files: string[];
  addedLinesByFile: Record<string, number[]>;
  uncoveredAddedByFile: Record<string, number[]>;
  newRed: string[];
}

export interface MainHealthAttribution {
  status: "attributed" | "no_prior_green";
  reason: "sin medición verde previa" | null;
  redSha: string;
  greenSha: string | null;
  commits: AttributionCommit[];
  culpritShas: string[];
  newRed: string[];
  unattributedRed: string[];
}

export interface AttributionInput {
  repoDir: string;
  red: MainHealthMeasurement;
  measurements: MainHealthMeasurement[];
}

/** Puerto Git real; los tests y consumidores pueden sustituirlo sin tocar procesos globales. */
export function createExecFileGitPort(): GitPort {
  return {
    run(args, cwd) {
      return new Promise((resolve, reject) => {
        execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
    },
  };
}

export function parsePullRequest(message: string): number | null {
  const merge = /\bMerge pull request #(\d+)\b/i.exec(message);
  if (merge) return Number(merge[1]);
  const subject = message.split(/\r?\n/, 1)[0].trim();
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  return squash ? Number(squash[1]) : null;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function emptyReport(redSha: string): MainHealthAttribution {
  return {
    status: "no_prior_green",
    reason: "sin medición verde previa",
    redSha,
    greenSha: null,
    commits: [],
    culpritShas: [],
    newRed: [],
    unattributedRed: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/** Extrae los números de línea nueva; el path llega por el canal NUL, nunca por el patch. */
function parseAddedLines(diff: string): number[] {
  const result: number[] = [];
  let nextNewLine: number | null = null;
  for (const line of diff.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      nextNewLine = Number(hunk[1]);
      continue;
    }
    if (nextNewLine === null || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      result.push(nextNewLine);
      nextNewLine += 1;
    } else if (!line.startsWith("-")) {
      nextNewLine += 1;
    }
  }
  return result;
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0).map(normalizedPath);
}

function redIdTouchesFile(id: string, file: string): boolean {
  const normalizedId = id.toLowerCase().replaceAll("\\", "/");
  const path = normalizedPath(file).toLowerCase();
  if (normalizedId.includes(path)) return true;

  const stem = path.replace(/\.[^/.]+$/, "");
  const classname = normalizedId.split("::", 1)[0].trim();
  const classnamePath = classname.replaceAll(".", "/");
  if (classnamePath === stem || classnamePath.startsWith(`${stem}/`) || stem.endsWith(`/${classnamePath}`)) return true;

  // También cubre IDs que incluyen un módulo fuente en notación Python (p. ej. src.app).
  return normalizedId.replaceAll(".", "/").includes(stem);
}

async function diffsByFile(
  git: GitPort,
  repoDir: string,
  files: string[],
  argsFor: (file: string) => string[],
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  for (const file of files) result.set(file, parseAddedLines(await git.run(argsFor(file), repoDir)));
  return result;
}

async function commitDiff(git: GitPort, repoDir: string, sha: string): Promise<{
  files: string[];
  addedLinesByFile: Map<string, number[]>;
}> {
  let parent: string | null = null;
  try {
    parent = (await git.run(["rev-parse", "--verify", `${sha}^1`], repoDir)).trim();
  } catch {
    // Un commit raíz no tiene ^1.
  }
  if (parent) {
    const fileOutput = await git.run(["diff", "--name-only", "-z", "--no-renames", parent, sha, "--"], repoDir);
    const files = nulPaths(fileOutput);
    const addedLinesByFile = await diffsByFile(git, repoDir, files, (file) => [
      "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", parent!, sha, "--", file,
    ]);
    return { files, addedLinesByFile };
  }
  // diff-tree --root compara el commit inicial contra el árbol vacío.
  const fileOutput = await git.run(
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", sha, "--"],
    repoDir,
  );
  const files = nulPaths(fileOutput);
  const addedLinesByFile = await diffsByFile(git, repoDir, files, (file) => [
    "diff-tree", "--root", "--no-commit-id", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames", sha, "--", file,
  ]);
  return { files, addedLinesByFile };
}

async function inspectCommit(
  git: GitPort,
  repoDir: string,
  sha: string,
): Promise<AttributionCommit> {
  const metadata = await git.run(["show", "-s", "--format=%an%x00%ae%x00%B", sha, "--"], repoDir);
  const [name = "", email = "", ...messageParts] = metadata.split("\0");
  const message = messageParts.join("\0").trim();
  const { files, addedLinesByFile } = await commitDiff(git, repoDir, sha);
  return {
    sha,
    author: { name: name.trim(), email: email.trim() },
    pr: parsePullRequest(message),
    message,
    files,
    addedLinesByFile: Object.fromEntries(addedLinesByFile),
    uncoveredAddedByFile: {},
    newRed: [],
  };
}

function blameByFinalLine(output: string): Map<number, string> {
  const result = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const header = /^\^?([A-Fa-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) result.set(Number(header[2]), header[1].toLowerCase());
  }
  return result;
}

async function assignUncoveredLines(
  git: GitPort,
  repoDir: string,
  red: MainHealthMeasurement,
  commits: AttributionCommit[],
): Promise<void> {
  const bySha = new Map(commits.map((commit) => [commit.sha.toLowerCase(), commit]));
  const uncoveredByCommit = new Map(commits.map((commit) => [commit, new Map<string, number[]>()]));
  for (const [file, uncoveredLines] of Object.entries(red.uncovered_by_file)) {
    if (uncoveredLines.length === 0) continue;
    const output = await git.run(["blame", "--first-parent", "--line-porcelain", red.sha, "--", file], repoDir);
    const blamed = blameByFinalLine(output);
    for (const finalLine of uncoveredLines) {
      const commit = bySha.get(blamed.get(finalLine) ?? "");
      if (!commit) continue;
      const paths = uncoveredByCommit.get(commit)!;
      const values = paths.get(file) ?? [];
      values.push(finalLine);
      paths.set(file, values);
    }
  }
  for (const commit of commits) commit.uncoveredAddedByFile = Object.fromEntries(uncoveredByCommit.get(commit)!);
}

export async function attributeMainHealth(
  input: AttributionInput,
  git: GitPort = createExecFileGitPort(),
): Promise<MainHealthAttribution> {
  if (input.red.status !== "red") throw new Error("attribution requiere una medición roja");
  const greens = input.measurements.filter(
    (measurement) => measurement.status === "green" && measurement.repo === input.red.repo,
  );
  if (greens.length === 0) return emptyReport(input.red.sha);

  const firstParentHistory = lines(await git.run(["rev-list", "--first-parent", input.red.sha], input.repoDir));
  const greenBySha = new Map(greens.map((measurement) => [measurement.sha.toLowerCase(), measurement]));
  const greenSha = firstParentHistory.find((sha) => greenBySha.has(sha.toLowerCase()));
  if (!greenSha) return emptyReport(input.red.sha);
  const green = greenBySha.get(greenSha.toLowerCase())!;

  const range = await git.run(
    ["rev-list", "--first-parent", "--reverse", `${greenSha}..${input.red.sha}`],
    input.repoDir,
  );
  const commits: AttributionCommit[] = [];
  for (const sha of lines(range)) {
    commits.push(await inspectCommit(git, input.repoDir, sha));
  }
  await assignUncoveredLines(git, input.repoDir, input.red, commits);

  const previousRed = new Set([...green.failed, ...green.errors]);
  const newRed = unique([...input.red.failed, ...input.red.errors]).filter((id) => !previousRed.has(id));
  const unattributedRed: string[] = [];
  for (const id of newRed) {
    const commit = [...commits].reverse().find((candidate) => candidate.files.some((file) => redIdTouchesFile(id, file)));
    if (commit) commit.newRed.push(id);
    else unattributedRed.push(id);
  }

  const culpritShas = commits
    .filter((commit) => commit.newRed.length > 0 || Object.keys(commit.uncoveredAddedByFile).length > 0)
    .map((commit) => commit.sha);
  return {
    status: "attributed",
    reason: null,
    redSha: input.red.sha,
    greenSha,
    commits,
    culpritShas,
    newRed,
    unattributedRed,
  };
}
