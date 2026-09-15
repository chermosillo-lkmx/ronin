import assert from "node:assert/strict";
import test from "node:test";
import { deriveTrigger, type TriggerDeps } from "./trigger.js";

function deps(launches: ReturnType<TriggerDeps["listLaunches"]> = []): TriggerDeps {
  return {
    git: async (_dir, args) => args.includes("--short") ? "abc1234\n" : "feat/tests-case-map\n",
    listLaunches: () => launches,
  };
}

test("deriveTrigger derives session, worktree, ticket, commit and branch from the closest launch", async () => {
  const trigger = await deriveTrigger({ dir: "/tmp/worktrees/project/packages/api" }, deps([
    { session: "cowork-parent", worktree: "/tmp/worktrees" },
    { session: "cowork-case", worktree: "/tmp/worktrees/project", inputs: { ticket: "CU-123" } },
  ]));

  assert.deepEqual(trigger, {
    session: "cowork-case",
    worktree: "/tmp/worktrees/project",
    ticket: "CU-123",
    commit: "abc1234",
    branch: "feat/tests-case-map",
    source: "derived",
  });
});

test("deriveTrigger extracts a ticket from the session or request when inputs has none", async () => {
  const fromSession = await deriveTrigger({ dir: "/tmp/regex/session" }, deps([
    { session: "cowork-CU-86abc1234-fix", cwd: "/tmp/regex/session" },
  ]));
  assert.equal(fromSession.ticket, "CU-86abc1234");

  const fromRequest = await deriveTrigger({ dir: "/tmp/regex/request" }, deps([
    { session: "cowork-fix", cwd: "/tmp/regex/request", request: "Resolver 86xyz7890 ahora" },
  ]));
  assert.equal(fromRequest.ticket, "86xyz7890");
});

test("deriveTrigger lets explicit values win and marks the combination as mixed", async () => {
  const trigger = await deriveTrigger({
    dir: "/tmp/worktrees/project",
    explicit: { session: "manual-session", ticket: "MANUAL-9", commit: "deadbee" },
  }, deps([{ session: "derived-session", worktree: "/tmp/worktrees/project", inputs: { ticket: "CU-123" } }]));

  assert.equal(trigger.session, "manual-session");
  assert.equal(trigger.ticket, "MANUAL-9");
  assert.equal(trigger.commit, "deadbee");
  assert.equal(trigger.branch, "feat/tests-case-map");
  assert.equal(trigger.source, "mixed");
});

test("deriveTrigger tolerates git failures and omits commit and branch", async () => {
  const trigger = await deriveTrigger({ dir: "/tmp/not-a-repo" }, {
    git: async () => { throw new Error("not a repository"); },
    listLaunches: () => [],
  });

  assert.deepEqual(trigger, { source: "derived" });
});
