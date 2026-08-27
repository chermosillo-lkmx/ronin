import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deliverPromptWhenReady, type PromptDeliveryDeps } from "./engine.js";

function deps(captures: Array<string | null>): PromptDeliveryDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    capturePaneSafe: async () => captures.shift() ?? null,
    claudeAlive: (pane) => pane.includes("Claude Code"),
    isBusy: (pane) => pane.includes("working"),
    promptPending: (pane) => pane.includes("[Pasted text"),
    sendText: async (_session, text) => { calls.push(`text:${Buffer.byteLength(text)}`); },
    pastePrompt: async (_session, text) => { calls.push(`paste:${Buffer.byteLength(text)}`); },
    sendKeys: async () => { calls.push("enter"); },
    sleep: async () => { calls.push("wait"); },
  };
}

test("deliverPromptWhenReady: un prompt de 2960 B usa bracketed paste y nunca sendText", async () => {
  const d = deps(["Claude Code\n❯ ", "Claude Code\n❯ "]);
  await deliverPromptWhenReady("cowork-a", "x".repeat(2_960), d);
  assert.deepEqual(d.calls, ["paste:2960"]);
});

test("deliverPromptWhenReady: un prompt corto conserva sendText", async () => {
  const d = deps(["Claude Code\n❯ ", "Claude Code\n❯ "]);
  await deliverPromptWhenReady("cowork-a", "x".repeat(50), d);
  assert.deepEqual(d.calls, ["text:50"]);
});

test("deliverPromptWhenReady: espera una señal de TUI antes de entregar", async () => {
  const d = deps(["", "shell$ ", "Claude Code\n❯ ", "Claude Code\n❯ "]);
  await deliverPromptWhenReady("cowork-a", "corto", d);
  assert.deepEqual(d.calls, ["wait", "wait", "text:5"]);
});

test("deliverPromptWhenReady: reintenta Enter de forma acotada mientras queda paste pendiente", async () => {
  const d = deps(["Claude Code\n❯ ", "[Pasted text #1]", "[Pasted text #1]", "Claude Code\n❯ "]);
  await deliverPromptWhenReady("cowork-a", "x".repeat(2_960), d);
  assert.deepEqual(d.calls, ["paste:2960", "enter", "enter"]);
});
