import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { boundOutput, readCoverageFile, readJUnitFile, redactEvidence, summarizeCobertura, summarizeJUnit, summarizeLcov } from "./artifacts.js";

test("summarizeJUnit normalizes failures and bounded output", () => {
  const result = summarizeJUnit(
    `<testsuite tests="2" failures="1"><testcase name="ok"/><testcase name="bad" classname="t.mod"><failure message="boom">trace</failure></testcase></testsuite>`
  );
  assert.deepEqual(result.totals, { total: 2, passed: 1, failed: 1, skipped: 0, errors: 0 });
  assert.deepEqual(result.failures, [{ name: "bad", classname: "t.mod", message: "boom" }]);
});

test("summarizeJUnit walks nested testsuites and counts errors and skips (pytest + vitest shapes)", () => {
  const result = summarizeJUnit(`<?xml version="1.0"?>
<testsuites>
  <testsuite name="a" tests="3"><testcase name="p"/><testcase name="s"><skipped/></testcase><testcase name="e"><error message="kaboom"/></testcase></testsuite>
  <testsuite name="b" tests="1"><testcase name="p2"/></testsuite>
</testsuites>`);
  assert.deepEqual(result.totals, { total: 4, passed: 2, failed: 0, skipped: 1, errors: 1 });
  assert.equal(result.failures[0].message, "kaboom");
});

test("summarizeJUnit rejects a document without testsuite", () => {
  assert.throws(() => summarizeJUnit("<html/>"), /JUnit/);
  assert.throws(() => summarizeJUnit("not xml <"), /JUnit/);
});

test("summarizeCobertura reads line-rate and branch-rate as percentages", () => {
  const cov = summarizeCobertura(`<?xml version="1.0"?><coverage line-rate="0.5432" branch-rate="0.25" lines-valid="100" lines-covered="54"></coverage>`);
  assert.deepEqual(cov, { status: "reported", lines: 54.32, branches: 25 });
  assert.equal(summarizeCobertura("<coverage/>").status, "invalid");
});

test("summarizeLcov aggregates LF/LH and BRF/BRH across files", () => {
  const cov = summarizeLcov("SF:a.ts\nLF:10\nLH:5\nBRF:4\nBRH:1\nend_of_record\nSF:b.ts\nLF:10\nLH:10\nend_of_record\n");
  assert.deepEqual(cov, { status: "reported", lines: 75, branches: 25 });
  assert.equal(summarizeLcov("garbage").status, "invalid");
});

test("readCoverageFile and readJUnitFile report not_reported for a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-art-"));
  try {
    assert.deepEqual(readCoverageFile(undefined, "cobertura"), { status: "not_reported", reason: "sin ruta de cobertura declarada" });
    assert.equal(readCoverageFile(join(dir, "nope.xml"), "cobertura").status, "not_reported");
    writeFileSync(join(dir, "bad.xml"), "<nope/>");
    assert.equal(readCoverageFile(join(dir, "bad.xml"), "cobertura").status, "invalid");
    writeFileSync(join(dir, "cov.info"), "SF:x\nLF:2\nLH:1\nend_of_record\n");
    assert.equal(readCoverageFile(join(dir, "cov.info"), "lcov").lines, 50);
    assert.equal(readJUnitFile(join(dir, "missing.xml")).reason, "JUnit no encontrado: missing.xml");
    writeFileSync(join(dir, "j.xml"), `<testsuite tests="1"><testcase name="a"/></testsuite>`);
    assert.equal(readJUnitFile(join(dir, "j.xml")).summary?.totals.passed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactEvidence removes profile values and bearer headers", () => {
  assert.equal(redactEvidence("Authorization: Bearer abc\nTOKEN=abc", ["abc"]), "Authorization: Bearer ***\nTOKEN=***");
  assert.equal(redactEvidence("authorization: basic Zm9v\ncookie: a=b\nx-api-key: k1", []), "authorization: basic ***\ncookie: ***\nx-api-key: ***");
  assert.equal(redactEvidence("nothing", [""]), "nothing");
});

test("boundOutput keeps the tail and marks truncation", () => {
  const out = boundOutput("a".repeat(100), 10);
  assert.ok(out.startsWith("[… 90 bytes omitidos …]"));
  assert.ok(out.endsWith("a".repeat(10)));
  assert.equal(boundOutput("short", 10), "short");
});

test("summarizeJUnit handles a real-size pytest report with more than 1000 XML entities", () => {
  const cases = Array.from({ length: 600 }, (_, i) => `<testcase name="t${i}" classname="m"><failure message="a &quot;b&quot; &amp; c">x</failure></testcase>`).join("");
  const result = summarizeJUnit(`<testsuite tests="600">${cases}</testsuite>`);
  assert.equal(result.totals.failed, 600);
  assert.equal(result.failures[0].message, 'a "b" & c');
});
