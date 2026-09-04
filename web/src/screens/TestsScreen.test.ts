import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TestsScreen, type TestsScreenData } from "./TestsScreen.js";
import type { TestMatrixRow, TestRun } from "../types.js";

const cells = (unit: TestMatrixRow["cells"]["unit"]): TestMatrixRow["cells"] => ({
  unit,
  e2e: { suite: "e2e", state: "unconfigured" },
  api: { suite: "api", state: "unconfigured" },
  browser: { suite: "browser", state: "unconfigured" },
});

const RUN: TestRun = {
  runId: "run-1", repo: "api", suite: "unit", profile: "dev", status: "failed", createdAt: "2026-08-24T10:00:00.000Z",
  startedAt: "2026-08-24T10:00:00.000Z", finishedAt: "2026-08-24T10:00:05.000Z", exitCode: 1,
  totals: { total: 10, passed: 8, failed: 2, skipped: 0, errors: 0 },
  coverage: { status: "reported", lines: 54.3 },
  failures: [{ name: "test_bad", classname: "tests.mod", message: "boom" }],
  stdout: "TOKEN=***",
};

const FIXTURE: TestsScreenData = {
  matrix: [
    { repo: "api", configured: true, profiles: ["dev"], cells: cells({ suite: "unit", state: "failed", runId: "run-1", totals: RUN.totals, coverage: RUN.coverage }) },
    { repo: "ms-i18n", configured: true, profiles: ["dev"], cells: cells({ suite: "unit", state: "passed", runId: "run-2", totals: { total: 3, passed: 3, failed: 0, skipped: 0, errors: 0 }, coverage: { status: "not_reported", reason: "sin ruta de cobertura declarada" } }) },
    { repo: "nuevo", configured: false, profiles: [], cells: cells({ suite: "unit", state: "unconfigured" }) },
    { repo: "qa-only", configured: true, profiles: ["qa"], cells: cells({ suite: "unit", state: "blocked", reason: "perfil \"dev\" no configurado en qa-only" }) },
  ],
  config: [
    { repo: "api", configured: true, profiles: [{ name: "dev", variables: ["TOKEN"], allowedOrigins: [], allowMutations: false }], suites: { unit: { command: { program: "pytest", args: ["-q"] }, timeoutMs: 600000, junitPath: "junit.xml" } } },
  ],
  runs: [RUN],
};

test("TestsScreen differentiates all four suites and renders every repo from the matrix", () => {
  const html = renderToString(createElement(TestsScreen, { initial: FIXTURE }));
  assert.match(html, /Unit/);
  assert.match(html, /E2E/);
  assert.match(html, /API\/OpenAPI/);
  assert.match(html, /Browser/);
  for (const repo of ["api", "ms-i18n", "nuevo", "qa-only"]) assert.match(html, new RegExp(repo));
});

test("TestsScreen renders an activity heatmap for every repository, including empty repositories", () => {
  const html = renderToString(createElement(TestsScreen, { initial: FIXTURE }));

  assert.match(html, /Actividad por repositorio/);
  assert.ok((html.match(/class="ron-tests-heat-row"/g) ?? []).length === FIXTURE.matrix.length);
  for (const repo of FIXTURE.matrix.map((row) => row.repo)) assert.match(html, new RegExp(`data-repo="${repo}"`));
  const emptyRow = html.match(/<div class="ron-tests-heat-row" data-repo="nuevo" data-empty-cells="90">([\s\S]*?)<\/div>/)?.[1];
  assert.equal((emptyRow?.match(/class="ron-tests-heat-cell none"/g) ?? []).length, 90);
  assert.ok(html.indexOf("Actividad por repositorio") < html.indexOf("<th>Repo<\/th>"));
});

test("TestsScreen renders coverage as no reportada rather than zero and shows a real percentage when reported", () => {
  const html = renderToString(createElement(TestsScreen, { initial: FIXTURE }));
  assert.match(html, /no reportada/);
  assert.match(html, /54\.3%/);
  assert.doesNotMatch(html, /\b0%/);
});

test("TestsScreen distinguishes unconfigured, blocked and failed cells", () => {
  const html = renderToString(createElement(TestsScreen, { initial: FIXTURE }));
  assert.match(html, /sin configurar/);
  assert.match(html, /perfil &quot;dev&quot; no configurado en qa-only/);
  assert.match(html, /8\/10/);
});

test("TestsScreen offers the configuration form for an unconfigured repo and never renders variable values", () => {
  const html = renderToString(createElement(TestsScreen, { initial: FIXTURE, selectedRepo: "nuevo" }));
  assert.match(html, /Configurar pruebas/);
  assert.match(html, /Guardar configuración/);
  assert.doesNotMatch(html, /actual-secret/);
});

test("TestsScreen run detail lists failures and redacted output without the token", () => {
  const html = renderToString(createElement(TestsScreen, { initial: FIXTURE, selectedRunId: "run-1" }));
  assert.match(html, /test_bad/);
  assert.match(html, /boom/);
  assert.match(html, /TOKEN=\*\*\*/);
  assert.match(html, /Reintentar/);
});
