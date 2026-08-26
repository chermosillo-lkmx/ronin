import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapDesktop, createAuthorityResolver } from "./bootstrap.js";

// ---- T6: createAuthorityResolver — main resuelve managed/foreign contra el servidor ----

test("createAuthorityResolver: sin puerto (backend no listo) → foreign, sin llamar a fetch", async () => {
  let fetchCalls = 0;
  const resolver = createAuthorityResolver(async () => { fetchCalls++; throw new Error("must not run"); }, () => undefined);
  assert.equal(await resolver("cowork-x"), "foreign");
  assert.equal(fetchCalls, 0);
});

test("createAuthorityResolver: consulta /api/sessions y devuelve managed/foreign según el kind", async () => {
  const resolver = createAuthorityResolver(
    async () => new Response(JSON.stringify({ sessions: [{ name: "cowork-a", kind: "managed" }, { name: "dev-scratch", kind: "foreign" }] })),
    () => 45678,
  );
  assert.equal(await resolver("cowork-a"), "managed");
  assert.equal(await resolver("dev-scratch"), "foreign");
  assert.equal(await resolver("never-listed"), "foreign");
});

// La invariante que este test debe demostrar es "liberar quita la escritura de inmediato", NO
// "la caché dura 2s" (review 2, D3 NOT-CLOSED): la versión anterior sólo probaba el TTL crudo,
// que un futuro cambio podría romper invalidate() y seguir pasando (el TTL igual expira solo a
// los 2001ms). El dedup de 2s sigue existiendo (es la optimización original — no repetir el
// fetch en ráfagas de `open()`), pero aquí queda como detalle SECUNDARIO: la aserción
// PRINCIPAL es que invalidate() cierra la ventana de escritura al instante, DENTRO del TTL
// (now=500, deliberadamente lejos de los 2000ms), sin depender del reloj para nada.
test("createAuthorityResolver: invalidate() cierra la escritura de inmediato — NUNCA depende de esperar el TTL de 2s", async () => {
  let fetchCalls = 0;
  let now = 0;
  let kind = "managed";
  const resolver = createAuthorityResolver(
    async () => { fetchCalls++; return new Response(JSON.stringify({ sessions: [{ name: "cowork-a", kind }] })); },
    () => 45678,
    () => now,
  );
  // Detalle secundario: dentro de la ventana, sin invalidar, dedup — sigue siendo la optimización real.
  await resolver("cowork-a");
  await resolver("cowork-a");
  assert.equal(fetchCalls, 1, "dedup dentro de la ventana sigue funcionando (optimización original, no la invariante de seguridad)");

  // La sesión se liberó/pasó a foreign — invalidate() debe cerrar la escritura YA, sin esperar
  // el TTL: si esto dependiera de "now >= 2000" en vez de invalidate(), sería la misma ventana
  // insegura que D3 señaló, sólo con otro nombre.
  kind = "foreign";
  resolver.invalidate();
  now = 500; // BIEN dentro de los 2000ms — la invariante no puede depender del reloj
  assert.equal(await resolver("cowork-a"), "foreign", "invalidate() debe forzar un re-fetch inmediato, nunca servir la caché rancia dentro del TTL");
  assert.equal(fetchCalls, 2, "el re-fetch debe haber ocurrido AHORA, no cuando el TTL expire solo");
});

// ---- D3 (bloqueante, hallado en review): el TTL de 2s por sí solo deja hasta 2s de escritura
// permitida sobre una sesión ya liberada/ajena — invalidate() debe cerrar esa ventana. La
// prueba unitaria de invalidate() vive ahora en la aserción PRINCIPAL de arriba (la reescrita),
// no como test aparte — evita dos tests casi idénticos probando lo mismo con dos nombres. ----

test("D3 (review 2, vía alcanzable): {alwaysFresh:true} (dev) desactiva la caché por completo — en dev el fetch del renderer sale por Vite, no por createProtocolHandler, así que invalidate() nunca dispararía", async () => {
  let fetchCalls = 0;
  let kind = "managed";
  const resolver = createAuthorityResolver(
    async () => { fetchCalls++; return new Response(JSON.stringify({ sessions: [{ name: "cowork-a", kind }] })); },
    () => 45678,
    () => 0, // el mismo instante en las tres llamadas — sin alwaysFresh, esto cachearía
    { alwaysFresh: true }
  );
  assert.equal(await resolver("cowork-a"), "managed");
  assert.equal(fetchCalls, 1);
  // Simula un release real llegado por OTRA vía (el proxy de Vite, no createProtocolHandler,
  // que nunca ve esta mutación en dev) — sin caché que invalidar, la SIGUIENTE llamada ya ve lo real.
  kind = "foreign";
  assert.equal(await resolver("cowork-a"), "foreign", "sin caché, la siguiente resolución ya ve el estado real, sin depender de que algo la invalide");
  assert.equal(fetchCalls, 2, "alwaysFresh debe re-consultar en CADA llamada, nunca servir un valor cacheado");
});

test("D3 (review 2): bootstrapDesktop pasa alwaysFresh:true al resolver SOLO cuando dev:true — producción conserva el TTL+invalidate de siempre", async () => {
  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => {}, close: async () => {} };
  const ipcCalls: Array<{ channel: string; handler: (event: { sender: { send(): void } }, payload: unknown) => Promise<unknown> }> = [];
  const ipcMain = { handle: (channel: string, fn: any) => { ipcCalls.push({ channel, handler: fn }); }, removeHandler: () => {} };
  const manager = {
    openReadOnly: () => ({ id: "pty-1", session: "foo", readOnly: true as const }),
    openWritable: () => ({ id: "pty-1", session: "foo", readOnly: false as const }),
    subscribe: () => () => {},
    resize: () => {},
    write: () => {},
    close: () => {},
    closeAll: () => {},
  };
  const sender = { send: () => {} };
  let sessionsFetches = 0;

  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    ipcMain: ipcMain as any,
    ptyManager: manager as any,
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async (url: unknown) => {
      if (String(url).includes("/api/sessions")) {
        sessionsFetches++;
        return new Response(JSON.stringify({ sessions: [{ name: "foo", kind: "managed" }] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    },
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  }, { dev: true });

  const openHandle = ipcCalls.find((c) => c.channel === "terminal.open")!;
  await openHandle.handler({ sender }, { session: "foo", cols: 80, rows: 24 });
  await openHandle.handler({ sender }, { session: "foo", cols: 80, rows: 24 });
  // dev:true ⇒ alwaysFresh ⇒ dos open() consecutivos, sin ningún invalidate(), re-consultan los DOS.
  assert.equal(sessionsFetches, 2, "en dev, cada open() debe re-consultar — nunca depender de que createProtocolHandler invalide algo que en dev no puede ver");
  void handler;
  await controller.shutdown();
});

test("D3 (integración real): tras un DELETE .../adopt reenviado por el protocolo, el open() inmediato siguiente re-consulta en vez de servir la caché de 2s compartida", async () => {
  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => {}, close: async () => {} };
  let sessionsFetches = 0;
  let kind = "managed"; // como si "foo" todavía estuviera adoptada al abrir el handle inicial
  const ipcCalls: Array<{ channel: string; handler: (event: { sender: { send(): void } }, payload: unknown) => Promise<unknown> }> = [];
  const ipcMain = { handle: (channel: string, fn: any) => { ipcCalls.push({ channel, handler: fn }); }, removeHandler: () => {} };
  const manager = {
    openReadOnly: () => ({ id: "pty-1", session: "foo", readOnly: true as const }),
    openWritable: () => ({ id: "pty-1", session: "foo", readOnly: false as const }),
    subscribe: () => () => {},
    resize: () => {},
    write: () => {},
    close: () => {},
    closeAll: () => {},
  };
  const sender = { send: () => {} };

  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    ipcMain: ipcMain as any,
    ptyManager: manager as any,
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async (url: unknown) => {
      const target = String(url);
      if (target.includes("/adopt")) {
        kind = "foreign"; // el servidor real quitaría la marca de inmediato al liberar
        return new Response(JSON.stringify({ ok: true }));
      }
      if (target.includes("/api/sessions")) {
        sessionsFetches++;
        return new Response(JSON.stringify({ sessions: [{ name: "foo", kind }] }));
      }
      return new Response(JSON.stringify({ ok: true }));
    },
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  const openHandle = ipcCalls.find((c) => c.channel === "terminal.open")!;
  assert.ok(openHandle, "installTerminalIpc debe registrar terminal.open");

  // Primer open(): resuelve managed y CACHEA (dentro del TTL de 2s, sin invalidate esto serviría rancio).
  await openHandle.handler({ sender }, { session: "foo", cols: 80, rows: 24 });
  assert.equal(sessionsFetches, 1);

  // El release real pasa por el protocolo (DELETE .../adopt) — debe invalidar la caché compartida.
  const released = await handler!({ url: "app://ronin/api/sessions/foo/adopt", method: "DELETE" });
  assert.equal(released.status, 200);

  // Segundo open() INMEDIATO (mismo instante, mismo TTL de 2s): sin la invalidación esto seguiría
  // devolviendo "managed" desde la caché rancia — con ella, re-consulta y ve "foreign".
  await openHandle.handler({ sender }, { session: "foo", cols: 80, rows: 24 });
  assert.equal(sessionsFetches, 2, "el open() posterior al release debe re-consultar, no servir la caché rancia (D3)");

  await controller.shutdown();
});

test("bootstrap installs only the app handler and creates an isolated window after readiness", async () => {
  const events: string[] = [];
  const webContents = {
    on: () => {},
    setWindowOpenHandler: () => {},
  };
  const window = { webContents, loadURL: async () => { events.push("load"); }, destroy: () => { events.push("destroy"); }, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => { events.push("backend"); }, close: async () => { events.push("close"); } };
  const controller = await bootstrapDesktop({
    protocol: { handle: (scheme) => { events.push(`handle:${scheme}`); } },
    createWindow: (options) => { events.push("window"); assert.deepEqual(options.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, preload: "/preload.js" }); return window as any; },
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  }, { dev: true });
  assert.deepEqual(events, ["handle:app", "window", "backend", "load"]);
  await controller.shutdown();
  assert.deepEqual(events, ["handle:app", "window", "backend", "load", "close", "destroy"]);
});

test("recovery is visible, offers retry, and can request application close", async () => {
  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  let retryCalls = 0;
  let quitCalls = 0;
  const supervisor = {
    port: undefined as number | undefined,
    start: async () => {},
    retry: async () => { retryCalls++; supervisor.port = 45678; },
    close: async () => {},
    recoverySnapshot: () => "backend failed\n",
  };
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    quit: () => { quitCalls++; },
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  }, { dev: false });

  assert.ok(handler);
  const recovery = await handler!({ url: "app://ronin/recovery", method: "GET" });
  const recoveryHtml = await recovery.text();
  assert.match(recoveryHtml, /app:\/\/ronin\/recovery\/retry/);
  assert.match(recoveryHtml, /app:\/\/ronin\/recovery\/close/);
  assert.match(recoveryHtml, /backend failed/);

  const retried = await handler!({ url: "app://ronin/recovery/retry", method: "GET" });
  assert.equal(retried.status, 302);
  assert.equal(retried.headers.get("Location"), "app://ronin/");
  assert.equal(retryCalls, 1);

  await handler!({ url: "app://ronin/recovery/close", method: "GET" });
  assert.equal(quitCalls, 1);
  await controller.shutdown();
});

test("a backend exit navigates the live window to recovery", async () => {
  let onExit: (() => void) | undefined;
  const loads: string[] = [];
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = {
    webContents,
    loadURL: async (url: string) => { loads.push(url); },
    destroy: () => {},
    isDestroyed: () => false,
  };
  const supervisor = {
    port: 45678,
    start: async () => {},
    close: async () => {},
    retry: async () => {},
    recoverySnapshot: () => "crashed",
  };
  const controller = await bootstrapDesktop({
    protocol: { handle: () => {} },
    createWindow: () => window as any,
    createSupervisor: (callback) => { onExit = callback; return supervisor as any; },
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  assert.deepEqual(loads, ["app://ronin/"]);
  onExit?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(loads, ["app://ronin/", "app://ronin/recovery"]);
  await controller.shutdown();
});

test("a startup failure still creates a recoverable window", async () => {
  const loads: string[] = [];
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = {
    webContents,
    loadURL: async (url: string) => { loads.push(url); },
    destroy: () => {},
    isDestroyed: () => false,
  };
  const supervisor = {
    port: undefined,
    start: async () => { throw new Error("backend failed"); },
    close: async () => {},
    retry: async () => {},
    recoverySnapshot: () => "startup diagnostic",
  };
  const controller = await bootstrapDesktop({
    protocol: { handle: () => {} },
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  assert.deepEqual(loads, ["app://ronin/recovery"]);
  await controller.shutdown();
});

test("protocol handler preserves a live SSE body instead of buffering it", async () => {
  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: live\\n\\n"));
      // Deliberately stay open like /api/stream does.
    },
  });
  const upstream = new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => {}, close: async () => {} };

  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => upstream,
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  assert.ok(handler);
  const response = await Promise.race([
    handler!({ url: "app://ronin/api/stream", method: "GET" }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE response was buffered")), 100)),
  ]);
  assert.equal(response.headers.get("Content-Security-Policy"), "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:*; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'");
  assert.ok(response.body);
  const first = await response.body!.getReader().read();
  assert.equal(new TextDecoder().decode(first.value), "data: live\\n\\n");
  await controller.shutdown();
});

test("injects the capability header read from disk, per request, without the renderer ever seeing it", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cowork-bootstrap-capability-"));
  const capabilityFile = join(dir, "capability-token");
  try {
    let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
    const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
    const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
    const supervisor = { port: 45678, start: async () => {}, close: async () => {} };
    const seenHeaders: Array<Record<string, string> | undefined> = [];
    const controller = await bootstrapDesktop({
      protocol: { handle: (_scheme, next) => { handler = next; } },
      createWindow: () => window as any,
      createSupervisor: () => supervisor as any,
      shell: { openExternal: () => {} },
      capabilityFile,
      fetch: async (_url, requestOptions) => {
        seenHeaders.push((requestOptions as { headers?: Record<string, string> } | undefined)?.headers);
        return new Response(JSON.stringify({ ok: true }));
      },
      readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
      distDir: "/tmp/dist", preloadPath: "/preload.js",
    });

    await handler!({ url: "app://ronin/api/workflow", method: "PUT", headers: { "content-type": "application/json" } });
    assert.equal(seenHeaders[0]?.["x-ronin-capability"], undefined, "sin archivo aún no debe mandar cabecera");

    writeFileSync(capabilityFile, "the-token", { mode: 0o600 });
    await handler!({ url: "app://ronin/api/workflow", method: "PUT", headers: { "content-type": "application/json" } });
    assert.equal(seenHeaders[1]?.["x-ronin-capability"], "the-token");

    await controller.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves the request's own headers (Content-Type included) when injecting the capability header (T9, bug real)", async () => {
  // Bug real: `protocol.handle` de Electron entrega `request.headers` como una instancia REAL
  // de `Headers` (WHATWG), no un objeto plano — todos los tests de arriba pasaban un objeto
  // literal (`{ "content-type": "application/json" }`), que nunca habría revelado esto.
  // `{ ...request.headers }` sobre una `Headers` real produce `{}` (Headers no expone sus
  // pares como propiedades enumerables propias) — se perdía el Content-Type en cada mutación
  // que necesitaba la cabecera de capability, Express nunca parseaba el body, y el endpoint de
  // turno actuaba como si el body viniera vacío. Verificado en vivo: POST .../keys respondía
  // 200 {"ok":true} (la capability sí llegaba) pero el pane nunca recibía las teclas porque
  // `req.body` llegaba `{}` al backend.
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cowork-bootstrap-headers-"));
  const capabilityFile = join(dir, "capability-token");
  writeFileSync(capabilityFile, "the-token", { mode: 0o600 });
  try {
    let handler: ((request: { url: string; method: string; headers?: unknown; body?: unknown }) => Promise<Response>) | undefined;
    const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
    const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
    const supervisor = { port: 45678, start: async () => {}, close: async () => {} };
    let seenHeaders: Record<string, string> | undefined;
    const controller = await bootstrapDesktop({
      protocol: { handle: (_scheme, next) => { handler = next as any; } },
      createWindow: () => window as any,
      createSupervisor: () => supervisor as any,
      shell: { openExternal: () => {} },
      capabilityFile,
      fetch: async (_url, requestOptions) => {
        seenHeaders = (requestOptions as { headers?: Record<string, string> } | undefined)?.headers;
        return new Response(JSON.stringify({ ok: true }));
      },
      readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
      distDir: "/tmp/dist", preloadPath: "/preload.js",
    });

    await handler!({
      url: "app://ronin/api/workflow",
      method: "PUT",
      headers: new Headers({ "content-type": "application/json", "x-custom-test": "abc" }),
    });

    assert.equal(seenHeaders?.["content-type"], "application/json", "el Content-Type original no debe perderse");
    assert.equal(seenHeaders?.["x-custom-test"], "abc", "ninguna cabecera original debe perderse");
    assert.equal(seenHeaders?.["x-ronin-capability"], "the-token", "la capability sigue inyectándose");

    await controller.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not send an undefined body with a GET request to Electron net.fetch", async () => {
  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  let options: Record<string, unknown> | undefined;
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => {}, close: async () => {} };

  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async (_url, requestOptions) => {
      options = requestOptions;
      return new Response(JSON.stringify({ ok: true }));
    },
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  await handler!({ url: "app://ronin/api/health", method: "GET" });
  assert.equal("body" in options!, false);
  await controller.shutdown();
});

test("forwards a POST body through Electron's real net.fetch (T9, bug real: falta duplex:'half')", async () => {
  // Bug real, encontrado en vivo con el E2E de T9 (POST .../keys devolvía 503 "Backend
  // unavailable"). `protocol.handle` de Electron entrega `request.body` como un
  // ReadableStream real (WHATWG Request), y el fetch de Node/Chromium (igual que
  // `electron.net.fetch` en producción) EXIGE `duplex: "half"` cuando el body es un stream —
  // sin eso lanza un TypeError que el `catch` genérico del proxy convertía, en silencio, en un
  // 503 "Backend unavailable" indistinguible de un backend caído. Un `fetch` simulado (como en
  // los tests de arriba) nunca exige `duplex`, así que esto necesita el fetch REAL de Node
  // contra un servidor HTTP real para reproducirse.
  const { createServer } = await import("node:http");
  const upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ receivedBody: body }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;

  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port, start: async () => {}, close: async () => {} };
  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: (url, options) => fetch(url as string, options as RequestInit),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  try {
    const payload = JSON.stringify({ text: "echo E2E_INPUT_OK", submit: true });
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    const response = await handler!({
      url: "app://ronin/api/sessions/x/panes/%251/keys",
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (response.status !== 200) assert.fail(`esperaba 200, llegó ${response.status} (${await response.text()})`);
    assert.deepEqual(await response.json(), { receivedBody: payload });
  } finally {
    await controller.shutdown();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("protocol handler turns a backend fetch failure into a 503 response", async () => {
  let handler: ((request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>) | undefined;
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => {}, close: async () => {}, retry: async () => {}, recoverySnapshot: () => "" };
  const controller = await bootstrapDesktop({
    protocol: { handle: (_scheme, next) => { handler = next; } },
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => { throw new Error("ECONNREFUSED"); },
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  const response = await handler!({ url: "app://ronin/api/state", method: "GET" });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Backend unavailable");
  await controller.shutdown();
});

test("installs terminal IPC before the window and closes PTYs during shutdown", async () => {
  const events: string[] = [];
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const window = { webContents, loadURL: async () => { events.push("load"); }, destroy: () => { events.push("destroy"); }, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => { events.push("backend"); }, close: async () => { events.push("backend-close"); } };
  const ipcMain = {
    handle: (channel: string) => { events.push(`ipc:${channel}`); },
    removeHandler: (channel: string) => { events.push(`ipc-remove:${channel}`); },
  };
  const ptyManager = { closeAll: () => { events.push("pty-close"); } };
  const controller = await bootstrapDesktop({
    protocol: { handle: (scheme) => { events.push(`handle:${scheme}`); } },
    ipcMain: ipcMain as any,
    ptyManager: ptyManager as any,
    createWindow: () => { events.push("window"); return window as any; },
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  assert.deepEqual(events.slice(0, 7), [
    "handle:app",
    "ipc:terminal.open",
    "ipc:terminal.resize",
    "ipc:terminal.write",
    "ipc:terminal.close",
    "window",
    "backend",
  ]);
  await controller.shutdown();
  assert.ok(events.includes("pty-close"));
  assert.ok(events.includes("destroy"));
  assert.ok(events.includes("backend-close"));
});

test("closes a renderer's PTYs the moment its webContents is destroyed, without waiting for app shutdown", async () => {
  const listeners = new Map<string, () => void>();
  const webContents = {
    on: () => {},
    once: (event: string, listener: () => void) => { listeners.set(event, listener); },
    setWindowOpenHandler: () => {},
    isDestroyed: () => false,
    send: () => {},
  };
  const window = { webContents, loadURL: async () => {}, destroy: () => {}, isDestroyed: () => false };
  const supervisor = { port: 45678, start: async () => {}, close: async () => {} };
  let openHandler: ((event: unknown, payload: unknown) => unknown) | undefined;
  const closedIds: string[] = [];
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
      if (channel === "terminal.open") openHandler = listener;
    },
    removeHandler: () => {},
  };
  const ptyManager = {
    openReadOnly: () => ({ id: "pty-1", session: "cowork-safe", readOnly: true as const }),
    subscribe: () => () => {},
    close: (id: string) => { closedIds.push(id); },
    closeAll: () => {},
  };
  const controller = await bootstrapDesktop({
    protocol: { handle: () => {} },
    ipcMain: ipcMain as any,
    ptyManager: ptyManager as any,
    createWindow: () => window as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  });

  await openHandler!({ sender: webContents }, { session: "cowork-safe", cols: 120, rows: 40 });
  assert.equal(closedIds.length, 0);
  listeners.get("destroyed")!();
  assert.deepEqual(closedIds, ["pty-1"]);
  await controller.shutdown();
});
