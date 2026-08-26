import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DEFAULT_PORT, InvalidPortError, isValidPort, resolvePort } from "./port.js";

test("rejects an unsafe PORT at the configuration boundary", () => {
  const configUrl = new URL("./config.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", `import(${JSON.stringify(configUrl)})`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PORT: "80" },
    },
  );

  assert.notEqual(result.status, 0, "an unsafe PORT must prevent startup");
  assert.match(`${result.stderr}${result.stdout}`, /INVALID_PORT/);
});

test("resolvePort accepts only configured safe integer ports", () => {
  assert.equal(resolvePort(undefined), DEFAULT_PORT);
  assert.equal(resolvePort("1024"), 1024);
  assert.equal(resolvePort("65535"), 65535);
  assert.equal(isValidPort(1024), true);
  assert.equal(isValidPort(65535), true);

  for (const value of ["", "NaN", "8787.5", "0", "1023", "65536", "text"]) {
    assert.throws(
      () => resolvePort(value),
      (error: unknown) => error instanceof InvalidPortError && error.code === "INVALID_PORT",
    );
  }
});
