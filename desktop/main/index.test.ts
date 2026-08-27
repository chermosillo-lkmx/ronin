import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { backendEnvironment, resolveDesktopRoot, shouldStartElectronMain, startMain } from "./index.js";

test("detects Electron's browser main process even when require.main is Electron", () => {
  assert.equal(shouldStartElectronMain({ electron: "43.2.0" }, "browser"), true);
  assert.equal(shouldStartElectronMain({}, "browser"), false);
  assert.equal(shouldStartElectronMain({ electron: "43.2.0" }, "renderer"), false);
});

test("runtime assets resolve from Electron's app path when packaged", () => {
  assert.equal(resolveDesktopRoot("/Applications/Ronin.app/Contents/Resources/app.asar", "/tmp/launcher"), "/Applications/Ronin.app/Contents/Resources/app.asar");
  assert.equal(resolveDesktopRoot(undefined, "/tmp/launcher"), "/tmp/launcher");
});

test("propagates the resolved tmux binary to the backend environment", () => {
  const env = backendEnvironment(
    { PATH: "/usr/bin:/bin", COWORK_TMUX_SOCKET: "isolated" },
    { tmuxBinary: "/opt/homebrew/bin/tmux", dataDir: "/data" },
  );

  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    COWORK_TMUX_SOCKET: "isolated",
    COWORK_TMUX_BIN: "/opt/homebrew/bin/tmux",
    COWORK_DATA_DIR: "/data",
  });
});

test("propaga el binario ttyd resuelto al entorno del backend", () => {
  const env = backendEnvironment(
    { PATH: "/usr/bin:/bin" },
    { tmuxBinary: "/opt/homebrew/bin/tmux", ttydBinary: "/opt/homebrew/bin/ttyd" },
  );

  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    COWORK_TMUX_BIN: "/opt/homebrew/bin/tmux",
    COWORK_TTYD_BIN: "/opt/homebrew/bin/ttyd",
  });
});

test("no inyecta COWORK_TTYD_BIN cuando no se resolvió", () => {
  const env = backendEnvironment({ PATH: "/usr/bin:/bin" }, {});

  assert.equal(env.COWORK_TTYD_BIN, undefined);
});

test("desktop tooling exposes the focused Electron test command", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts?.["test:desktop"],
    "node --import tsx --test desktop/main/backend-supervisor.test.ts desktop/main/renderer-readiness.test.ts desktop/main/window-security.test.ts desktop/main/pty.test.ts desktop/main/ipc.test.ts desktop/main/session-name.test.ts desktop/main/capability-path.test.ts desktop/main/smoke.test.ts desktop/main/bootstrap.test.ts desktop/main/app-protocol.test.ts desktop/main/tmux-path.test.ts desktop/main/ttyd-path.test.ts desktop/main/index.test.ts desktop/preload/index.test.ts desktop/test/electron-launcher.test.mjs",
  );
});

test("startMain registers the privileged scheme before ready and installs the handler only after", async () => {
  const events: string[] = [];
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const starting = startMain({
    app: { whenReady: () => { events.push("whenReady"); return ready; }, quit: () => {} },
    protocol: {
      registerSchemesAsPrivileged: (schemes) => {
        events.push("register");
        assert.deepEqual(schemes, [{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false } }]);
      },
      handle: (scheme) => { events.push(`handle:${scheme}`); },
    },
    createWindow: () => ({ webContents, loadURL: async () => { events.push("load"); }, destroy: () => {}, isDestroyed: () => false }) as any,
    createSupervisor: () => ({ port: 45678, start: async () => { events.push("backend"); }, close: async () => {} }) as any,
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  }, []);
  await Promise.resolve();
  assert.deepEqual(events, ["register", "whenReady"]);
  releaseReady();
  await starting;
  assert.deepEqual(events, ["register", "whenReady", "handle:app", "backend", "load"]);
});

test("startMain delegates --smoke to one production smoke runner", async () => {
  let smokeCalls = 0;
  await startMain({
    app: { whenReady: async () => {}, quit: () => {} },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
    createWindow: () => { throw new Error("smoke must not create a second bootstrap"); },
    createSupervisor: () => { throw new Error("smoke must own bootstrap"); },
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
    runSmoke: async () => { smokeCalls++; },
  }, ["--smoke"]);
  assert.equal(smokeCalls, 1);
});

test("startMain closes the backend before allowing the application to quit", async () => {
  const listeners = new Map<string, (event?: { preventDefault(): void }) => void>();
  const events: string[] = [];
  const app = {
    whenReady: async () => {},
    quit: () => { events.push("quit"); },
    on: (event: string, listener: (value?: { preventDefault(): void }) => void) => { listeners.set(event, listener); },
  };
  const webContents = { on: () => {}, setWindowOpenHandler: () => {} };
  const supervisor = { port: 45678, start: async () => { events.push("backend"); }, close: async () => { events.push("close"); } };
  const controller = await startMain({
    app: app as any,
    protocol: { registerSchemesAsPrivileged: () => {}, handle: (scheme) => { events.push(`handle:${scheme}`); } },
    createWindow: () => ({ webContents, loadURL: async () => { events.push("load"); }, destroy: () => { events.push("destroy"); }, isDestroyed: () => false }) as any,
    createSupervisor: () => supervisor as any,
    shell: { openExternal: () => {} },
    fetch: async () => new Response("ok"),
    readiness: { fetch: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" } }), sleep: async () => {}, now: () => 0 },
    distDir: "/tmp/dist", preloadPath: "/preload.js",
  }, []);

  assert.ok(controller);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("before-quit")!(event);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(event.prevented, true);
  assert.deepEqual(events, ["handle:app", "backend", "load", "close", "destroy", "quit"]);
});
