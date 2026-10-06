import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CAPABILITY_FILE, ensureCapabilityToken, readCapabilityToken } from "./capability.js";
import { VERIFY_GATE } from "./config.js";
import { createApp, runConfiguredClaude, startServer } from "./index.js";
import { createSession } from "./tmux.js";
import { cycleDirForSession } from "./stages.js";
import { adoptSession, releaseAdoption } from "./engine.js";
import { createLearnedSkillStore } from "./learned-skills.js";
import { createMemoryStore } from "./memory.js";
import type { Distiller } from "./memory-distiller.js";

const pexec = promisify(execFile);

function envWithoutTmux(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

/** Mismo patrón que engine.test.ts/tmux.test.ts (T0.8/M5): socket propio y desechable. */
async function withIsolatedSocket(fn: (socket: string) => Promise<void>): Promise<void> {
  const socket = `ronin-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const previousSocket = process.env.COWORK_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.COWORK_TMUX_SOCKET = socket;
  delete process.env.TMUX;
  try {
    await fn(socket);
  } finally {
    process.env.COWORK_TMUX_SOCKET = previousSocket;
    if (previousTmux !== undefined) process.env.TMUX = previousTmux;
    await pexec("tmux", ["-L", socket, "kill-server"], { env: envWithoutTmux() }).catch(() => {});
  }
}

async function liveSessionCreatedAt(socket: string, session: string): Promise<number> {
  const { stdout } = await pexec("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name} #{session_created}"], { env: envWithoutTmux() });
  const line = stdout.trim().split("\n").find((l) => l.startsWith(`${session} `))!;
  return Number(line.split(" ")[1]) * 1000;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function listenOnLoopback(app: ReturnType<typeof createApp>, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function getStatus(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const requestHandle = request({ host: "127.0.0.1", port, path: "/api/health" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    requestHandle.once("error", reject);
    requestHandle.end();
  });
}

function invokeGet(app: ReturnType<typeof createApp>, path: string, requestHeaders: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers = new Map<string, string | number | readonly string[]>();
    const req = { method: "GET", url: path, originalUrl: path, headers: requestHeaders, socket: {}, get(name: string) { return requestHeaders[name.toLowerCase()]; } };
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) { headers.set(name.toLowerCase(), value); },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      getHeaders() { return Object.fromEntries(headers); },
      end(body?: string) {
        try {
          resolve({ status: this.statusCode, body: body ? JSON.parse(body) : undefined });
        } catch (error) {
          reject(error);
        }
      },
    };
    app.handle(req as any, res as any, reject);
  });
}

/**
 * Igual que invokeGet, para cualquier método. Sin content-length en `headers`, express.json()
 * detecta "sin cuerpo" y llama a next() sin tocar el stream (body-parser real, verificado) —
 * así que un `body` pre-puesto en el req sobrevive intacto hasta el handler de la ruta, sin
 * necesitar que el fake req implemente un stream legible de verdad.
 */
function invokeRequest(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const requestHeaders = options.headers ?? {};
    const responseHeaders = new Map<string, string | number | readonly string[]>();
    const req: any = {
      method,
      url: path,
      originalUrl: path,
      headers: requestHeaders,
      socket: {},
      get(name: string) { return requestHeaders[name.toLowerCase()]; },
    };
    if (options.body !== undefined) req.body = options.body;
    const res: any = {
      statusCode: 200,
      setHeader(name: string, value: string | number | readonly string[]) { responseHeaders.set(name.toLowerCase(), value); },
      getHeader(name: string) { return responseHeaders.get(name.toLowerCase()); },
      getHeaders() { return Object.fromEntries(responseHeaders); },
      end(body?: string) {
        try {
          resolve({ status: this.statusCode, body: body ? JSON.parse(body) : undefined });
        } catch (error) {
          reject(error);
        }
      },
    };
    app.handle(req, res, reject);
  });
}

test("startServer does not listen until background setup is ready", async () => {
  const events: string[] = [];
  const server = {
    address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43210 }),
    close: (callback: (error?: Error) => void) => { events.push("socket"); callback(); },
  };
  const starting = startServer({
    port: 43210,
    deps: {
      startBackground: async () => () => { events.push("background"); },
      listen: async () => { events.push("listen"); return server as any; },
    },
  });

  const handle = await starting;
  assert.deepEqual(events, ["listen"]);

  const health = await invokeGet(handle.app, "/api/health");
  assert.deepEqual(health, { status: 200, body: { version: 1, ok: true, service: "ronin-api", tokenOk: false, verifyGate: VERIFY_GATE } });
  assert.equal(JSON.stringify(health.body).includes("token-value"), false);

  await handle.close();
  await handle.close();
  assert.deepEqual(events, ["listen", "socket", "background"]);
});

test("/api/health never publishes the boot token, only whether the caller presented it", async () => {
  const previous = process.env.COWORK_DESKTOP_BOOT_TOKEN;
  process.env.COWORK_DESKTOP_BOOT_TOKEN = "token-value";
  try {
    const app = createApp();
    const withoutHeader = await invokeGet(app, "/api/health");
    assert.deepEqual(withoutHeader, { status: 200, body: { version: 1, ok: true, service: "ronin-api", tokenOk: false, verifyGate: VERIFY_GATE } });
    assert.equal(JSON.stringify(withoutHeader.body).includes("token-value"), false);

    const withWrongHeader = await invokeGet(app, "/api/health", { "x-ronin-boot-token": "wrong" });
    assert.deepEqual(withWrongHeader.body, { version: 1, ok: true, service: "ronin-api", tokenOk: false, verifyGate: VERIFY_GATE });

    const withCorrectHeader = await invokeGet(app, "/api/health", { "x-ronin-boot-token": "token-value" });
    assert.deepEqual(withCorrectHeader, { status: 200, body: { version: 1, ok: true, service: "ronin-api", tokenOk: true, verifyGate: VERIFY_GATE } });
  } finally {
    if (previous === undefined) delete process.env.COWORK_DESKTOP_BOOT_TOKEN;
    else process.env.COWORK_DESKTOP_BOOT_TOKEN = previous;
  }
});

test("/api/health expone el gate real y permite inyectar ambas ramas", async () => {
  const enabled = await invokeGet(createApp({ verifyGate: true }), "/api/health");
  const disabled = await invokeGet(createApp({ verifyGate: false }), "/api/health");
  const defaulted = await invokeGet(createApp(), "/api/health");

  assert.equal(enabled.body.verifyGate, true);
  assert.equal(disabled.body.verifyGate, false);
  assert.equal(defaulted.body.verifyGate, VERIFY_GATE);
});

test("startServer generates the capability token exactly once, before listening", async () => {
  const events: string[] = [];
  const server = {
    address: () => ({ address: "127.0.0.1", family: "IPv4", port: 43211 }),
    close: (callback: (error?: Error) => void) => callback(),
  };
  const starting = startServer({
    port: 43211,
    deps: {
      startBackground: async () => () => {},
      ensureCapability: () => { events.push("capability"); return "fixture-token"; },
      listen: async () => { events.push("listen"); return server as any; },
    },
  });

  const handle = await starting;
  assert.deepEqual(events, ["capability", "listen"]);
  await handle.close();
});

test("startServer keeps the real loopback socket closed until background setup is ready and cleans it on startup failures", async () => {
  const port = await freeLoopbackPort();
  const backgroundReady = deferred<() => void>();
  const events: string[] = [];
  const starting = startServer({
    port,
    deps: {
      startBackground: () => backgroundReady.promise,
      listen: listenOnLoopback,
    },
  });

  await Promise.resolve();
  await assert.rejects(getStatus(port));
  backgroundReady.resolve(() => { events.push("background"); });
  const handle = await starting;
  assert.equal(await getStatus(port), 200);
  await handle.close();
  assert.deepEqual(events, ["background"]);
  await assert.rejects(getStatus(port));

  const failureCases = [
    {
      name: "background",
      startBackground: async () => { throw new Error("background failed"); },
      expected: ["background"],
    },
  ] as const;

  for (const failure of failureCases) {
    const failureEvents: string[] = [];
    await assert.rejects(
      startServer({
        port: await freeLoopbackPort(),
        deps: {
          startBackground: async () => {
            failureEvents.push("background");
            return failure.startBackground();
          },
          listen: async (app, failurePort) => {
            failureEvents.push("listen");
            return listenOnLoopback(app, failurePort);
          },
        },
      }),
      new RegExp(`${failure.name} failed`),
    );
    assert.deepEqual(failureEvents, failure.expected, failure.name);
  }
});

test("startServer does not expose an engine dependency when a background producer fails", async () => {
  await assert.rejects(
    startServer({
      deps: {
        startBackground: async () => { throw new Error("background failed"); },
        listen: async () => { throw new Error("must not listen"); },
      },
    }),
    /background failed/,
  );
});

// ---- T4: requireCapability montada por MÉTODO sobre todo /api mutante ----

test("requireCapability: GET/HEAD/OPTIONS nunca exigen cabecera — /api/sessions, /api/workflow siguen respondiendo", async () => {
  const app = createApp();
  for (const path of ["/api/sessions", "/api/workflow", "/api/preflight"]) {
    const response = await invokeGet(app, path);
    assert.notEqual(response.status, 401, path);
    assert.notEqual(response.status, 503, path);
  }
});

test("requireCapability: cualquier mutación de /api sin la cabecera correcta → 401, sin efecto — probado por MÉTODO (PUT/POST/DELETE), no por lista de rutas", async () => {
  ensureCapabilityToken();
  const app = createApp();
  const cases: Array<[string, string]> = [
    ["PUT", "/api/workflow"],
    ["PUT", "/api/repo-config/monorepo"],
    ["DELETE", "/api/sessions/x"],
    ["DELETE", "/api/sessions/x/adopt"],
  ];
  for (const [method, path] of cases) {
    const response = await invokeRequest(app, method, path, { headers: { "x-ronin-capability": "wrong" } });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal((response.body as any).code, "CAPABILITY_REQUIRED", `${method} ${path}`);
  }
});

test("requireCapability: con la cabecera correcta, la petición LLEGA al handler de la ruta (deja de ser 401)", async () => {
  const token = ensureCapabilityToken();
  const app = createApp();
  const response = await invokeRequest(app, "PUT", "/api/repo-config/monorepo", {
    headers: { "x-ronin-capability": token },
    body: {},
  });
  assert.notEqual(response.status, 401);
});

test("GET /api/repos/:repo/kb y POST /api/repos/:repo/kb/zip exigen capability y describen la KB", async () => {
  const token = ensureCapabilityToken();
  const root = mkdtempSync(join(tmpdir(), "ronin-api-kb-"));
  const out = mkdtempSync(join(tmpdir(), "ronin-api-kb-out-"));
  try {
    mkdirSync(join(root, "kb"));
    writeFileSync(join(root, "kb", "nota.md"), "contexto");
    const app = createApp({ kb: {
      listRepos: () => ["api"],
      resolveCwd: () => ({ cwd: root, real: true }),
      readRepoConfigFull: () => ({ kbPath: "" }),
      downloadsDirectory: () => out,
      temporaryDirectory: () => out,
      now: () => new Date("2026-09-07T12:00:00Z"),
    } });
    const deniedGet = await invokeRequest(app, "GET", "/api/repos/api/kb");
    assert.equal(deniedGet.status, 401);
    const described = await invokeRequest(app, "GET", "/api/repos/api/kb", { headers: { "x-ronin-capability": token } });
    assert.equal(described.status, 200);
    assert.equal((described.body as any).exists, true);
    assert.equal((described.body as any).relativePath, "kb");
    const deniedZip = await invokeRequest(app, "POST", "/api/repos/api/kb/zip");
    assert.equal(deniedZip.status, 401);
    const zipped = await invokeRequest(app, "POST", "/api/repos/api/kb/zip", { headers: { "x-ronin-capability": token } });
    assert.equal(zipped.status, 200);
    assert.equal(existsSync((zipped.body as any).file), true);
    assert.ok((zipped.body as any).bytes > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("POST /api/repos/:repo/kb/zip devuelve 404 legible cuando el repo no tiene KB", async () => {
  const token = ensureCapabilityToken();
  const root = mkdtempSync(join(tmpdir(), "ronin-api-kb-vacia-"));
  try {
    const app = createApp({ kb: {
      listRepos: () => ["vacia"],
      resolveCwd: () => ({ cwd: root, real: true }),
      readRepoConfigFull: () => ({ kbPath: "" }),
    } });
    const response = await invokeRequest(app, "POST", "/api/repos/vacia/kb/zip", { headers: { "x-ronin-capability": token } });
    assert.equal(response.status, 404);
    assert.match((response.body as any).error, /no tiene una base de conocimiento/i);
    assert.equal((response.body as any).code, "KB_NOT_FOUND");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/repos/:repo/kb/generate inicia en segundo plano y rechaza duplicados en curso", async () => {
  const token = ensureCapabilityToken();
  const root = mkdtempSync(join(tmpdir(), "ronin-api-kb-generate-"));
  const pending = deferred<void>();
  let state: any = null;
  try {
    const app = createApp({ kb: {
      listRepos: () => ["api"],
      resolveCwd: () => ({ cwd: root, real: true }),
      readRepoConfigFull: () => ({ kbPath: "" }),
      readGenerationState: () => state,
      generateKb: async () => {
        state = { status: "running", startedAt: 100 };
        await pending.promise;
        state = { status: "ok", startedAt: 100, finishedAt: 101, output: "listo" };
        return state;
      },
    } });
    const headers = { "x-ronin-capability": token };
    const started = await invokeRequest(app, "POST", "/api/repos/api/kb/generate", { headers });
    assert.deepEqual(started, { status: 202, body: { status: "running", startedAt: 100 } });
    const current = await invokeRequest(app, "GET", "/api/repos/api/kb/generation", { headers });
    assert.deepEqual(current, { status: 200, body: { status: "running", startedAt: 100 } });
    const duplicate = await invokeRequest(app, "POST", "/api/repos/api/kb/generate", { headers });
    assert.equal(duplicate.status, 409);
    pending.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function memoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "ronin-api-memory-"));
  let seq = 0;
  const store = createMemoryStore({ directory, listRepos: () => ["acme-api"], now: () => 1_790_000_000_000, newId: (prefix) => `${prefix}_${++seq}` });
  return { store, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function fakeDistiller(overrides: Partial<Distiller> = {}): Distiller {
  return {
    request: () => "queued",
    scan: () => [],
    stateOf: () => ({ status: "running", repo: "acme-api", at: 1 }),
    requestSkill: () => "queued",
    skillStateOf: () => ({ status: "running", at: 1 }),
    idle: async () => {},
    ...overrides,
  };
}

test("rutas de memoria: capability, repo desconocido, vista, alta manual, validación y enabled", async () => {
  const token = ensureCapabilityToken();
  const { store, cleanup } = memoryFixture();
  try {
    const app = createApp({ memory: { store, distiller: fakeDistiller(), globalEnabled: true } });
    const headers = { "x-ronin-capability": token };
    assert.equal((await invokeRequest(app, "GET", "/api/repos/acme-api/memory")).status, 401);

    const unknown = await invokeRequest(app, "GET", "/api/repos/acme-otro/memory", { headers });
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as any).code, "REPO_UNKNOWN");
    assert.equal(typeof (unknown.body as any).error, "string");

    const empty = await invokeRequest(app, "GET", "/api/repos/acme-api/memory", { headers });
    assert.deepEqual(empty, {
      status: 200,
      body: { repo: "acme-api", enabled: true, globalEnabled: true, entries: [], kbSuggestions: [], preview: { text: "", bytes: 0, maxBytes: 2048, omitted: 0 } },
    });

    const added = await invokeRequest(app, "POST", "/api/repos/acme-api/memory", { headers, body: { text: "Tests: usar make test-unit", kind: "comando" } });
    assert.equal(added.status, 200);
    assert.equal((added.body as any).entries[0].status, "active");
    assert.match((added.body as any).preview.text, /- \[comando\] Tests: usar make test-unit/);
    assert.equal((added.body as any).preview.bytes, Buffer.byteLength((added.body as any).preview.text, "utf8"));

    for (const body of [{ text: "", kind: "comando" }, { text: "x".repeat(201), kind: "comando" }, { text: "ok", kind: "chisme" }, undefined]) {
      const bad = await invokeRequest(app, "POST", "/api/repos/acme-api/memory", { headers, body });
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal((bad.body as any).code, "MEMORY_INVALID");
    }

    const off = await invokeRequest(app, "PUT", "/api/repos/acme-api/memory/enabled", { headers, body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal((off.body as any).enabled, false);
    const badToggle = await invokeRequest(app, "PUT", "/api/repos/acme-api/memory/enabled", { headers, body: { enabled: "no" } });
    assert.equal(badToggle.status, 400);
    assert.equal((badToggle.body as any).code, "MEMORY_INVALID");
    assert.equal((await invokeRequest(app, "PUT", "/api/repos/acme-otro/memory/enabled", { headers, body: { enabled: true } })).status, 404);
  } finally {
    cleanup();
  }
});

test("PATCH y DELETE de memoria: aprobar, editar, arquitectura a la KB, descartar, borrar; 400, 404 y 409", async () => {
  const token = ensureCapabilityToken();
  const { store, cleanup } = memoryFixture();
  try {
    const [a, b, c] = store.propose("acme-api", [
      { text: "Pendiente A", kind: "trampa" },
      { text: "Pendiente B", kind: "comando" },
      { text: "Pendiente C", kind: "arquitectura" },
    ], "cowork-x");
    const app = createApp({ memory: { store, distiller: fakeDistiller(), globalEnabled: true } });
    const headers = { "x-ronin-capability": token };
    const patch = (id: string, body: unknown) => invokeRequest(app, "PATCH", `/api/repos/acme-api/memory/${id}`, { headers, body });

    assert.equal((await patch(a.id, { action: "approve" })).status, 200);
    const edited = await patch(b.id, { action: "edit", text: "Pendiente B editada" });
    assert.equal(edited.status, 200);
    assert.deepEqual((edited.body as any).entries.map((e: any) => [e.text, e.status]), [["Pendiente A", "active"], ["Pendiente B editada", "active"], ["Pendiente C", "pending"]]);

    const toKb = await patch(c.id, { action: "approve" });
    assert.deepEqual((toKb.body as any).kbSuggestions.map((s: any) => s.text), ["Pendiente C"]);

    const again = await patch(a.id, { action: "approve" });
    assert.equal(again.status, 409);
    assert.equal((again.body as any).code, "MEMORY_INVALID");

    const discarded = await patch(a.id, { action: "discard" });
    assert.equal(discarded.status, 200);
    assert.deepEqual((discarded.body as any).entries.map((e: any) => e.text), ["Pendiente B editada"]);

    const missing = await patch("m_nope", { action: "approve" });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as any).code, "MEMORY_NOT_FOUND");
    assert.equal((await patch(b.id, { action: "borrar" })).status, 400);
    assert.equal((await patch(b.id, { action: "edit", text: "" })).status, 400);

    const kbId = (toKb.body as any).kbSuggestions[0].id;
    assert.equal((await invokeRequest(app, "DELETE", `/api/repos/acme-api/memory/${kbId}`)).status, 401);
    const removed = await invokeRequest(app, "DELETE", `/api/repos/acme-api/memory/${kbId}`, { headers });
    assert.equal(removed.status, 200);
    assert.deepEqual((removed.body as any).kbSuggestions, []);
    const gone = await invokeRequest(app, "DELETE", `/api/repos/acme-api/memory/${kbId}`, { headers });
    assert.equal(gone.status, 404);
    assert.equal((gone.body as any).code, "MEMORY_NOT_FOUND");
  } finally {
    cleanup();
  }
});

test("POST /api/sessions/:name/distill: 202 en cola, 409 en curso, 404 sin ciclo y 400 con nombre inválido", async () => {
  const token = ensureCapabilityToken();
  const requested: string[] = [];
  const distiller = fakeDistiller({
    request: (name, trigger) => {
      requested.push(`${name}:${trigger}`);
      return name === "cowork-ocupada" ? "busy" : name === "cowork-nada" ? "unknown" : "queued";
    },
  });
  const app = createApp({ memory: { distiller } });
  const headers = { "x-ronin-capability": token };
  assert.equal((await invokeRequest(app, "POST", "/api/sessions/cowork-csv/distill")).status, 401);
  assert.deepEqual(await invokeRequest(app, "POST", "/api/sessions/cowork-csv/distill", { headers }), { status: 202, body: { status: "running", repo: "acme-api", at: 1 } });
  const busy = await invokeRequest(app, "POST", "/api/sessions/cowork-ocupada/distill", { headers });
  assert.equal(busy.status, 409);
  assert.equal((busy.body as any).code, "DISTILL_RUNNING");
  const missing = await invokeRequest(app, "POST", "/api/sessions/cowork-nada/distill", { headers });
  assert.equal(missing.status, 404);
  assert.equal((missing.body as any).code, "SESSION_NOT_FOUND");
  const invalid = await invokeRequest(app, "POST", "/api/sessions/mal%20nombre/distill", { headers });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as any).code, "INVALID_SESSION");
  assert.deepEqual(requested, ["cowork-csv:manual", "cowork-ocupada:manual", "cowork-nada:manual"]);
});

test("GET /api/sessions añade memory (repo, pendientes y destilación) sólo a gestionadas con repo conocido", async () => {
  const { store, cleanup } = memoryFixture();
  try {
    store.propose("acme-api", [{ text: "Pendiente", kind: "trampa" }, { text: "Otra", kind: "comando" }], "cowork-memoria-a");
    const base = { windows: 1, panes: [], createdAt: 0, attached: false, adopted: false };
    const app = createApp({
      readTmuxInventory: async () => ({
        sessions: [
          { ...base, name: "cowork-memoria-a", kind: "managed" as const },
          { ...base, name: "cowork-memoria-sin-repo", kind: "managed" as const },
          { ...base, name: "memoria-ajena", kind: "foreign" as const },
        ],
        diagnostic: null,
      }),
      memory: {
        store,
        distiller: fakeDistiller({ stateOf: () => ({ status: "done", repo: "acme-api", at: 5, proposed: 2 }) }),
        repoOf: (name) => (name === "cowork-memoria-sin-repo" ? null : "acme-api"),
      },
    });
    const response = await invokeRequest(app, "GET", "/api/sessions");
    assert.equal(response.status, 200);
    const sessions = (response.body as any).sessions;
    assert.deepEqual(sessions[0].memory, { repo: "acme-api", pending: 2, distill: { status: "done", repo: "acme-api", at: 5, proposed: 2 } });
    assert.equal("memory" in sessions[1], false);
    assert.equal("memory" in sessions[2], false);
  } finally {
    cleanup();
  }
});

test("requireCapability: si el token aún no existe en disco, una mutación responde 503 CAPABILITY_UNAVAILABLE — fail-closed, nunca 200", async () => {
  const backup = existsSync(CAPABILITY_FILE) ? `${CAPABILITY_FILE}.backup-test` : null;
  if (backup) renameSync(CAPABILITY_FILE, backup);
  try {
    assert.equal(readCapabilityToken(), null);
    const app = createApp();
    const response = await invokeRequest(app, "PUT", "/api/repo-config/monorepo", { headers: { "x-ronin-capability": "anything" } });
    assert.equal(response.status, 503);
    assert.equal((response.body as any).code, "CAPABILITY_UNAVAILABLE");
  } finally {
    if (backup) renameSync(backup, CAPABILITY_FILE);
  }
});

// ---- T12: /validate — mismo validateStages, sin persistir nada ----

test("T12.97 POST /api/workflow/validate: entrada válida → {ok:true, config} normalizado, y NO escribe workflow.json", async () => {
  const token = ensureCapabilityToken();
  const { getWorkflow } = await import("./workflow.js");
  const before = getWorkflow();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/workflow/validate", {
    headers: { "x-ronin-capability": token },
    body: { stages: [{ key: "planning", label: "  Plan  ", icon: "📋" }], verifyAfter: [] },
  });
  assert.equal(response.status, 200);
  assert.equal((response.body as any).ok, true);
  assert.deepEqual((response.body as any).config, { stages: [{ key: "planning", label: "Plan", icon: "📋", instruction: "" }], verifyAfter: [] });
  assert.deepEqual(getWorkflow(), before); // sin efecto en el archivo real
});

test("T12.98 POST /api/workflow/validate: entrada inválida → 400 {ok:false, error:{path, code, message}}, y NO escribe", async () => {
  const token = ensureCapabilityToken();
  const { getWorkflow } = await import("./workflow.js");
  const before = getWorkflow();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/workflow/validate", {
    headers: { "x-ronin-capability": token },
    body: {
      stages: [
        { key: "planning", label: "Plan", icon: "📋" },
        { key: "planning", label: "Otro", icon: "📋" },
      ],
      verifyAfter: [],
    },
  });
  assert.equal(response.status, 400);
  assert.equal((response.body as any).ok, false);
  assert.equal((response.body as any).error?.path, "stages[1].key");
  assert.equal((response.body as any).error?.code, "DUPLICATE_KEY");
  assert.deepEqual(getWorkflow(), before);
});

test("T12.99 POST /api/repo-config/:repo/validate: verifyCmd se CONSERVA (gitignored, per-repo)", async () => {
  const token = ensureCapabilityToken();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/repo-config/zz-test-validate-repo/validate", {
    headers: { "x-ronin-capability": token },
    body: { workflow: { stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test" }], verifyAfter: [] } },
  });
  assert.equal(response.status, 200);
  assert.equal((response.body as any).ok, true);
  assert.equal((response.body as any).config.stages[0].verifyCmd, "npm test");
});

test("T12.100 POST /api/workflow/validate: verifyCmd → 400 VERIFY_CMD_NOT_ALLOWED (git-tracked, T11.85)", async () => {
  const token = ensureCapabilityToken();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/workflow/validate", {
    headers: { "x-ronin-capability": token },
    body: { stages: [{ key: "curl", label: "Curl", icon: "🌐", verifyCmd: "npm test" }], verifyAfter: [] },
  });
  assert.equal(response.status, 400);
  assert.equal((response.body as any).ok, false);
  assert.equal((response.body as any).error?.code, "VERIFY_CMD_NOT_ALLOWED");
});

test("A3: PUT de catálogo honra verifyCmd/maxRetries y el PUT global legacy los rechaza", async () => {
  const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadWorkflowCatalog } = await import("./workflow-catalog.js");
  const directory = mkdtempSync(join(tmpdir(), "ronin-api-workflows-gates-"));
  mkdirSync(directory, { recursive: true });
  const token = ensureCapabilityToken();
  const headers = { "x-ronin-capability": token };
  try {
    const id = loadWorkflowCatalog(directory).items[0]!.id;
    const app = createApp({ catalogDirectory: directory });
    const config = {
      stages: [
        { key: "tests", label: "Tests", icon: "✅", verifyCmd: "npm test", maxRetries: 2 },
        { key: "deploy", label: "Deploy", icon: "🚀", verifyCmd: "true", maxRetries: 7 },
      ],
      verifyAfter: [],
    };
    const updated = await invokeRequest(app, "PUT", `/api/workflows/${id}`, { headers, body: { config } });
    assert.equal(updated.status, 200);
    assert.deepEqual((updated.body as any).config.stages.map((stage: any) => [stage.verifyCmd, stage.maxRetries]), [
      ["npm test", 2],
      ["true", 7],
    ]);
    const listed = await invokeRequest(app, "GET", "/api/workflows");
    assert.deepEqual((listed.body as any).items[0].config.stages.map((stage: any) => [stage.verifyCmd, stage.maxRetries]), [
      ["npm test", 2],
      ["true", 7],
    ]);

    const legacy = await invokeRequest(app, "PUT", "/api/workflow", { headers, body: config });
    assert.equal(legacy.status, 400);
    assert.equal((legacy.body as any).code, "VERIFY_CMD_NOT_ALLOWED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- T4: POST/DELETE /api/sessions/:name/adopt ----

test("GET/PUT /api/trusted-roots devuelve, valida y respeta la política del entorno", async () => {
  const token = ensureCapabilityToken();
  let roots = ["/trusted"];
  const app = createApp({ trustedRoots: {
    read: () => ({ roots, source: "settings" as const }),
    save: (input) => {
      if (!Array.isArray(input) || input.some((root) => root !== "/next")) throw new Error("raíz inválida: /bad (debe existir y ser absoluta)");
      roots = input;
      return { roots, source: "settings" as const };
    },
  } });
  assert.deepEqual(await invokeGet(app, "/api/trusted-roots"), { status: 200, body: { roots: ["/trusted"], source: "settings" } });
  assert.deepEqual((await invokeRequest(app, "PUT", "/api/trusted-roots", { headers: { "x-ronin-capability": token }, body: { roots: ["/next"] } })).body, { roots: ["/next"], source: "settings" });
  const invalid = await invokeRequest(app, "PUT", "/api/trusted-roots", { headers: { "x-ronin-capability": token }, body: { roots: ["/bad"] } });
  assert.equal(invalid.status, 400);
  assert.match((invalid.body as { error: string }).error, /raíz inválida/);

  const previous = process.env.COWORK_ALLOWED_ROOTS;
  try {
    process.env.COWORK_ALLOWED_ROOTS = "/env";
    const envApp = createApp();
    const blocked = await invokeRequest(envApp, "PUT", "/api/trusted-roots", { headers: { "x-ronin-capability": token }, body: { roots: [] } });
    assert.deepEqual(blocked, { status: 409, body: { error: "COWORK_ALLOWED_ROOTS definida: las raíces se gestionan por entorno", code: "ROOTS_FROM_ENV" } });
  } finally {
    if (previous === undefined) delete process.env.COWORK_ALLOWED_ROOTS;
    else process.env.COWORK_ALLOWED_ROOTS = previous;
  }
});

test("GET/PUT /api/engine devuelve y guarda el motor con capability", async () => {
  const token = ensureCapabilityToken();
  let engine = { tool: "claude" as const };
  const app = createApp({ engine: {
    read: () => engine,
    save: (input) => {
      engine = input as typeof engine;
      return engine;
    },
  } });
  assert.deepEqual(await invokeGet(app, "/api/engine"), { status: 200, body: { engine: { tool: "claude" } } });
  assert.deepEqual(
    await invokeRequest(app, "PUT", "/api/engine", { headers: { "x-ronin-capability": token }, body: { engine: { tool: "codex", model: "gpt-5.3-codex" } } }),
    { status: 200, body: { engine: { tool: "codex", model: "gpt-5.3-codex" } } },
  );
});

test("runConfiguredClaude pasa el comando y args del motor al ejecutor inyectado", async () => {
  let received: { timeoutMs?: number; maxBytes?: number; command?: string; args?: string[] } | undefined;
  const runClaude = runConfiguredClaude(
    () => ({ tool: "codex", model: "gpt-5.3-codex" }),
    async (_prompt, options) => {
      received = options;
      return "<PROPOSALS>{\"proposals\":[]}</PROPOSALS>";
    },
  );
  await runClaude("analiza");
  assert.deepEqual(received, { timeoutMs: 300_000, maxBytes: 256 * 1024, command: "codex", args: ["exec", "--model", "gpt-5.3-codex"] });
});

test("POST /adopt devuelve el detalle explicativo de REPO_NOT_ALLOWED", async () => {
  const token = ensureCapabilityToken();
  const app = createApp({ adoptSession: async () => {
    throw new (await import("./adopt.js")).AdoptValidationError("REPO_NOT_ALLOWED", "/repo está fuera de las raíces de confianza (/root). Añádela en Configuración → Repos → Raíces de confianza.");
  } });
  const response = await invokeRequest(app, "POST", "/api/sessions/foreign/adopt", {
    headers: { "x-ronin-capability": token }, body: { confirm: true, repo: "ronin", expectedSessionCreatedAt: 1 },
  });
  assert.deepEqual(response, { status: 400, body: { error: "/repo está fuera de las raíces de confianza (/root). Añádela en Configuración → Repos → Raíces de confianza.", code: "REPO_NOT_ALLOWED" } });
});

test("POST …/adopt: traversal en :name → 400, sin tocar el filesystem (P5, test 45)", async () => {
  const token = ensureCapabilityToken();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/sessions/..%2f..%2ftmp%2fvictim/adopt", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true, repo: "monorepo" },
  });
  assert.equal(response.status, 400);
  assert.equal(existsSync("/tmp/victim"), false);
});

test("POST …/adopt: sesión inexistente → 404 (test 46)", async () => {
  const token = ensureCapabilityToken();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/sessions/no-such-session-anywhere/adopt", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true, repo: "monorepo" },
  });
  assert.equal(response.status, 404);
});

test("POST …/adopt: real end-to-end contra tmux — adopta, y DELETE la suelta sin matarla ni borrar el cycle dir (test 53)", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("foreign-http-adopt", "/tmp");
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "foreign-http-adopt");
    const app = createApp();

    const adopted = await invokeRequest(app, "POST", "/api/sessions/foreign-http-adopt/adopt", {
      headers: { "x-ronin-capability": token },
      body: { confirm: true, repo: "monorepo", expectedSessionCreatedAt },
    });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.body));

    const cycle = cycleDirForSession("foreign-http-adopt");
    assert.equal(existsSync(cycle), true);

    const released = await invokeRequest(app, "DELETE", "/api/sessions/foreign-http-adopt/adopt", {
      headers: { "x-ronin-capability": token },
    });
    assert.equal(released.status, 200);
    assert.deepEqual(released.body, { ok: true });

    // El cycle dir SIGUE ahí y la sesión SIGUE VIVA — DELETE suelta, nunca mata ni borra.
    assert.equal(existsSync(cycle), true);
    await assert.doesNotReject(() => pexec("tmux", ["-L", socket, "has-session", "-t", "foreign-http-adopt"], { env: envWithoutTmux() }));

    rmSync(cycle, { recursive: true, force: true });
  });
});

test("DELETE /api/sessions/:name exige confirmación y mata sólo la sesión tmux elegida", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t-close-session", "/tmp");
    const app = createApp();

    const unconfirmed = await invokeRequest(app, "DELETE", "/api/sessions/t-close-session", {
      headers: { "x-ronin-capability": token },
      body: {},
    });
    assert.equal(unconfirmed.status, 400);
    assert.equal((unconfirmed.body as any).code, "CONFIRMATION_REQUIRED");
    await assert.doesNotReject(() => pexec("tmux", ["-L", socket, "has-session", "-t", "t-close-session"], { env: envWithoutTmux() }));

    const closed = await invokeRequest(app, "DELETE", "/api/sessions/t-close-session", {
      headers: { "x-ronin-capability": token },
      body: { confirm: true },
    });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(closed.body, { ok: true });
    await assert.rejects(() => pexec("tmux", ["-L", socket, "has-session", "-t", "t-close-session"], { env: envWithoutTmux() }));
  });
});

test("DELETE /api/sessions/:name con cleanup mata antes y devuelve el reporte", async () => {
  const token = ensureCapabilityToken();
  const calls: string[] = [];
  const report = {
    kind: "managed" as const,
    worktree: { status: "removed" as const, path: "/worktree", branch: "ronin/cowork-clean" },
    cycleDir: { status: "removed" as const, path: "/tmp/cowork-cycle-cowork-clean" },
    containers: { removed: ["abc"], failed: [] },
  };
  const app = createApp({ sessions: {
    hasSession: async () => true,
    killSession: async () => { calls.push("kill"); },
    cleanupSession: async () => { calls.push("cleanup"); return report; },
  } });

  const response = await invokeRequest(app, "DELETE", "/api/sessions/cowork-clean", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true, cleanup: true },
  });

  assert.deepEqual(calls, ["kill", "cleanup"]);
  assert.deepEqual(response, { status: 200, body: { ok: true, cleanup: report } });
});

test("DELETE /api/sessions/:name sin cleanup conserva la respuesta actual", async () => {
  const token = ensureCapabilityToken();
  const calls: string[] = [];
  const app = createApp({ sessions: {
    hasSession: async () => true,
    killSession: async () => { calls.push("kill"); },
    cleanupSession: async () => { calls.push("cleanup"); throw new Error("no debe llamarse"); },
  } });

  const response = await invokeRequest(app, "DELETE", "/api/sessions/cowork-clean", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true },
  });

  assert.deepEqual(calls, ["kill"]);
  assert.deepEqual(response, { status: 200, body: { ok: true } });
});

test("DELETE /api/sessions/:name no falla el cierre si cleanup lanza", async () => {
  const token = ensureCapabilityToken();
  const app = createApp({ sessions: {
    hasSession: async () => true,
    killSession: async () => {},
    cleanupSession: async () => { throw new Error("docker explotó"); },
  } });

  const response = await invokeRequest(app, "DELETE", "/api/sessions/cowork-clean", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true, cleanup: true },
  });

  assert.deepEqual(response, { status: 200, body: { ok: true, cleanup: { error: "docker explotó" } } });
});

test("DELETE /api/sessions/:name conserva los 400 y 404 antes de limpiar", async () => {
  const token = ensureCapabilityToken();
  let cleanupCalls = 0;
  const app = createApp({ sessions: {
    hasSession: async () => false,
    killSession: async () => { throw new Error("no debe llamarse"); },
    cleanupSession: async () => { cleanupCalls += 1; throw new Error("no debe llamarse"); },
  } });

  const invalid = await invokeRequest(app, "DELETE", "/api/sessions/..%2funsafe", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true, cleanup: true },
  });
  const unconfirmed = await invokeRequest(app, "DELETE", "/api/sessions/missing", {
    headers: { "x-ronin-capability": token },
    body: { cleanup: true },
  });
  const missing = await invokeRequest(app, "DELETE", "/api/sessions/missing", {
    headers: { "x-ronin-capability": token },
    body: { confirm: true, cleanup: true },
  });

  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as any).code, "INVALID_SESSION");
  assert.equal(unconfirmed.status, 400);
  assert.equal((unconfirmed.body as any).code, "CONFIRMATION_REQUIRED");
  assert.equal(missing.status, 404);
  assert.equal((missing.body as any).code, "SESSION_NOT_FOUND");
  assert.equal(cleanupCalls, 0);
});

test("POST /api/sessions rechaza una petición de más de 8 KiB antes de lanzar", async () => {
  const token = ensureCapabilityToken();
  const app = createApp();
  const response = await invokeRequest(app, "POST", "/api/sessions", {
    headers: { "x-ronin-capability": token },
    body: { repo: "monorepo", workflowId: "wf-test", name: "cowork-demasiado-larga", request: "x".repeat(8 * 1024 + 1) },
  });
  assert.deepEqual(response, { status: 400, body: { error: "la petición no puede superar 8 KB", code: "REQUEST_TOO_LONG" } });
});

test("POST /api/sessions limpia NUL y espacios antes de medir y lanzar una petición", async () => {
  const token = ensureCapabilityToken();
  const received: unknown[] = [];
  const app = createApp({
    launchManagedSession: async (input) => {
      received.push(input);
      return { name: "cowork-peticion", repo: "monorepo", mode: "workflow", workflowId: "wf-test", cwd: "/repo" };
    },
    readTmuxInventory: async () => ({ sessions: [], diagnostic: null }),
  });
  const response = await invokeRequest(app, "POST", "/api/sessions", {
    headers: { "x-ronin-capability": token },
    body: { repo: "monorepo", workflowId: "wf-test", name: "cowork-peticion", request: `\0`.repeat(8 * 1024 + 1) + "  arregla CU-86e2\0  " },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(received, [{ repo: "monorepo", workflowId: "wf-test", name: "cowork-peticion", mode: undefined, agent: undefined, request: "arregla CU-86e2" }]);
});

test("POST /api/sessions sólo reenvía inputs que sean un objeto plano de strings", async () => {
  const token = ensureCapabilityToken();
  const received: unknown[] = [];
  const app = createApp({
    launchManagedSession: async (input) => {
      received.push(input);
      return { name: "cowork-inputs-http", repo: "monorepo", mode: "workflow", workflowId: "wf-test", cwd: "/repo" };
    },
    readTmuxInventory: async () => ({ sessions: [], diagnostic: null }),
  });
  const response = await invokeRequest(app, "POST", "/api/sessions", {
    headers: { "x-ronin-capability": token },
    body: { repo: "monorepo", workflowId: "wf-test", name: "cowork-inputs-http", inputs: { ticket: "CU-42", numero: 42 } },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(received, [{ repo: "monorepo", workflowId: "wf-test", name: "cowork-inputs-http", mode: undefined, agent: undefined, request: undefined, inputs: { ticket: "CU-42" } }]);
});

test("POST /api/sessions propaga la causa real de un fallo de launch no tipado", async () => {
  const token = ensureCapabilityToken();
  const app = createApp({
    launchManagedSession: async () => {
      throw new Error("fatal: invalid reference: main");
    },
    readTmuxInventory: async () => ({ sessions: [], diagnostic: null }),
  });
  const response = await invokeRequest(app, "POST", "/api/sessions", {
    headers: { "x-ronin-capability": token },
    body: { repo: "monorepo", workflowId: "wf-test", name: "cowork-causa-real" },
  });
  assert.equal(response.status, 500);
  const body = response.body as { error: string; code: string };
  assert.equal(body.code, "LAUNCH_FAILED");
  // El modal es un callejón sin salida si el 500 es mudo: la causa de git debe llegar al renderer.
  assert.match(body.error, /fatal: invalid reference: main/);
});

test("POST /api/sessions/:name/{term,attach} valida la sesión y traduce los fallos discriminados de ttyd", async () => {
  const token = ensureCapabilityToken();
  const calls: string[] = [];
  const app = createApp({
    terminal: {
      hasSession: async (name: string) => name === "sesion-viva" || name === "sin-ttyd" || name === "sin-puertos",
      startTtyd: async (name: string) => {
        calls.push(`ttyd:${name}`);
        if (name === "sin-ttyd") return { ok: false, reason: "not-installed" } as const;
        if (name === "sin-puertos") return { ok: false, reason: "no-free-port" } as const;
        return { ok: true, port: 7781 } as const;
      },
      openTerminal: async (name: string) => { calls.push(`attach:${name}`); },
    },
  });
  const headers = { "x-ronin-capability": token };

  const invalid = await invokeRequest(app, "POST", "/api/sessions/no%20segura/term", { headers });
  assert.deepEqual(invalid, { status: 400, body: { error: "nombre de sesión inválido", code: "INVALID_SESSION" } });

  const invalidAttach = await invokeRequest(app, "POST", "/api/sessions/no%20segura/attach", { headers });
  assert.deepEqual(invalidAttach, { status: 400, body: { error: "nombre de sesión inválido", code: "INVALID_SESSION" } });

  const missing = await invokeRequest(app, "POST", "/api/sessions/desconocida/attach", { headers });
  assert.deepEqual(missing, { status: 404, body: { error: "sesión no encontrada", code: "SESSION_NOT_FOUND" } });

  const missingTerm = await invokeRequest(app, "POST", "/api/sessions/desconocida/term", { headers });
  assert.deepEqual(missingTerm, { status: 404, body: { error: "sesión no encontrada", code: "SESSION_NOT_FOUND" } });

  const term = await invokeRequest(app, "POST", "/api/sessions/sesion-viva/term", { headers });
  assert.deepEqual(term, { status: 200, body: { url: "http://127.0.0.1:7781" } });

  const unavailable = await invokeRequest(app, "POST", "/api/sessions/sin-ttyd/term", { headers });
  assert.deepEqual(unavailable, { status: 503, body: { error: "ttyd no encontrado — instálalo con `brew install ttyd`", code: "TTYD_UNAVAILABLE" } });

  const noFreePort = await invokeRequest(app, "POST", "/api/sessions/sin-puertos/term", { headers });
  assert.deepEqual(noFreePort, { status: 503, body: { error: "ttyd no pudo reservar un puerto propio; otra instancia de Ronin podría estar usando el rango de puertos", code: "TTYD_NO_PORT" } });

  const attached = await invokeRequest(app, "POST", "/api/sessions/sesion-viva/attach", { headers });
  assert.deepEqual(attached, { status: 200, body: { ok: true } });
  assert.deepEqual(calls, ["ttyd:sesion-viva", "ttyd:sin-ttyd", "ttyd:sin-puertos", "attach:sesion-viva"]);
});

// ---- T5: render/input por pane, contra tmux REAL ----

test("GET …/panes/:paneId/capture: %N de OTRA sesión → 400 PANE_NOT_IN_SESSION; %N muerto → 200 {status:'gone'}; incluye cursor/size (58/59/64)", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t5-session-a", "/tmp");
    await createSession("t5-session-b", "/tmp");
    const { stdout: idsB } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t5-session-b", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneB = idsB.trim();
    const app = createApp();

    const crossSession = await invokeRequest(app, "GET", `/api/sessions/t5-session-a/panes/${encodeURIComponent(paneB)}/capture`, {
      headers: { "x-ronin-capability": token },
    });
    assert.equal(crossSession.status, 400);
    assert.equal((crossSession.body as any).code, "PANE_NOT_IN_SESSION");

    const { stdout: idsA } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t5-session-a", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneA = idsA.trim();
    const alive = await invokeRequest(app, "GET", `/api/sessions/t5-session-a/panes/${encodeURIComponent(paneA)}/capture`, {
      headers: { "x-ronin-capability": token },
    });
    assert.equal(alive.status, 200);
    assert.equal((alive.body as any).status, "ok");
    assert.equal(typeof (alive.body as any).cursor?.x, "number");
    assert.equal(typeof (alive.body as any).size?.cols, "number");

    // Split para que matar UN pane no mate la sesión entera (si no, "gone" se confundiría con
    // "sesión no encontrada" — bug real que este comentario documenta haber pisado antes).
    const { stdout: splitRaw } = await pexec("tmux", ["-L", socket, "split-window", "-t", "t5-session-a", "-P", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneDying = splitRaw.trim();
    await pexec("tmux", ["-L", socket, "kill-pane", "-t", paneDying], { env: envWithoutTmux() });
    const dead = await invokeRequest(app, "GET", `/api/sessions/t5-session-a/panes/${encodeURIComponent(paneDying)}/capture`, {
      headers: { "x-ronin-capability": token },
    });
    assert.deepEqual(dead.body, { status: "gone", content: null });
    assert.equal(dead.status, 200);
  });
});

test("POST …/panes/:paneId/keys: foreign → 403 SESSION_READ_ONLY; managed → llega el texto literal; >16KiB → 400; NUL se elimina (60/61/62)", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t5-foreign", "/tmp");
    const app = createApp();

    const foreignAttempt = await invokeRequest(app, "POST", `/api/sessions/t5-foreign/panes/${encodeURIComponent("%0")}/keys`, {
      headers: { "x-ronin-capability": token },
      body: { text: "echo hi" },
    });
    assert.equal(foreignAttempt.status, 403);
    assert.equal((foreignAttempt.body as any).code, "SESSION_READ_ONLY");

    await createSession("t5-managed", "/tmp");
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "t5-managed");
    await adoptSession({ session: "t5-managed", confirm: true, repo: "monorepo", expectedSessionCreatedAt });
    const { stdout: managedPaneRaw } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t5-managed", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const managedPane = managedPaneRaw.trim();

    const tooBig = await invokeRequest(app, "POST", `/api/sessions/t5-managed/panes/${encodeURIComponent(managedPane)}/keys`, {
      headers: { "x-ronin-capability": token },
      body: { text: "x".repeat(16 * 1024 + 1) },
    });
    assert.equal(tooBig.status, 400);

    const ok = await invokeRequest(app, "POST", `/api/sessions/t5-managed/panes/${encodeURIComponent(managedPane)}/keys`, {
      headers: { "x-ronin-capability": token },
      body: { text: "echo\0 T5_KEYS_OK", submit: true },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // Poll en vez de un sleep fijo: bajo carga (toda la suite corriendo) un solo timeout corto
    // es flaky — el shell puede tardar más en ecoar el comando.
    let screen = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      ({ stdout: screen } = await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", "t5-managed"], { env: envWithoutTmux() }));
      if (screen.includes("T5_KEYS_OK")) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(screen, /T5_KEYS_OK/);
    assert.doesNotMatch(screen, /echo\0/);

    await releaseAdoption("t5-managed");
    rmSync(cycleDirForSession("t5-managed"), { recursive: true, force: true });
  });
});

test("POST …/panes/:paneId/keys: un %N que ya no existe → 409 PANE_GONE, sin efecto (63)", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t5-gone", "/tmp");
    const { stdout: firstRaw } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t5-gone", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneKeep = firstRaw.trim();
    const { stdout: splitRaw } = await pexec("tmux", ["-L", socket, "split-window", "-t", "t5-gone", "-P", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneDying = splitRaw.trim();
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "t5-gone");
    await adoptSession({ session: "t5-gone", confirm: true, repo: "monorepo", paneId: paneKeep, expectedSessionCreatedAt });

    // Se mata el OTRO pane (no el adoptado) — la sesión sigue viva, sólo ese %N desaparece.
    await pexec("tmux", ["-L", socket, "kill-pane", "-t", paneDying], { env: envWithoutTmux() });

    const app = createApp();
    const response = await invokeRequest(app, "POST", `/api/sessions/t5-gone/panes/${encodeURIComponent(paneDying)}/keys`, {
      headers: { "x-ronin-capability": token },
      body: { text: "echo hi" },
    });
    assert.equal(response.status, 409);
    assert.equal((response.body as any).code, "PANE_GONE");

    // El pane adoptado (que SÍ sigue vivo) no recibió nada por accidente.
    await new Promise((r) => setTimeout(r, 200));
    const { stdout: screen } = await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", paneKeep], { env: envWithoutTmux() });
    assert.doesNotMatch(screen, /echo hi/);

    await releaseAdoption("t5-gone");
    rmSync(cycleDirForSession("t5-gone"), { recursive: true, force: true });
  });
});

test("POST …/panes/:paneId/keys registra reply sólo con texto + Enter, nunca teclas sueltas ni una opción de menú", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t5-reply", "/tmp");
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "t5-reply");
    await adoptSession({ session: "t5-reply", confirm: true, repo: "monorepo", expectedSessionCreatedAt });
    const { stdout } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t5-reply", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const pane = encodeURIComponent(stdout.trim());
    const replies: Array<[string, string]> = [];
    const app = createApp({ recordReply: (session, text) => { replies.push([session, text]); } });
    const send = (body: unknown) => invokeRequest(app, "POST", `/api/sessions/t5-reply/panes/${pane}/keys`, { headers: { "x-ronin-capability": token }, body });

    assert.equal((await send({ text: "echo tecla-suelta" })).status, 200);
    assert.equal((await send({ text: "2", submit: true })).status, 200);
    assert.equal((await send({ text: "echo usa make test-unit", submit: true })).status, 200);
    assert.deepEqual(replies, [["t5-reply", "echo usa make test-unit"]]);

    await releaseAdoption("t5-reply");
    rmSync(cycleDirForSession("t5-reply"), { recursive: true, force: true });
  });
});

// ---- T7: broadcast ----

test("POST …/broadcast: sin confirm:true → 400 CONFIRMATION_REQUIRED; sobre foreign → 403", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async () => {
    await createSession("t7-foreign", "/tmp");
    const app = createApp();

    const noConfirm = await invokeRequest(app, "POST", "/api/sessions/t7-foreign/broadcast", {
      headers: { "x-ronin-capability": token },
      body: { targets: ["%0"], text: "echo hi" },
    });
    assert.equal(noConfirm.status, 400);
    assert.equal((noConfirm.body as any).code, "CONFIRMATION_REQUIRED");

    const onForeign = await invokeRequest(app, "POST", "/api/sessions/t7-foreign/broadcast", {
      headers: { "x-ronin-capability": token },
      body: { confirm: true, targets: ["%0"], text: "echo hi" },
    });
    assert.equal(onForeign.status, 403);
  });
});

test("POST …/broadcast: un target ajeno → 400, y NINGÚN send-keys se ejecuta (todo-o-nada)", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t7-managed", "/tmp");
    const { stdout: firstRaw } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t7-managed", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneOwn = firstRaw.trim();
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "t7-managed");
    await adoptSession({ session: "t7-managed", confirm: true, repo: "monorepo", paneId: paneOwn, expectedSessionCreatedAt });
    await createSession("t7-other-session", "/tmp");
    const { stdout: elsewhereRaw } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t7-other-session", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneElsewhere = elsewhereRaw.trim();

    const app = createApp();
    const response = await invokeRequest(app, "POST", "/api/sessions/t7-managed/broadcast", {
      headers: { "x-ronin-capability": token },
      body: { confirm: true, targets: [paneOwn, paneElsewhere], text: "echo T7_ALLORNOTHING" },
    });
    assert.equal(response.status, 400);
    assert.equal((response.body as any).code, "PANE_NOT_IN_SESSION");

    await new Promise((r) => setTimeout(r, 200));
    const { stdout: screen } = await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", paneOwn], { env: envWithoutTmux() });
    assert.doesNotMatch(screen, /T7_ALLORNOTHING/);

    await releaseAdoption("t7-managed");
    rmSync(cycleDirForSession("t7-managed"), { recursive: true, force: true });
  });
});

test("POST …/broadcast: válido → un send-keys por target, y la respuesta enumera los destinos", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t7-valid", "/tmp");
    const { stdout: firstRaw } = await pexec("tmux", ["-L", socket, "list-panes", "-t", "t7-valid", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneA = firstRaw.trim();
    const { stdout: splitRaw } = await pexec("tmux", ["-L", socket, "split-window", "-t", "t7-valid", "-P", "-F", "#{pane_id}"], { env: envWithoutTmux() });
    const paneB = splitRaw.trim();
    const expectedSessionCreatedAt = await liveSessionCreatedAt(socket, "t7-valid");
    await adoptSession({ session: "t7-valid", confirm: true, repo: "monorepo", paneId: paneA, expectedSessionCreatedAt });

    const app = createApp();
    const response = await invokeRequest(app, "POST", "/api/sessions/t7-valid/broadcast", {
      headers: { "x-ronin-capability": token },
      body: { confirm: true, targets: [paneA, paneB], text: "echo T7_BROADCAST_OK" },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(new Set((response.body as any).targets), new Set([paneA, paneB]));

    for (const pane of [paneA, paneB]) {
      let screen = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        ({ stdout: screen } = await pexec("tmux", ["-L", socket, "capture-pane", "-p", "-t", pane], { env: envWithoutTmux() }));
        if (screen.includes("T7_BROADCAST_OK")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.match(screen, /T7_BROADCAST_OK/, `pane ${pane}`);
    }

    await releaseAdoption("t7-valid");
    rmSync(cycleDirForSession("t7-valid"), { recursive: true, force: true });
  });
});

// ---- Test harness: /api/tests/* sólo acepta selecciones DECLARADAS, nunca texto ejecutable ----

async function harnessApp() {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHarnessStore } = await import("./test-harness/config.js");
  const { createTestHarnessService } = await import("./test-harness/service.js");
  const dir = mkdtempSync(join(tmpdir(), "ronin-api-harness-"));
  const store = createHarnessStore({ directory: dir, repos: () => ["api"] });
  const harness = createTestHarnessService({ store, resolveCwd: () => ({ cwd: dir, real: true }) });
  return { app: createApp({ harness }), harness, store, dir };
}

test("POST /api/tests/runs rejects a free shell command and accepts a declared selection with 202", async () => {
  const token = ensureCapabilityToken();
  const { app, harness, dir } = await harnessApp();
  try {
    const headers = { "x-ronin-capability": token };
    const bad = await invokeRequest(app, "POST", "/api/tests/runs", { headers, body: { command: "rm -rf /" } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as any).code, "INVALID_SELECTION");
    const unknown = await invokeRequest(app, "POST", "/api/tests/runs", { headers, body: { kind: "suites", repo: "nope", profile: "dev", suites: ["unit"] } });
    assert.equal(unknown.status, 404);
    harness.saveRepo("api", { profiles: [{ name: "dev", variables: { TOKEN: "s3cr3t-value" } }], suites: {} });
    const good = await invokeRequest(app, "POST", "/api/tests/runs", { headers, body: { kind: "suites", repo: "api", profile: "dev", suites: ["unit"] } });
    assert.equal(good.status, 202);
    const runId = (good.body as any).runIds[0];
    const detail = await invokeRequest(app, "GET", `/api/tests/runs/${runId}`);
    assert.equal(detail.status, 200);
    assert.equal((detail.body as any).status, "blocked"); // suite unit sin configurar
    const missing = await invokeRequest(app, "GET", `/api/tests/runs/run-nope`);
    assert.equal(missing.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/tests/runs/:id/cases serves saved cases and distinguishes missing runs from historical runs", async () => {
  const { app, store, dir } = await harnessApp();
  try {
    store.upsertRun({ runId: "run-with-cases", repo: "api", suite: "unit", profile: "dev", status: "passed", createdAt: "2026-09-14T00:00:00.000Z" });
    store.writeCases("run-with-cases", { runId: "run-with-cases", cases: [{ id: "::ok#0", name: "ok", status: "passed" }], truncated: false });
    store.upsertRun({ runId: "run-historical", repo: "api", suite: "unit", profile: "dev", status: "passed", createdAt: "2026-09-13T00:00:00.000Z" });

    const found = await invokeRequest(app, "GET", "/api/tests/runs/run-with-cases/cases");
    assert.equal(found.status, 200);
    assert.equal((found.body as any).cases[0].name, "ok");
    const historical = await invokeRequest(app, "GET", "/api/tests/runs/run-historical/cases");
    assert.equal(historical.status, 404);
    assert.equal((historical.body as any).code, "CASES_NOT_FOUND");
    const missing = await invokeRequest(app, "GET", "/api/tests/runs/run-missing/cases");
    assert.equal(missing.status, 404);
    assert.equal((missing.body as any).code, "RUN_NOT_FOUND");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/tests/config and PUT /api/tests/config/:repo validate and never expose variable values", async () => {
  const token = ensureCapabilityToken();
  const { app, dir } = await harnessApp();
  try {
    const headers = { "x-ronin-capability": token };
    const invalid = await invokeRequest(app, "PUT", "/api/tests/config/api", { headers, body: { suites: { unit: { command: "pytest -q" } } } });
    assert.equal(invalid.status, 400);
    assert.equal((invalid.body as any).code, "INVALID_CONFIG");
    const saved = await invokeRequest(app, "PUT", "/api/tests/config/api", {
      headers,
      body: { profiles: [{ name: "dev", variables: { TOKEN: "s3cr3t-value" } }], suites: { unit: { command: { program: "pytest", args: ["-q"] }, junitPath: "junit.xml" } } },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((saved.body as any).profiles[0].variables, ["TOKEN"]);
    const list = await invokeRequest(app, "GET", "/api/tests/config");
    assert.equal(list.status, 200);
    assert.equal(JSON.stringify(list.body).includes("s3cr3t-value"), false);
    const matrix = await invokeRequest(app, "GET", "/api/tests/matrix");
    assert.equal(matrix.status, 200);
    assert.equal((matrix.body as any)[0].cells.unit.state, "never_run");
    const runs = await invokeRequest(app, "GET", "/api/tests/runs");
    assert.deepEqual(runs.body, []);
    const cancel = await invokeRequest(app, "POST", "/api/tests/runs/run-nope/cancel", { headers });
    assert.equal(cancel.status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Workflow insights: /api/workflows/analyze + propuestas. El análisis corre en background
// (202 + sondeo), y `accept` escribe en el CATÁLOGO: el test inyecta store, analyzer y un
// `catalogDirectory` en tmpdir para no tocar nunca `server/data/workflows.json`.

async function insightsApp() {
  const { mkdirSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createProposalStore } = await import("./workflow-insights/store.js");
  const { createAnalyzer } = await import("./workflow-insights/analyzer.js");
  const { loadWorkflowCatalog } = await import("./workflow-catalog.js");

  const dir = mkdtempSync(join(tmpdir(), "ronin-api-insights-"));
  const catalogDir = join(dir, "catalog");
  mkdirSync(catalogDir, { recursive: true });

  const store = createProposalStore(dir);
  const proposals = {
    proposals: [
      {
        name: "hotfix-express",
        rationale: "varios arreglos urgentes en la misma semana",
        evidence: ["RON-1"],
        config: {
          stages: [
            { key: "diagnose", label: "Diagnóstico", icon: "🔎" },
            { key: "fix", label: "Arreglo", icon: "🛠", role: "impl" },
          ],
          verifyAfter: [],
        },
      },
    ],
  };
  const analyzer = createAnalyzer({
    store,
    signals: async () => ({ range: { from: "", to: "" }, tasks: [], commits: {}, evidence: [] }),
    catalogNames: () => loadWorkflowCatalog(catalogDir).items.map((item) => item.name),
    runClaude: async () => `<PROPOSALS>${JSON.stringify(proposals)}</PROPOSALS>`,
  });

  return { app: createApp({ insights: { store, analyzer, catalogDirectory: catalogDir } }), store, analyzer, dir };
}

test("POST /api/workflows/analyze returns 202 and the analysis becomes done with one proposal; accept creates a catalog item once", async () => {
  const token = ensureCapabilityToken();
  const { app, analyzer, dir } = await insightsApp();
  try {
    const bad = await invokeRequest(app, "POST", "/api/workflows/analyze", { headers: { "x-ronin-capability": token }, body: { from: "x" } });
    assert.equal(bad.status, 400);
    const started = await invokeRequest(app, "POST", "/api/workflows/analyze", { headers: { "x-ronin-capability": token }, body: {} });
    assert.equal(started.status, 202);
    const id = (started.body as any).analysisId;
    await analyzer.waitFor(id);
    const a = await invokeRequest(app, "GET", `/api/workflows/analyses/${id}`);
    assert.equal((a.body as any).status, "done");
    const list = await invokeRequest(app, "GET", "/api/workflows/proposals?status=proposed");
    const pid = (list.body as any)[0].id;
    const accepted = await invokeRequest(app, "POST", `/api/workflows/proposals/${pid}/accept`, { headers: { "x-ronin-capability": token }, body: {} });
    assert.equal(accepted.status, 201);
    assert.ok((accepted.body as any).id);
    const again = await invokeRequest(app, "POST", `/api/workflows/proposals/${pid}/accept`, { headers: { "x-ronin-capability": token }, body: {} });
    assert.equal(again.status, 409);
    assert.equal((await invokeRequest(app, "POST", "/api/workflows/proposals/nope/dismiss", { headers: { "x-ronin-capability": token } })).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DELETE /api/workflows devuelve 200, 404 y 409 sin tocar el catálogo real", async () => {
  const { mkdirSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createWorkflowCatalogItem, loadWorkflowCatalog } = await import("./workflow-catalog.js");
  const directory = mkdtempSync(join(tmpdir(), "ronin-api-workflows-"));
  mkdirSync(directory, { recursive: true });
  const token = ensureCapabilityToken();
  const headers = { "x-ronin-capability": token };
  try {
    const initial = loadWorkflowCatalog(directory).items[0]!;
    const extra = createWorkflowCatalogItem("release", { stages: [{ key: "plan", label: "Plan", icon: "•" }], verifyAfter: [] }, directory);
    const app = createApp({ catalogDirectory: directory });
    assert.deepEqual(await invokeRequest(app, "DELETE", `/api/workflows/${extra.id}`, { headers }), { status: 200, body: { ok: true } });
    assert.deepEqual(await invokeRequest(app, "DELETE", `/api/workflows/${extra.id}`, { headers }), { status: 404, body: { error: "WORKFLOW_NOT_FOUND", code: "WORKFLOW_NOT_FOUND" } });
    assert.deepEqual(await invokeRequest(app, "DELETE", `/api/workflows/${initial.id}`, { headers }), { status: 409, body: { error: "no se puede eliminar el único workflow", code: "WORKFLOW_LAST" } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---- Foco de pane por sesión: el clic en la lista de panes mueve la ventana/pane activos de tmux ----

test("POST /api/sessions/:name/panes/:paneId/focus valida y cambia la ventana activa (ttyd la sigue)", async () => {
  const token = ensureCapabilityToken();
  await withIsolatedSocket(async (socket) => {
    await createSession("t-focus", "/tmp");
    await pexec("tmux", ["-L", socket, "new-window", "-t", "t-focus"], { env: envWithoutTmux() });
    const { stdout } = await pexec("tmux", ["-L", socket, "list-panes", "-s", "-t", "t-focus", "-F", "#{window_index} #{pane_id}"], { env: envWithoutTmux() });
    const win0 = stdout.trim().split("\n").find((l) => l.startsWith("0 "))!.split(" ")[1];
    // tras new-window la ventana activa es la 1; pedimos foco al pane de la ventana 0
    await adoptSession({ session: "t-focus", repo: "monorepo", confirm: true, paneId: win0, expectedSessionCreatedAt: await liveSessionCreatedAt(socket, "t-focus") });
    const app = createApp();
    const headers = { "x-ronin-capability": token };
    assert.equal((await invokeRequest(app, "POST", "/api/sessions/t-focus/panes/nope/focus", { headers })).status, 400);
    assert.equal((await invokeRequest(app, "POST", `/api/sessions/no-such-session/panes/${encodeURIComponent("%1")}/focus`, { headers })).status, 404);
    const ok = await invokeRequest(app, "POST", `/api/sessions/t-focus/panes/${encodeURIComponent(win0)}/focus`, { headers });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const active = await pexec("tmux", ["-L", socket, "display-message", "-p", "-t", "t-focus", "#{window_index} #{pane_id}"], { env: envWithoutTmux() });
    assert.equal(active.stdout.trim(), `0 ${win0}`);
    await releaseAdoption("t-focus");
    rmSync(cycleDirForSession("t-focus"), { recursive: true, force: true });
  });
});

// ---- Skills aprendidas: API local (spec skills aprendidas §7) ----

function learnedFixture() {
  const base = mkdtempSync(join(tmpdir(), "ronin-api-skills-"));
  const root = join(base, "skills", "learned");
  let seq = 0;
  const store = createLearnedSkillStore({
    root,
    metaFile: join(base, "skills", "learned.json"),
    historyDir: join(base, "skills", "history"),
    listRepos: () => ["acme-api"],
    contextFor: (repo) => ({ repo }),
    associate: () => {},
    now: () => 1_790_000_000_000,
    newId: () => `s_${++seq}`,
  });
  return { base, root, store, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const SKILL_DRAFT = {
  repo: "acme-api",
  source: "cowork-mig",
  name: "migracion-reversible",
  description: "Agrega una migración reversible y la prueba ida y vuelta.",
  body: "1. Crea la migración.\n2. Pruébala ida y vuelta.",
};

test("aprendizaje por repo: capability, origen, lectura, cambio, 400 con reasons y 404 de repo desconocido", async () => {
  const token = ensureCapabilityToken();
  const { store, cleanup } = learnedFixture();
  try {
    const app = createApp({ skills: { store, globalEnabled: true } });
    const headers = { "x-ronin-capability": token };
    assert.equal((await invokeRequest(app, "GET", "/api/repos/acme-api/skills/learning")).status, 401);
    assert.equal((await invokeRequest(app, "GET", "/api/repos/acme-api/skills/learning", { headers: { ...headers, origin: "https://evil.example" } })).status, 403);
    assert.deepEqual(await invokeRequest(app, "GET", "/api/repos/acme-api/skills/learning", { headers }), { status: 200, body: { repo: "acme-api", enabled: true, globalEnabled: true } });
    assert.deepEqual(
      await invokeRequest(app, "PUT", "/api/repos/acme-api/skills/learning", { headers, body: { enabled: false } }),
      { status: 200, body: { repo: "acme-api", enabled: false, globalEnabled: true } },
    );
    const bad = await invokeRequest(app, "PUT", "/api/repos/acme-api/skills/learning", { headers, body: { enabled: "no" } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as any).code, "SKILL_INVALID");
    assert.deepEqual((bad.body as any).reasons, ["enabled debe ser true o false"]);
    const unknown = await invokeRequest(app, "GET", "/api/repos/acme-otro/skills/learning", { headers });
    assert.equal(unknown.status, 404);
    assert.equal((unknown.body as any).code, "REPO_UNKNOWN");
    assert.equal(typeof (unknown.body as any).error, "string");
  } finally {
    cleanup();
  }
});

test("propuestas de skills: la lista no trae el texto, el detalle sí (con diff en una actualización); 404 y 401", async () => {
  const token = ensureCapabilityToken();
  const { store, cleanup } = learnedFixture();
  try {
    const created = store.propose(SKILL_DRAFT);
    const app = createApp({ skills: { store } });
    const headers = { "x-ronin-capability": token };
    assert.equal((await invokeRequest(app, "GET", "/api/skills/proposals")).status, 401);
    const list = await invokeRequest(app, "GET", "/api/skills/proposals", { headers });
    assert.deepEqual(list, {
      status: 200,
      body: { proposals: [{ id: "s_1", kind: "new", name: "migracion-reversible", repo: "acme-api", source: "cowork-mig", description: SKILL_DRAFT.description, warnings: [], createdAt: 1_790_000_000_000 }] },
    });
    assert.equal((await invokeRequest(app, "GET", "/api/skills/proposals?repo=acme-api", { headers })).status, 200);
    assert.equal((await invokeRequest(app, "GET", "/api/skills/proposals?repo=acme-otro", { headers })).status, 404);
    const detail = await invokeRequest(app, "GET", "/api/skills/proposals/s_1", { headers });
    assert.equal((detail.body as any).content, created.content);
    assert.equal((detail.body as any).contentHash, created.contentHash);
    assert.equal("diff" in (detail.body as any), false);
    assert.equal((await invokeRequest(app, "GET", "/api/skills/proposals/s_1")).status, 401);
    const missing = await invokeRequest(app, "GET", "/api/skills/proposals/s_nope", { headers });
    assert.equal(missing.status, 404);
    assert.equal((missing.body as any).code, "SKILL_PROPOSAL_NOT_FOUND");

    store.resolve(created.id, "approve", { contentHash: created.contentHash });
    const update = store.propose({ ...SKILL_DRAFT, source: "cowork-2", body: `${SKILL_DRAFT.body}\n3. Prueba el rollback.` });
    const updateDetail = await invokeRequest(app, "GET", `/api/skills/proposals/${update.id}`, { headers });
    assert.equal((updateDetail.body as any).kind, "update");
    assert.equal((updateDetail.body as any).base.hash, update.baseHash);
    assert.match((updateDetail.body as any).diff, /^\+3\. Prueba el rollback\.$/m);
  } finally {
    cleanup();
  }
});

test("PATCH de propuestas: aprobar exige el hash (400 sin él, 409 si no coincide), base cambiada 409, editar revalida, descartar y 404", async () => {
  const token = ensureCapabilityToken();
  const { root, store, cleanup } = learnedFixture();
  try {
    const app = createApp({ skills: { store } });
    const headers = { "x-ronin-capability": token };
    const patch = (id: string, body: unknown) => invokeRequest(app, "PATCH", `/api/skills/proposals/${id}`, { headers, body });
    const created = store.propose(SKILL_DRAFT);
    assert.equal((await invokeRequest(app, "PATCH", `/api/skills/proposals/${created.id}`, { body: { action: "approve", contentHash: created.contentHash } })).status, 401);
    const noHash = await patch(created.id, { action: "approve" });
    assert.equal(noHash.status, 400);
    assert.equal((noHash.body as any).code, "SKILL_INVALID");
    const wrong = await patch(created.id, { action: "approve", contentHash: "sha256:otro" });
    assert.equal(wrong.status, 409);
    assert.equal((wrong.body as any).code, "SKILL_STALE");
    const approved = await patch(created.id, { action: "approve", contentHash: created.contentHash });
    assert.equal(approved.status, 200);
    assert.deepEqual((approved.body as any).skill, { name: "migracion-reversible", version: 1, hash: created.contentHash, kind: "new", repo: "acme-api" });
    assert.equal((await patch(created.id, { action: "approve", contentHash: created.contentHash })).status, 409);

    const update = store.propose({ ...SKILL_DRAFT, source: "cowork-2", body: `${SKILL_DRAFT.body}\n3. Rollback.` });
    writeFileSync(join(root, "migracion-reversible", "SKILL.md"), "cambiado a mano\n");
    const stale = await patch(update.id, { action: "approve", contentHash: update.contentHash });
    assert.equal(stale.status, 409);
    assert.equal((stale.body as any).code, "SKILL_STALE");

    const other = store.propose({ ...SKILL_DRAFT, name: "otra-skill" });
    const badEdit = await patch(other.id, { action: "edit", content: other.content.replace("Pruébala", "password: hunter22hunter") });
    assert.equal(badEdit.status, 400);
    assert.equal((badEdit.body as any).code, "SKILL_INVALID");
    assert.match((badEdit.body as any).reasons.join("|"), /credencial asignada/);
    const edited = await patch(other.id, { action: "edit", content: other.content.replace("Pruébala ida y vuelta.", "Pruébala con make test.") });
    assert.equal(edited.status, 200);
    assert.equal((edited.body as any).skill.version, 1);

    const third = store.propose({ ...SKILL_DRAFT, name: "tercera" });
    const discarded = await patch(third.id, { action: "discard" });
    assert.equal(discarded.status, 200);
    assert.equal((discarded.body as any).proposal.status, "discarded");
    assert.equal((await patch("s_nope", { action: "discard" })).status, 404);
    assert.equal((await patch(update.id, { action: "borrar" })).status, 400);
  } finally {
    cleanup();
  }
});

test("POST /api/sessions/:name/skill: 202, 409 en curso, flujo incompleto o apagado, 404, 400 y 401", async () => {
  const token = ensureCapabilityToken();
  const outcomes: Record<string, "busy" | "incomplete" | "unknown" | "disabled"> = {
    "cowork-ocupada": "busy", "cowork-a-medias": "incomplete", "cowork-nada": "unknown", "cowork-apagada": "disabled",
  };
  const requested: string[] = [];
  const distiller = fakeDistiller({ requestSkill: (name) => { requested.push(name); return outcomes[name] ?? "queued"; } });
  const app = createApp({ memory: { distiller } });
  const headers = { "x-ronin-capability": token };
  assert.equal((await invokeRequest(app, "POST", "/api/sessions/cowork-mig/skill")).status, 401);
  assert.deepEqual(await invokeRequest(app, "POST", "/api/sessions/cowork-mig/skill", { headers }), { status: 202, body: { status: "running", at: 1 } });
  const expected: Array<[string, number, string]> = [
    ["cowork-ocupada", 409, "SKILL_RUNNING"],
    ["cowork-a-medias", 409, "SKILL_FLOW_INCOMPLETE"],
    ["cowork-apagada", 409, "SKILL_LEARNING_DISABLED"],
    ["cowork-nada", 404, "SESSION_NOT_FOUND"],
    ["mal%20nombre", 400, "INVALID_SESSION"],
  ];
  for (const [name, status, code] of expected) {
    const response = await invokeRequest(app, "POST", `/api/sessions/${name}/skill`, { headers });
    assert.equal(response.status, status, name);
    assert.equal((response.body as any).code, code, name);
    assert.equal(typeof (response.body as any).error, "string", name);
  }
  assert.deepEqual(requested, ["cowork-mig", "cowork-ocupada", "cowork-a-medias", "cowork-apagada", "cowork-nada"]);
});

test("GET /api/skills marca integridad, versión y usos de las learned; PUT de una learned valida y la reaprueba; POST la rechaza", async () => {
  const token = ensureCapabilityToken();
  const { base, root, store, cleanup } = learnedFixture();
  const previousLearned = process.env.COWORK_LEARNED_SKILLS_ROOT;
  const previousGlobal = process.env.COWORK_SKILLS_ROOT;
  process.env.COWORK_LEARNED_SKILLS_ROOT = root;
  process.env.COWORK_SKILLS_ROOT = join(base, "global");
  try {
    const created = store.propose(SKILL_DRAFT);
    store.resolve(created.id, "approve", { contentHash: created.contentHash });
    store.markUsed(["migracion-reversible"]);
    const app = createApp({ skills: { store } });
    const headers = { "x-ronin-capability": token };
    const learnedSummary = async () => ((await invokeRequest(app, "GET", "/api/skills")).body as any).skills.find((skill: any) => skill.ref.root === "learned");
    assert.deepEqual(await learnedSummary(), {
      ref: { root: "learned", name: "migracion-reversible" }, name: "migracion-reversible", description: SKILL_DRAFT.description, valid: true,
      integrity: "ok", version: 1, uses: 1,
    });
    writeFileSync(join(root, "migracion-reversible", "SKILL.md"), `${created.content}\nA mano.\n`);
    assert.equal((await learnedSummary()).integrity, "modified");

    const bad = await invokeRequest(app, "PUT", "/api/skills", { headers, body: { root: "learned", name: "migracion-reversible", content: "---\nname: migracion-reversible\ndescription: x\nallowed-tools: Bash\n---\n" } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as any).code, "SKILL_INVALID");
    assert.match((bad.body as any).reasons.join("|"), /allowed-tools/);
    const good = await invokeRequest(app, "PUT", "/api/skills", { headers, body: { root: "learned", name: "migracion-reversible", content: `${created.content}\nA mano.\n` } });
    assert.equal(good.status, 200);
    assert.equal((good.body as any).name, "migracion-reversible");
    assert.deepEqual([(await learnedSummary()).integrity, (await learnedSummary()).version], ["ok", 2]);

    const post = await invokeRequest(app, "POST", "/api/skills", { headers, body: { root: "learned", name: "nueva", content: "---\nname: nueva\ndescription: x\n---\n" } });
    assert.equal(post.status, 400);
    assert.equal((post.body as any).code, "SKILL_REF_INVALID");
  } finally {
    if (previousLearned === undefined) delete process.env.COWORK_LEARNED_SKILLS_ROOT;
    else process.env.COWORK_LEARNED_SKILLS_ROOT = previousLearned;
    if (previousGlobal === undefined) delete process.env.COWORK_SKILLS_ROOT;
    else process.env.COWORK_SKILLS_ROOT = previousGlobal;
    cleanup();
  }
});

test("GET /api/sessions añade skills (repo y estado de la parte de skill) a las gestionadas con repo conocido", async () => {
  const { store, cleanup } = memoryFixture();
  try {
    const base = { windows: 1, panes: [], createdAt: 0, attached: false, adopted: false };
    const app = createApp({
      readTmuxInventory: async () => ({
        sessions: [
          { ...base, name: "cowork-skill-a", kind: "managed" as const },
          { ...base, name: "cowork-skill-sin-repo", kind: "managed" as const },
          { ...base, name: "skill-ajena", kind: "foreign" as const },
        ],
        diagnostic: null,
      }),
      memory: {
        store,
        distiller: fakeDistiller({ stateOf: () => null, skillStateOf: (name) => (name === "cowork-skill-a" ? { status: "done", at: 7, proposalId: "s_1" } : null) }),
        repoOf: (name) => (name === "cowork-skill-sin-repo" ? null : "acme-api"),
      },
    });
    const sessions = ((await invokeRequest(app, "GET", "/api/sessions")).body as any).sessions;
    assert.deepEqual(sessions[0].skills, { repo: "acme-api", state: { status: "done", at: 7, proposalId: "s_1" } });
    assert.equal("skills" in sessions[1], false);
    assert.equal("skills" in sessions[2], false);
  } finally {
    cleanup();
  }
});

test("final F2: GET /api/sessions arma una vista por petición: state.json una vez y pendientes una vez por repo", async () => {
  const { store, cleanup } = memoryFixture();
  try {
    store.propose("acme-api", [{ text: "Pendiente", kind: "trampa" }], "cowork-f2-a");
    const counts = { snapshot: 0, stateOf: 0, skillStateOf: 0, pending: 0 };
    const view = { stateOf: () => ({ status: "done" as const, repo: "acme-api", at: 5 }), skillStateOf: () => ({ status: "done" as const, at: 6 }) };
    const distiller = fakeDistiller({
      stateOf: () => { counts.stateOf++; return null; },
      skillStateOf: () => { counts.skillStateOf++; return null; },
      snapshot: () => { counts.snapshot++; return view; },
    });
    const counted = Object.create(store) as typeof store;
    counted.pending = (repo?: string) => { counts.pending++; return store.pending(repo); };
    const base = { windows: 1, panes: [], createdAt: 0, attached: false, adopted: false };
    const names = ["cowork-f2-a", "cowork-f2-b", "cowork-f2-c", "cowork-f2-d"];
    const app = createApp({
      readTmuxInventory: async () => ({ sessions: names.map((name) => ({ ...base, name, kind: "managed" as const })), diagnostic: null }),
      memory: { store: counted, distiller, repoOf: () => "acme-api" },
    });
    const sessions = ((await invokeRequest(app, "GET", "/api/sessions")).body as any).sessions;
    assert.deepEqual(counts, { snapshot: 1, stateOf: 0, skillStateOf: 0, pending: 1 });
    for (const session of sessions) {
      assert.deepEqual(session.memory, { repo: "acme-api", pending: 1, distill: { status: "done", repo: "acme-api", at: 5 } });
      assert.deepEqual(session.skills, { repo: "acme-api", state: { status: "done", at: 6 } });
    }
    await invokeRequest(app, "GET", "/api/sessions");
    assert.equal(counts.snapshot, 2, "cada petición arma su propia vista");
  } finally {
    cleanup();
  }
});
