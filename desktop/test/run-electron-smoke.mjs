import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildElectronLaunchSpec } from "../electron-launcher.mjs";

const require = createRequire(import.meta.url);

// M5/T9: aislado de verdad — socket propio y desechable, nunca el `default` donde vive esta
// orquestación (tmux-worker-loop). `env -u TMUX` evita que tmux se niegue a anidar en silencio
// cuando este proceso ya corre dentro de una sesión tmux.
// `/var/folders/.../T` can be private to a sandboxed parent while the Electron child is
// launched by macOS separately. `/tmp` is shared by the same user and is removed in cleanup.
const socketDir = mkdtempSync("/tmp/ronin-e2e-tmux-");
const SOCKET = join(socketDir, "tmux.sock");
const WINDOW_SESSION = "cowork-smoke-window";
const PANE_SESSION = "cowork-smoke-pane";
const cycleDirs = [`/tmp/cowork-cycle-${WINDOW_SESSION}`, `/tmp/cowork-cycle-${PANE_SESSION}`];

function tmuxEnv() {
  const env = { ...process.env };
  delete env.TMUX;
  return env;
}

function tmux(...args) {
  return execFileSync("tmux", ["-S", SOCKET, ...args], { env: tmuxEnv(), encoding: "utf8" });
}

function skip(reason) {
  console.error(`RONIN_SMOKE:SKIP ${reason}`);
  process.exitCode = 1; // un skip NUNCA se lee como pass
}

function tmuxAvailable() {
  try {
    execFileSync("tmux", ["-V"], { env: tmuxEnv() });
    return true;
  } catch {
    return false;
  }
}

if (!tmuxAvailable()) {
  skip("tmux ausente");
} else {
  runSmokeWithFixtures();
}

function runSmokeWithFixtures() {
  // Fixture: ventana completa (managed, para poder escribir) — cowork- + cycle dir.
  tmux("new-session", "-d", "-s", WINDOW_SESSION, "-x", "80", "-y", "24", "sh");
  mkdirSync(join(cycleDirs[0], "evidence"), { recursive: true });

  // Fixture: pane-scoped (managed, 2 panes) — marcadores distintos escritos FUERA de Ronin.
  tmux("new-session", "-d", "-s", PANE_SESSION, "-x", "80", "-y", "24", "sh");
  mkdirSync(join(cycleDirs[1], "evidence"), { recursive: true });
  const paneB = tmux("split-window", "-t", PANE_SESSION, "-P", "-F", "#{pane_id}").trim();
  const paneAList = tmux("list-panes", "-t", PANE_SESSION, "-F", "#{pane_id}").trim().split("\n");
  const paneA = paneAList.find((id) => id !== paneB);
  tmux("send-keys", "-t", paneA, "-l", "echo E2E_PANE_A");
  tmux("send-keys", "-t", paneA, "Enter");
  tmux("send-keys", "-t", paneB, "-l", "echo E2E_PANE_B");
  tmux("send-keys", "-t", paneB, "Enter");

  const require_ = createRequire(import.meta.url);
  const electron = require_("electron");
  const resultDir = mkdtempSync("/tmp/ronin-electron-smoke-");
  const resultFile = join(resultDir, "result.json");
  const entry = fileURLToPath(new URL("../dist/main/index.js", import.meta.url));
  const spec = buildElectronLaunchSpec({
    platform: process.platform,
    electronPath: electron,
    entry,
    args: ["--smoke", `--smoke-result=${resultFile}`, `--tmux-socket=${SOCKET}`],
  });
  const child = spawn(spec.command, spec.args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, 60_000);

  const cleanup = () => {
    try { tmux("kill-server"); } catch { /* ya pudo haber muerto */ }
    for (const dir of cycleDirs) rmSync(dir, { recursive: true, force: true });
    rmSync(resultDir, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  };

  child.on("error", (error) => {
    clearTimeout(timeout);
    console.error(`RONIN_SMOKE:FAIL ${error.message}`);
    cleanup();
    process.exitCode = 1;
  });

  child.on("close", (code) => {
    clearTimeout(timeout);
    let result;
    try { result = JSON.parse(readFileSync(resultFile, "utf8")); } catch { result = undefined; }

    // Prueba de mayor valor del ciclo (§9 del plan): la ventana completa cerró su PTY cliente,
    // pero la SESIÓN sigue viva — cerrar nunca debe matar tmux.
    let windowSessionSurvived = false;
    try {
      tmux("has-session", "-t", WINDOW_SESSION);
      windowSessionSurvived = true;
    } catch {
      windowSessionSurvived = false;
    }

    cleanup();

    if (!timedOut && code === 0 && result?.status === "pass" && windowSessionSurvived) return;
    console.error(`RONIN_SMOKE:FAIL${result?.error ? ` ${result.error}` : ""}${!windowSessionSurvived ? " (la sesión de la ventana no sobrevivió al close)" : ""}`);
    if (output.trim()) console.error(output.trim());
    process.exitCode = 1;
  });
}
