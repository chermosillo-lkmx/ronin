import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TERMINAL_IPC_CHANNELS } from "../main/ipc.js";

test("preload exposes only the typed terminal bridge through context isolation", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /contextBridge\.exposeInMainWorld\("roninDesktop"/);
  assert.match(source, /terminal:/);
  assert.match(source, /TERMINAL_IPC_CHANNELS\.open/);
  assert.match(source, /TERMINAL_IPC_CHANNELS\.write/);
  assert.doesNotMatch(source, /nodeIntegration/);
  assert.doesNotMatch(source, /require\(/);
});

// P6 (verificado en vivo): `desktop/dist/preload/index.js:4` era `require("../main/ipc.js")`.
// El test de arriba sólo mira el `.ts` FUENTE (que nunca tiene `require(` porque usa `import`)
// y por eso nunca detectó el bug: bajo `sandbox: true`, Electron no deja que el preload haga
// `require()` de un archivo local, así que el bridge entero se caía en silencio. La comprobación
// real tiene que ser sobre el COMPILADO.
test("el preload COMPILADO no requiere ningún archivo local (cargaría bajo sandbox:true)", () => {
  const compiled = readFileSync(new URL("../dist/preload/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(compiled, /require\("\.\./);
});

test("paridad: los 6 literales de canal copiados a mano en el preload coinciden con TERMINAL_IPC_CHANNELS de ipc.ts", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const match = source.match(/const TERMINAL_IPC_CHANNELS = \{([\s\S]*?)\} as const;/);
  assert.ok(match, "preload debe declarar TERMINAL_IPC_CHANNELS localmente");
  const preloadChannels: Record<string, string> = {};
  for (const line of match![1]!.split("\n")) {
    const entry = line.match(/(\w+):\s*"([^"]+)"/);
    if (entry) preloadChannels[entry[1]!] = entry[2]!;
  }
  assert.deepEqual(preloadChannels, TERMINAL_IPC_CHANNELS);
});
