// fixture-runner.mjs
//
// WHY THIS EXISTS
// Harness tests launch rgr.sh from inside Node's own test runner. Under a JUnit
// reporter, an inherited NODE_OPTIONS conflicts with the child runner's TAP
// reporter and makes the child look broken. Deleting the parent-only settings
// from a JavaScript env object is still insufficient: Node re-injects
// NODE_V8_COVERAGE while creating the child. /usr/bin/env must therefore remove
// all three settings at the exec boundary, after Node can no longer add them.
//
// This module is intentionally outside TEST_GLOBS and contains execution
// plumbing only: it must never contain assertions. Every assertion belongs in
// harness.test.mjs, where GREEN and REFACTOR test immutability protects it. An
// assertion here would be a back door around that invariant.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const defaultRgrExecutable = fileURLToPath(new URL("rgr.sh", import.meta.url));
const parentOnlyNodeSettings = ["NODE_OPTIONS", "NODE_V8_COVERAGE", "NODE_TEST_CONTEXT"];

export function runRgr(fixture, ...args) {
  const env = { ...process.env, ...fixture.rgrEnvironment, CYCLE_DIR: fixture.cycleDir };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  const executable = fixture.rgrExecutable ?? defaultRgrExecutable;
  const unsetArguments = parentOnlyNodeSettings.flatMap((name) => ["-u", name]);
  return spawnSync("/usr/bin/env", [...unsetArguments, executable, ...args], {
    cwd: fixture.worktree,
    env,
    encoding: "utf8",
  });
}
