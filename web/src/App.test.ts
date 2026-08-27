import assert from "node:assert/strict";
import test from "node:test";
import { APP_VIEWS } from "./App.js";

test("App declares exactly the retained views", () => {
  assert.deepEqual(APP_VIEWS, ["sessions", "settings", "reports", "preflight", "workflow", "tests", "skills"]);
});
