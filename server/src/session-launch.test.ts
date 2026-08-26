import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalTerminalCommand, SessionLaunchError, validateManagedSessionLaunch } from "./session-launch.js";

test("managed session validation requires a safe cowork- name", () => {
  assert.throws(
    () => validateManagedSessionLaunch({ repo: "monorepo", workflowId: "wf-x", name: "scratch" }),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "MANAGED_SESSION_PREFIX_REQUIRED",
  );
  assert.throws(
    () => validateManagedSessionLaunch({ repo: "monorepo", workflowId: "wf-x", name: "cowork-../../etc" }),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "INVALID_SESSION",
  );
});

test("normal terminal sessions do not require a workflow", () => {
  assert.doesNotThrow(() => validateManagedSessionLaunch({
    repo: "monorepo",
    workflowId: "",
    name: "cowork-codex-shell",
    mode: "terminal",
    agent: "codex",
  }));
});

test("normal terminal sessions only accept Claude or Codex", () => {
  assert.throws(
    () => validateManagedSessionLaunch({
      repo: "monorepo",
      workflowId: "",
      name: "cowork-unknown-shell",
      mode: "terminal",
      agent: "shell",
    }),
    (error: unknown) => error instanceof SessionLaunchError && error.code === "AGENT_INVALID",
  );
});

test("normal Claude sessions use the interactive terminal command", () => {
  assert.equal(normalTerminalCommand("claude", { claude: "claude", codex: "codex" }), "claude");
  assert.equal(normalTerminalCommand("codex", { claude: "claude", codex: "codex" }), "codex");
});
