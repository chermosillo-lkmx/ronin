import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { APP_CSP, APP_ORIGIN, APP_HOST, APP_SCHEME, resolveAppRequest } from "./app-protocol.js";

const distDir = "/tmp/ronin-web-dist";
const exists = (path: string) => path === join(distDir, "index.html") || path === join(distDir, "assets/app.js");
const options = { distDir, exists };

test("resolveAppRequest separates validated assets, API, and recovery", () => {
  assert.equal(APP_SCHEME, "app");
  assert.equal(APP_HOST, "ronin");
  assert.equal(APP_ORIGIN, "app://ronin");
  assert.equal(resolveAppRequest("app://ronin/", "GET", options).kind, "asset");
  assert.deepEqual(resolveAppRequest("app://ronin/api/health?fresh=1", "POST", options), {
    kind: "api", path: "/api/health?fresh=1", csp: APP_CSP,
  });
  assert.deepEqual(resolveAppRequest("app://ronin/recovery", "GET", options), { kind: "recovery", action: "view", csp: APP_CSP });
  assert.deepEqual(resolveAppRequest("app://ronin/recovery/retry", "GET", options), { kind: "recovery", action: "retry", csp: APP_CSP });
  assert.deepEqual(resolveAppRequest("app://ronin/recovery/close", "GET", options), { kind: "recovery", action: "close", csp: APP_CSP });
});

test("resolveAppRequest (T9, bug real): un %N doblemente codificado en el path llega al backend con la MISMA codificación que mandó el cliente — un solo decode, el de Express, no dos", () => {
  // Bug real, encontrado en vivo con el E2E de T9: `route.path` salía ya decodificado UNA vez
  // por resolveAppRequest, y bootstrap.ts lo reenvía tal cual al backend por HTTP — Express
  // decodifica OTRA vez y "%1" (ya de por sí un escape incompleto) revienta con URIError. El
  // cliente manda `encodeURIComponent("%1")` = "%251" (la codificación correcta para que
  // Express, decodificando UNA vez, recupere "%1") — resolveAppRequest NO debe tocar esa
  // codificación antes de reenviar.
  const route = resolveAppRequest("app://ronin/api/sessions/x/panes/%251/capture", "GET", options);
  assert.deepEqual(route, { kind: "api", path: "/api/sessions/x/panes/%251/capture", csp: APP_CSP });
});

test("resolveAppRequest rejects unsafe hosts, asset methods, traversals, and missing files", () => {
  for (const url of [
    "app://evil/",
    "app://ronin.evil/",
    "file:///tmp/index.html",
    "app://ronin/../secret",
    "app://ronin/%2e%2e/secret",
    "app://ronin//etc/passwd",
  ]) {
    assert.equal(resolveAppRequest(url, "GET", options).kind, "bad-request");
  }
  assert.equal(resolveAppRequest("app://ronin/assets/app.js", "POST", options).kind, "bad-request");
  assert.equal(resolveAppRequest("app://ronin/assets/missing.js", "GET", options).kind, "not-found");
});
