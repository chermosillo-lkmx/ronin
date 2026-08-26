import test from "node:test";
import assert from "node:assert/strict";
import { buildElectronLaunchSpec } from "../electron-launcher.mjs";

test("uses LaunchServices for Electron on macOS", () => {
  assert.deepEqual(
    buildElectronLaunchSpec({
      platform: "darwin",
      electronPath: "/workspace/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      entry: "desktop/dist/main/index.js",
      args: ["--dev"],
    }),
    {
      command: "/usr/bin/open",
      args: [
        "-W",
        "-n",
        "/workspace/node_modules/electron/dist/Electron.app",
        "--args",
        "desktop/dist/main/index.js",
        "--dev",
      ],
    },
  );
});

test("executes Electron directly on non-macOS platforms", () => {
  assert.deepEqual(
    buildElectronLaunchSpec({
      platform: "linux",
      electronPath: "/workspace/node_modules/electron/electron",
      entry: "desktop/dist/main/index.js",
      args: ["--smoke"],
    }),
    {
      command: "/workspace/node_modules/electron/electron",
      args: ["desktop/dist/main/index.js", "--smoke"],
    },
  );
});
