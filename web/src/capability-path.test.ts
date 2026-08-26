import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveWebCapabilityFile } from "./capability-path.js";
import { CAPABILITY_FILE } from "../../server/src/capability.js";

const webPackageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("paridad (12f): la ruta calculada en vite.config.ts coincide byte a byte con CAPABILITY_FILE del server", () => {
  assert.equal(resolveWebCapabilityFile(webPackageDir, undefined), CAPABILITY_FILE);
});

test("respeta COWORK_DATA_DIR si está puesto, igual que resolveDataDirectory", () => {
  assert.equal(resolveWebCapabilityFile(webPackageDir, "/custom/data"), join("/custom/data", "capability-token"));
});
