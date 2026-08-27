import assert from "node:assert/strict";
import test from "node:test";
import { APP_VIEWS } from "./App.js";

test("App declares skills and workflow views", () => {
  assert.ok(APP_VIEWS.includes("skills"));
  assert.ok(APP_VIEWS.includes("workflow"));
});
