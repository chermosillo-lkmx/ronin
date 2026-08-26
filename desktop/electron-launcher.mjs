import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function electronAppBundle(electronPath) {
  const marker = "/Contents/MacOS/";
  const markerIndex = electronPath.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error(`Invalid Electron macOS executable path: ${electronPath}`);
  const appRoot = electronPath.slice(0, markerIndex);
  return appRoot.endsWith(".app") ? appRoot : `${appRoot}.app`;
}

export function buildElectronLaunchSpec({ platform, electronPath, entry, args = [] }) {
  if (platform === "darwin") {
    return {
      command: "/usr/bin/open",
      args: ["-W", "-n", electronAppBundle(electronPath), "--args", entry, ...args],
    };
  }
  return { command: electronPath, args: [entry, ...args] };
}

export function spawnElectron({ platform = process.platform, electronPath, entry, args = [], env = process.env, stdio = "inherit" }) {
  const spec = buildElectronLaunchSpec({ platform, electronPath, entry, args });
  return spawn(spec.command, spec.args, { env, stdio });
}

function terminateLaunchedElectron(electronPath, entry, signal) {
  if (process.platform !== "darwin") return;
  const result = spawnSync("/usr/bin/pgrep", ["-f", `${electronPath} ${entry}`], { encoding: "utf8" });
  for (const value of (result.stdout ?? "").trim().split(/\s+/)) {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try { process.kill(pid, signal); } catch { /* The app may have already exited. */ }
    }
  }
}

export function launchElectron({ platform = process.platform, electronPath, entry, args = [] }) {
  const child = spawnElectron({ platform, electronPath, entry, args });
  const forwardSignal = (signal) => {
    terminateLaunchedElectron(electronPath, entry, signal);
    child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  child.once("close", (code) => {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
    process.exit(code ?? 1);
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const entry = process.argv[2];
  if (!entry) {
    console.error("Usage: node desktop/electron-launcher.mjs <entry> [args...]");
    process.exit(2);
  }
  const electronPath = require("electron");
  launchElectron({ electronPath, entry: resolve(dirname(process.argv[1]), "..", entry), args: process.argv.slice(3) });
}
