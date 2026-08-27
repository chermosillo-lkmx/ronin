import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { bootstrapDesktop, type DesktopController, type DesktopDependencies } from "./bootstrap.js";
import { resolveCapabilityFile } from "./capability-path.js";
import { createBackendSupervisor } from "./backend-supervisor.js";
import { createPtyManager } from "./pty.js";
import { runSmoke } from "./smoke.js";
import { resolveLoginPath } from "./login-path.js";
import { resolveBinary, resolveTmuxBinary } from "./tmux-path.js";

export interface MainApp {
  whenReady(): Promise<void>;
  quit(): void;
  getAppPath?(): string;
  getPath?(name: "userData"): string;
  isPackaged?: boolean;
  exit?(code: number): void;
  on?(event: "before-quit" | "window-all-closed", listener: (event?: { preventDefault(): void }) => void): unknown;
}

export interface SchemeProtocol {
  registerSchemesAsPrivileged(schemes: Array<{ scheme: string; privileges: Record<string, boolean> }>): void;
}

export interface MainDependencies extends Omit<DesktopDependencies, "protocol"> {
  app: MainApp;
  protocol: DesktopDependencies["protocol"] & SchemeProtocol;
  runSmoke?: (deps: DesktopDependencies, options?: { resultFile?: string }) => Promise<void>;
}

export function resolveDesktopRoot(appPath: string | undefined, cwd: string): string {
  return appPath?.trim() || cwd;
}

export function backendEnvironment(
  base: NodeJS.ProcessEnv,
  options: { tmuxBinary?: string; ttydBinary?: string; dataDir?: string; tmuxSocket?: string; resolvedPath?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (base.COWORK_PATH !== undefined) env.PATH = base.COWORK_PATH;
  else if (options.resolvedPath !== undefined) env.PATH = options.resolvedPath;
  if (options.dataDir) env.COWORK_DATA_DIR = options.dataDir;
  if (options.tmuxBinary) env.COWORK_TMUX_BIN = options.tmuxBinary;
  if (options.ttydBinary) env.COWORK_TTYD_BIN = options.ttydBinary;
  if (options.tmuxSocket) env.COWORK_TMUX_SOCKET = options.tmuxSocket;
  return env;
}

export function shouldStartElectronMain(versions: { electron?: string }, processType?: string): boolean {
  return Boolean(versions.electron) && (processType === undefined || processType === "browser");
}

let schemeRegistered = false;

export function registerAppScheme(protocol: SchemeProtocol): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false },
  }]);
}

export async function startMain(deps: MainDependencies, argv: string[] = process.argv): Promise<DesktopController | void> {
  if (!schemeRegistered) {
    registerAppScheme(deps.protocol);
    schemeRegistered = true;
  }
  await deps.app.whenReady();
  const desktopDeps: DesktopDependencies = {
    protocol: deps.protocol,
    ipcMain: deps.ipcMain,
    ptyManager: deps.ptyManager,
    createWindow: deps.createWindow,
    createSupervisor: deps.createSupervisor,
    shell: deps.shell,
    quit: () => deps.app.quit(),
    fetch: deps.fetch,
    readiness: deps.readiness,
    distDir: deps.distDir,
    preloadPath: deps.preloadPath,
    capabilityFile: deps.capabilityFile,
  };
  if (argv.includes("--smoke")) {
    if (!deps.runSmoke) throw new Error("RONIN_SMOKE_UNAVAILABLE");
    const resultArg = argv.find((argument) => argument.startsWith("--smoke-result="));
    await deps.runSmoke(desktopDeps, resultArg ? { resultFile: resultArg.slice("--smoke-result=".length) } : undefined);
    return;
  }
  const controller = await bootstrapDesktop(desktopDeps, { dev: argv.includes("--dev") });
  let quitting = false;
  deps.app.on?.("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event?.preventDefault();
    void controller.shutdown().finally(() => deps.app.quit());
  });
  deps.app.on?.("window-all-closed", () => {
    if (process.platform !== "darwin") deps.app.quit();
  });
  return controller;
}

if (shouldStartElectronMain(process.versions, (process as NodeJS.Process & { type?: string }).type)) {
  const electron = require("electron") as unknown as {
    app: MainApp;
    protocol: MainDependencies["protocol"];
    ipcMain: any;
    BrowserWindow: new (options: Parameters<DesktopDependencies["createWindow"]>[0]) => DesktopDependencies extends { createWindow: (...args: infer Args) => infer Result } ? Result : never;
    utilityProcess: { fork(entry: string, options: { stdio: "pipe"; env: NodeJS.ProcessEnv }): ReturnType<typeof createBackendSupervisor> extends { [key: string]: unknown } ? any : never };
    shell: DesktopDependencies["shell"];
    net: { fetch(url: string, options?: Record<string, unknown>): Promise<Response> };
  };
  const root = electron.app.isPackaged
    ? resolveDesktopRoot(electron.app.getAppPath?.(), process.cwd())
    : join(__dirname, "..", "..", "..");
  const readiness = {
    fetch: (url: string, options: { cache: "no-store" }) => fetch(url, options),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
  // T9 (M5): en macOS este proceso se lanza vía `open -W -n App.app --args …`
  // (electron-launcher.mjs), y `open` NO garantiza heredar el entorno del proceso que lo
  // invocó — a diferencia de un `spawn` directo. Por eso el socket aislado del E2E viaja
  // como ARGUMENTO de CLI (mismo patrón que `--smoke-result=`), nunca como env var que
  // `run-electron-smoke.mjs` pondría en su propio `process.env` esperando que "se herede".
  void (async () => {
    const resolvedPath = await resolveLoginPath({ env: process.env });
    const tmuxSocketArg = process.argv.find((argument) => argument.startsWith("--tmux-socket="));
    const tmuxSocket = tmuxSocketArg?.slice("--tmux-socket=".length);
    const tmuxBinary = resolveTmuxBinary({ env: process.env });
    const ttydBinary = resolveBinary({ binary: "ttyd", environmentVariable: "COWORK_TTYD_BIN", env: process.env });
    const desktopDataDir = electron.app.isPackaged && electron.app.getPath && !process.env.COWORK_DATA_DIR
      ? join(electron.app.getPath("userData"), "data")
      : undefined;
    const dependencies: MainDependencies = {
    app: electron.app,
    protocol: electron.protocol,
    ipcMain: electron.ipcMain,
    ptyManager: createPtyManager({ tmuxBinary, tmuxSocket, env: process.env }),
    createWindow: (options) => new electron.BrowserWindow(options),
    createSupervisor: (onExit) => createBackendSupervisor({
      fork: electron.utilityProcess.fork,
      entry: join(root, "server", "dist", "server-entry.js"),
      env: backendEnvironment(process.env, { tmuxBinary, ttydBinary, dataDir: desktopDataDir, tmuxSocket, resolvedPath }),
      onExit,
    }),
    shell: electron.shell,
    fetch: (url, options) => electron.net.fetch(url, options),
    readiness,
    distDir: join(root, "web", "dist"),
    preloadPath: join(__dirname, "..", "preload", "index.js"),
    capabilityFile: resolveCapabilityFile({
      root,
      isPackaged: electron.app.isPackaged === true,
      userDataPath: electron.app.isPackaged && electron.app.getPath ? electron.app.getPath("userData") : undefined,
      dataDirOverride: process.env.COWORK_DATA_DIR,
    }),
    runSmoke: (desktopDeps, options) => runSmoke(desktopDeps, { exit: (code) => electron.app.exit?.(code), ...options }),
    };
    await startMain(dependencies);
  })().catch((error) => {
    const resultArg = process.argv.find((argument) => argument.startsWith("--smoke-result="));
    if (resultArg) {
      try {
        writeFileSync(resultArg.slice("--smoke-result=".length), JSON.stringify({ status: "fail", error: error instanceof Error ? error.message : String(error) }), "utf8");
      } catch {
        // The smoke result is diagnostic only; the process exit code remains authoritative.
      }
    }
    process.exitCode = 1;
  });
}
