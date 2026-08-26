import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveCapabilityFile } from "./capability-path.js";

test("dev, sin override: la ruta cae en <root>/server/data/capability-token, igual que BUNDLED_DATA_DIR", () => {
  const file = resolveCapabilityFile({ root: "/repo", isPackaged: false });
  assert.equal(file, join("/repo", "server", "data", "capability-token"));
});

test("dev con COWORK_DATA_DIR puesto: lo respeta igual que resolveDataDirectory", () => {
  const file = resolveCapabilityFile({ root: "/repo", isPackaged: false, dataDirOverride: "/custom/data" });
  assert.equal(file, join("/custom/data", "capability-token"));
});

test("empaquetado sin override: usa <userData>/data, igual que index.ts fuerza para el hijo", () => {
  const file = resolveCapabilityFile({ root: "/app.asar", isPackaged: true, userDataPath: "/Users/x/Library/Ronin" });
  assert.equal(file, join("/Users/x/Library/Ronin", "data", "capability-token"));
});

test("empaquetado CON override: el override gana (mismo criterio que el fork del backend)", () => {
  const file = resolveCapabilityFile({ root: "/app.asar", isPackaged: true, userDataPath: "/Users/x/Library/Ronin", dataDirOverride: "/custom/data" });
  assert.equal(file, join("/custom/data", "capability-token"));
});
