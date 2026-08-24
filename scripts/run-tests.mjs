#!/usr/bin/env node
// Entrada para terminal/CI del test harness de Ronin. Construye el server (salvo
// RONIN_SKIP_BUILD=1) y delega en el CLI compilado. No arranca Claude/Codex ni el server HTTP.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "server", "dist", "test-harness", "cli-entry.js");
const args = process.argv.slice(2);

if (process.env.RONIN_SKIP_BUILD !== "1" || !existsSync(cli)) {
  const build = spawnSync("npm", ["run", "build:server", "--silent"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const run = spawnSync(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
