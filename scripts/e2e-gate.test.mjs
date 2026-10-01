// Pruebas de scripts/e2e-gate.sh: cada caso arma un origin bare + clon (sub-repo de servicio) en un
// tmp con `src/` y `e2e_dev/`, cambia rutas/tests en una rama y escribe el junit y la cobertura de
// rutas (Cobertura XML de `--route-coverage-xml`) que el gate tiene que leer. Sin red, sin DEV.
// Correr: node --test scripts/e2e-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "e2e-gate.sh");

const BASE_ROUTES = `from fastapi import APIRouter

router = APIRouter(tags=["Things"])


@router.get("/businesses/{business_id}/things")
def list_things(business_id: str):
    return []
`;

const junit = (cases) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<testsuites><testsuite name="pytest" tests="${cases.length}">\n` +
  cases
    .map(
      ({ classname, name, outcome = "passed" }) =>
        `<testcase classname="${classname}" name="${name}">` +
        (outcome === "failure" ? `<failure message="boom">boom</failure>` : "") +
        (outcome === "error" ? `<error message="boom">boom</error>` : "") +
        (outcome === "skipped" ? `<skipped message="no">no</skipped>` : "") +
        `</testcase>`,
    )
    .join("\n") +
  `\n</testsuite></testsuites>\n`;

// Formato ms-cfdis / ms-permissions: <line number=N hits=H route="METHOD /path"/>
const lineCoverage = (routes) =>
  `<?xml version="1.0" ?>\n<coverage version="e2e_dev.route_coverage" line-rate="1"><sources><source>routes</source></sources>` +
  `<packages><package name="things"><classes><class name="things" filename="routes/things"><methods /><lines>` +
  routes.map(([route, hits], i) => `<line number="${i + 1}" hits="${hits}" route="${route}" />`).join("") +
  `</lines></class></classes></package></packages></coverage>\n`;

// Formato ant-liebre-api: <method name="METHOD /path" line-rate=…><lines><line hits=…/></lines></method>
const methodCoverage = (routes) =>
  `<?xml version="1.0" ?>\n<coverage version="e2e_dev.route_coverage" line-rate="1"><sources><source>api-routes</source></sources>` +
  `<packages><package name="things"><classes><class name="things" filename="routes/things"><methods>\n` +
  routes
    .map(
      ([route, hits], i) =>
        `<method name="${route}" signature="" line-rate="${hits > 0 ? 1 : 0}"><lines><line number="${i + 1}" hits="${hits}" /></lines></method>`,
    )
    .join("\n") +
  `\n</methods></class></classes></package></packages></coverage>\n`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function fixture(t, { name = "ant-ms-fake", e2e = true } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "e2e-gate-test-"));
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
  mkdirSync(session, { recursive: true });
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(session, "clone", "-q", origin, name);

  const write = (rel, body) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
    return join(repo, rel);
  };
  write(".gitignore", "reports/\n.e2e_history/\n");
  write("src/endpoints/things.py", BASE_ROUTES);
  if (e2e) {
    write("e2e_dev/conftest.py", "# fixtures\n");
    write("e2e_dev/test_things.py", "def test_list_things():\n    assert True\n");
    write("e2e_dev/test_other.py", "def test_other():\n    assert True\n");
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "fetch", "-q", "origin");
  git(repo, "checkout", "-q", "-b", "feat/x");

  const fx = {
    tmp, repo, write,
    commit: (msg = "change") => {
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", msg);
    },
    // Agrega rutas al archivo de endpoints (texto Python crudo tras BASE_ROUTES).
    addRoutes: (extra) => write("src/endpoints/things.py", BASE_ROUTES + extra),
    touchTest: (rel = "e2e_dev/test_things.py") =>
      write(rel, "def test_list_things():\n    assert True\n\n\ndef test_new_route():\n    assert 1 == 1\n"),
    writeJunit: (rel, cases) => write(rel, junit(cases)),
    writeCoverage: (rel, routes, fmt = "line") => write(rel, (fmt === "line" ? lineCoverage : methodCoverage)(routes)),
    run: (env = {}) => {
      const r = spawnSync("bash", [GATE, session], {
        encoding: "utf8",
        env: { ...gitEnv, E2E_GATE_BASE: "origin/main", E2E_GATE_COVERAGE: "", E2E_GATE_JUNIT: "", ...env },
      });
      return { code: r.status, out: r.stdout + r.stderr };
    },
  };
  return fx;
}

const NEW_ROUTE = `

@router.post("/businesses/{business_id}/things/{thing_id}/archive")
def archive_thing(business_id: str, thing_id: str):
    return {}
`;
const NEW_FULL = "POST /api/v1/businesses/{business_id}/things/{thing_id}/archive";
const OLD_FULL = "GET /api/v1/businesses/{business_id}/things";
const THINGS_PASS = { classname: "e2e_dev.test_things", name: "test_new_route" };
const OTHER_FAIL = { classname: "e2e_dev.test_other", name: "test_known_api_defect", outcome: "failure" };

// Escenario verde base: ruta nueva + test e2e tocado + evidencia fresca con la ruta ejercitada.
function greenScenario(t, opts = {}) {
  const fx = fixture(t, opts);
  fx.addRoutes(NEW_ROUTE);
  fx.touchTest();
  fx.commit();
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [[OLD_FULL, 1], [NEW_FULL, 1]]);
  return fx;
}

test("1. sub-repo sin e2e_dev/ → se omite y PASS", (t) => {
  const fx = fixture(t, { e2e: false });
  fx.addRoutes(NEW_ROUTE);
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /· ant-ms-fake: sin suite e2e_dev — se omite/);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("2. ruta nueva sin ningún e2e_dev/test_*.py tocado → FAIL (regla A)", (t) => {
  const fx = fixture(t);
  fx.addRoutes(NEW_ROUTE);
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ ant-ms-fake: cambiaron rutas \(POST \/businesses\/\{business_id\}\/things\/\{thing_id\}\/archive\) y ningún e2e_dev\/test_\*\.py fue tocado/);
  assert.match(r.out, /E2E-GATE: FAIL/);
});

test("3. ruta nueva + test tocado + evidencia fresca con la ruta ejercitada → PASS", (t) => {
  const fx = greenScenario(t);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✅ ant-ms-fake: .*POST \/businesses\/\{business_id\}\/things\/\{thing_id\}\/archive/);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("4. la ruta aparece en la cobertura con hits=0 → FAIL (regla D)", (t) => {
  const fx = greenScenario(t);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [[OLD_FULL, 1], [NEW_FULL, 0]]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ruta POST \/businesses\/\{business_id\}\/things\/\{thing_id\}\/archive no fue ejercitada por e2e/);
  assert.match(r.out, /E2E-GATE: FAIL/);
});

test("5. la ruta no aparece en la cobertura → FAIL (regla D)", (t) => {
  const fx = greenScenario(t);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [[OLD_FULL, 1]]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ruta POST \/businesses\/\{business_id\}\/things\/\{thing_id\}\/archive no aparece en la cobertura \(¿se corrió con --route-coverage-xml\?\)/);
});

test("5b. un template de ruta que sólo coincide a medio segmento NO cuenta", (t) => {
  const fx = greenScenario(t);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [
    ["POST /api/v1/businesses/{business_id}/xthings/{thing_id}/archive", 1],
    ["POST /api/v1/xbusinesses/{business_id}/things/{thing_id}/archive", 1],
  ]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no aparece en la cobertura/);
});

test("5c. mismo path con OTRO método no cuenta", (t) => {
  const fx = greenScenario(t);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [[NEW_FULL.replace(/^POST/, "GET"), 1]]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no aparece en la cobertura/);
});

test("6. cobertura anterior al último commit → FAIL por vieja (regla B)", (t) => {
  const fx = greenScenario(t);
  const old = new Date("2000-01-01T00:00:00Z");
  utimesSync(join(fx.repo, ".e2e_history/route-coverage.xml"), old, old);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /route-coverage\.xml.*anterior al último commit/);
  assert.match(r.out, /E2E-GATE: FAIL/);
});

test("6b. junit anterior al último commit → FAIL por viejo (regla B)", (t) => {
  const fx = greenScenario(t);
  const old = new Date("2000-01-01T00:00:00Z");
  utimesSync(join(fx.repo, ".e2e_history/junit.xml"), old, old);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /junit\.xml.*anterior al último commit/);
});

test("6c. sin cobertura ni junit → FAIL (regla B, nunca verde por defecto)", (t) => {
  const fx = fixture(t);
  fx.addRoutes(NEW_ROUTE);
  fx.touchTest();
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\.e2e_history\/route-coverage\.xml: no existe/);
  assert.match(r.out, /\.e2e_history\/junit\.xml: no existe/);
});

test("6d. cobertura ilegible → FAIL (regla B)", (t) => {
  const fx = greenScenario(t);
  fx.write(".e2e_history/route-coverage.xml", "<coverage><packages");
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /route-coverage\.xml: no se pudo leer/);
});

test("7. test e2e tocado sólo con casos que fallan → FAIL (regla C)", (t) => {
  const fx = greenScenario(t);
  fx.writeJunit(".e2e_history/junit.xml", [{ ...THINGS_PASS, outcome: "failure" }, { ...THINGS_PASS, name: "t2", outcome: "skipped" }]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /❌ ant-ms-fake: e2e_dev\/test_things\.py no tiene ningún caso que pase en/);
});

test("8. rojos intencionales en OTROS archivos e2e no tumban el gate", (t) => {
  const fx = greenScenario(t);
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS, OTHER_FAIL]);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("9. formato <method name=…> de ant-liebre-api con sus rutas default en reports/", (t) => {
  const fx = fixture(t, { name: "ant-liebre-api" });
  fx.addRoutes(NEW_ROUTE);
  fx.touchTest();
  fx.commit();
  fx.writeJunit("reports/junit-e2e-dev.xml", [THINGS_PASS]);
  fx.writeCoverage("reports/route-coverage-e2e.xml", [[OLD_FULL, 1], [NEW_FULL, 1]], "method");
  let r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /E2E-GATE: PASS/);
  fx.writeCoverage("reports/route-coverage-e2e.xml", [[OLD_FULL, 1], [NEW_FULL, 0]], "method");
  r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no fue ejercitada por e2e/);
});

test("10. decorador multilínea con el path en la línea siguiente", (t) => {
  const fx = fixture(t);
  fx.addRoutes(`

@router.patch(
    "/businesses/{business_id}/things/{thing_id}",
    response_model=dict,
    summary="Patch a thing",
)
def patch_thing(business_id: str, thing_id: str):
    return {}
`);
  fx.touchTest();
  fx.commit();
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [[OLD_FULL, 1], ["PATCH /api/v1/businesses/{business_id}/things/{thing_id}", 0]]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ruta PATCH \/businesses\/\{business_id\}\/things\/\{thing_id\} no fue ejercitada por e2e/);
});

test("10b. cambiar sólo el path de un decorador multilínea existente cuenta como ruta cambiada", (t) => {
  const fx = fixture(t);
  fx.addRoutes(`

@router.delete(
    "/businesses/{business_id}/things/{thing_id}",
)
def delete_thing(business_id: str, thing_id: str):
    return {}
`);
  fx.commit("base delete");
  // se mueve a main para que la base ya la tenga
  sh("git", ["push", "-q", "origin", "HEAD:main"], { cwd: fx.repo });
  sh("git", ["fetch", "-q", "origin"], { cwd: fx.repo });
  fx.addRoutes(`

@router.delete(
    "/businesses/{business_id}/things/{thing_id}/hard",
)
def delete_thing(business_id: str, thing_id: str):
    return {}
`);
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cambiaron rutas \(DELETE \/businesses\/\{business_id\}\/things\/\{thing_id\}\/hard\)/);
});

test("11. ruta excusada en e2e_dev/.e2e-gate-skip → ⚠ con el motivo y no falla", (t) => {
  const fx = fixture(t);
  fx.addRoutes(NEW_ROUTE);
  fx.write("e2e_dev/.e2e-gate-skip", "# rutas excusadas\nPOST /businesses/{business_id}/things/{thing_id}/archive  # sólo admin interno\n");
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /⚠ .*POST \/businesses\/\{business_id\}\/things\/\{thing_id\}\/archive.*sólo admin interno/);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("12. ruta borrada no cuenta como cambiada", (t) => {
  const fx = fixture(t);
  fx.write("src/endpoints/things.py", "from fastapi import APIRouter\n\nrouter = APIRouter()\n");
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("13. E2E_GATE_COVERAGE / E2E_GATE_JUNIT con listas «:» (la ruta la cubre el segundo XML)", (t) => {
  const fx = greenScenario(t);
  fx.writeCoverage("reports/a.xml", [[OLD_FULL, 1]]);
  fx.writeCoverage("reports/b.xml", [[NEW_FULL, 1]], "method");
  fx.writeJunit("reports/j1.xml", [OTHER_FAIL]);
  fx.writeJunit("reports/j2.xml", [THINGS_PASS]);
  const r = fx.run({ E2E_GATE_COVERAGE: "reports/a.xml:reports/b.xml", E2E_GATE_JUNIT: "reports/j1.xml:reports/j2.xml" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("14. sólo se tocó un test e2e (sin rutas) → igual exige evidencia y que pase", (t) => {
  const fx = fixture(t);
  fx.touchTest();
  fx.commit();
  let r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no existe/);
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [[OLD_FULL, 1]]);
  r = fx.run();
  assert.equal(r.code, 0, r.out);
});

test("15. cambios sin rutas ni e2e tocado (sólo src no-ruta) → PASS sin pedir evidencia", (t) => {
  const fx = fixture(t);
  fx.write("src/service.py", "def f():\n    return 2\n");
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /E2E-GATE: PASS/);
});

test("16. cambios sin commitear (working tree) también cuentan", (t) => {
  const fx = fixture(t);
  fx.addRoutes(NEW_ROUTE); // sin commit
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cambiaron rutas/);
});

test("17. prefijo del APIRouter del mismo archivo se antepone al path del decorador", (t) => {
  const fx = fixture(t);
  fx.write(
    "src/endpoints/widgets.py",
    `from fastapi import APIRouter\n\nrouter = APIRouter(prefix="/businesses/{business_id}/widgets", tags=["W"])\n\n\n@router.get("")\ndef list_widgets(business_id: str):\n    return []\n`,
  );
  fx.touchTest();
  fx.commit();
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [["GET /api/v1/businesses/{business_id}/widgets", 1]]);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /GET \/businesses\/\{business_id\}\/widgets/);
});

test("17b. path vacío sin prefijo resoluble → FAIL explicando por qué (default-deny)", (t) => {
  const fx = fixture(t);
  fx.write("src/endpoints/widgets.py", `from fastapi import APIRouter\n\nrouter = APIRouter()\n\n\n@router.get("")\ndef list_widgets():\n    return []\n`);
  fx.touchTest();
  fx.commit();
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [["GET /api/v1/widgets", 1]]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /path vacío/);
});

test("18. sin merge-base con la base → FAIL", (t) => {
  const fx = greenScenario(t);
  const r = fx.run({ E2E_GATE_BASE: "origin/no-existe" });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /sin merge-base/);
});

test("11b. línea del skip SIN motivo no excusa y es FAIL", (t) => {
  const fx = fixture(t);
  fx.addRoutes(NEW_ROUTE);
  fx.write("e2e_dev/.e2e-gate-skip", "POST /businesses/{business_id}/things/{thing_id}/archive\n");
  fx.commit();
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /se espera «METHOD \/path  # motivo»/);
  assert.match(r.out, /cambiaron rutas/);
});

test("16b. archivo de rutas NUEVO sin rastrear (untracked) también cuenta", (t) => {
  const fx = fixture(t);
  fx.write("src/endpoints/gadgets.py", `from fastapi import APIRouter\n\nrouter = APIRouter()\n\n\n@router.get("/gadgets")\ndef g():\n    return []\n`);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cambiaron rutas \(GET \/gadgets\)/);
});

const EMPTY_PATH_FILE = `from fastapi import APIRouter\n\nfrom .routing import PREFIX\n\nrouter = APIRouter(prefix=PREFIX)\n\n\n@router.get(\n    "",\n)\ndef list_widgets(business_id: str):\n    return []\n`;

test("17c. path vacío resuelto en e2e_dev/.e2e-gate-routes y ejercitado → PASS", (t) => {
  const fx = fixture(t);
  fx.write("src/endpoints/widgets.py", EMPTY_PATH_FILE);
  fx.write("e2e_dev/.e2e-gate-routes", "# prefijo dinámico (routing.py)\nGET src/endpoints/widgets.py /businesses/{business_id}/widgets\n");
  fx.touchTest();
  fx.commit();
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [["GET /api/v1/businesses/{business_id}/widgets", 1]]);
  const r = fx.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ruta GET \/businesses\/\{business_id\}\/widgets ejercitada por e2e/);
});

test("17d. path vacío resuelto vía .e2e-gate-routes pero con 0 hits → FAIL (resolver no es excusar)", (t) => {
  const fx = fixture(t);
  fx.write("src/endpoints/widgets.py", EMPTY_PATH_FILE);
  fx.write("e2e_dev/.e2e-gate-routes", "GET src/endpoints/widgets.py /businesses/{business_id}/widgets\n");
  fx.touchTest();
  fx.commit();
  fx.writeJunit(".e2e_history/junit.xml", [THINGS_PASS]);
  fx.writeCoverage(".e2e_history/route-coverage.xml", [["GET /api/v1/businesses/{business_id}/widgets", 0]]);
  const r = fx.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ruta GET \/businesses\/\{business_id\}\/widgets no fue ejercitada por e2e/);
});
