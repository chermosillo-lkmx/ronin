import assert from "node:assert/strict";
import test from "node:test";
import { parseProfile, parseRepoHarnessConfig, parseSelection, parseSuiteConfig } from "./model.js";

test("parseProfile rejects a newline secret and an invalid allowed origin", () => {
  assert.throws(() => parseProfile({ name: "dev", variables: { TOKEN: "a\nb" } }), /TOKEN/);
  assert.throws(() => parseProfile({ name: "dev", apiBaseUrl: "https://api.test", allowedOrigins: ["notaurl"] }), /allowedOrigins/);
});

test("parseProfile normalizes a valid profile with defaults", () => {
  assert.deepEqual(parseProfile({ name: "dev-mx", variables: { TOKEN: "abc" } }), {
    name: "dev-mx",
    variables: { TOKEN: "abc" },
    allowedOrigins: [],
    allowMutations: false,
  });
  assert.throws(() => parseProfile({ name: "dev mx" }), /name/);
  assert.throws(() => parseProfile({ name: "dev", variables: { "bad-key": "x" } }), /bad-key/);
});

test("parseSuiteConfig requires program + args and rejects shell strings and escaping paths", () => {
  const suite = parseSuiteConfig({ command: { program: "pytest", args: ["-q"] }, cwd: "ant-liebre-api", junitPath: "reports/junit.xml" });
  assert.deepEqual(suite, {
    command: { program: "pytest", args: ["-q"] },
    cwd: "ant-liebre-api",
    timeoutMs: 600_000,
    junitPath: "reports/junit.xml",
  });
  assert.throws(() => parseSuiteConfig({ command: "pytest -q" }), /command/);
  assert.throws(() => parseSuiteConfig({ command: { program: "sh", args: ["-c", "rm -rf /"] } }), /shell/);
  assert.throws(() => parseSuiteConfig({ command: { program: "pytest", args: [] }, cwd: "../other" }), /cwd/);
  assert.throws(() => parseSuiteConfig({ command: { program: "pytest", args: [] }, coberturaPath: "/etc/passwd" }), /coberturaPath/);
});

test("parseRepoHarnessConfig only accepts declared suite keys and unique profile names", () => {
  const cfg = parseRepoHarnessConfig({
    profiles: [{ name: "dev" }],
    suites: { unit: { command: { program: "npm", args: ["test"] } } },
  });
  assert.deepEqual(Object.keys(cfg.suites), ["unit"]);
  assert.throws(() => parseRepoHarnessConfig({ profiles: [{ name: "dev" }, { name: "dev" }] }), /profile/);
  assert.throws(() => parseRepoHarnessConfig({ suites: { shell: { command: { program: "sh", args: [] } } } }), /suite/);
});

test("parseSelection accepts only declared suites, all and failed shapes", () => {
  assert.deepEqual(parseSelection({ kind: "suites", repo: "api", profile: "dev", suites: ["unit"] }), {
    kind: "suites", repo: "api", profile: "dev", suites: ["unit"],
  });
  assert.deepEqual(parseSelection({ kind: "all", profile: "dev" }), { kind: "all", profile: "dev" });
  assert.deepEqual(parseSelection({ kind: "failed", profile: "dev" }), { kind: "failed", profile: "dev" });
  assert.throws(() => parseSelection({ kind: "suites", repo: "api", profile: "dev", suites: ["unit", "shell"] }), /suite/);
  assert.throws(() => parseSelection({ command: "rm -rf /" }), /kind/);
  assert.throws(() => parseSelection({ kind: "suites", repo: "../x", profile: "dev", suites: ["unit"] }), /repo/);
});
