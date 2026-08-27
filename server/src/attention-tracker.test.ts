import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AttentionTracker } from "./attention-tracker.js";

test("AttentionTracker: conserva since mientras el nivel no cambie y lo reinicia al cambiar", () => {
  const tracker = new AttentionTracker();
  assert.deepEqual(tracker.track("cowork-a", { level: "idle" }, 1_000), { level: "idle", since: 1_000 });
  assert.deepEqual(tracker.track("cowork-a", { level: "idle", paneId: "%2" }, 9_000), { level: "idle", paneId: "%2", since: 1_000 });
  assert.deepEqual(tracker.track("cowork-a", { level: "decision", paneId: "%2", question: "¿Continuar?" }, 12_000), { level: "decision", paneId: "%2", question: "¿Continuar?", since: 12_000 });
});
