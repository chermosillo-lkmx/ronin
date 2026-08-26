import assert from "node:assert/strict";
import test from "node:test";
import { dataPath, resolveDataDirectory } from "./data-dir.js";

test("data directory can move out of a packaged asar without changing file names", () => {
  const userData = "/Users/test/Library/Application Support/Ronin/data";
  assert.equal(resolveDataDirectory(userData, "/app.asar/server/data"), userData);
  assert.equal(resolveDataDirectory("", "/app.asar/server/data"), "/app.asar/server/data");
  assert.equal(dataPath("workflow.json", userData), `${userData}/workflow.json`);
});
