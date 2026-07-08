import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  currentModelFromPane,
  isModelPickerOpen,
  launchSwitchEnabled,
  modelFamily,
  modelSwitchConfirmed,
  pickerOffersModel,
  sanitizeModel,
  withModel,
} from "./models.js";

// The real "Switch model?" confirm Opus 4.8 shows after `/model sonnet` (from live verification).
const SWITCH_CONFIRM = [
  "Switch model?",
  "This conversation is cached for the current model. Switching to Sonnet 5",
  "❯ 1. Yes, switch to Sonnet 5",
  "  2. No, keep Opus 4.8",
].join("\n");

test("isModelPickerOpen: detects the 'Switch model?' confirm dialog", () => {
  assert.equal(isModelPickerOpen(SWITCH_CONFIRM), true);
});

test("pickerOffersModel: true when the confirm pre-selects the target (→ confirm with Enter)", () => {
  assert.equal(pickerOffersModel(SWITCH_CONFIRM, "sonnet"), true); // "Yes, switch to Sonnet 5"
});

test("pickerOffersModel: false when the picker doesn't offer the target (→ dismiss, retry)", () => {
  // a plain model-list picker with no "switch to <target>" / "yes" cue
  const list = ["Select a model:", "❯ Opus 4.8", "  Haiku 4.5"].join("\n");
  assert.equal(pickerOffersModel(list, "sonnet"), false);
  assert.equal(pickerOffersModel(SWITCH_CONFIRM, "opus"), false); // confirm offers sonnet, not opus
});

test("modelSwitchConfirmed: the real 'Set model to Sonnet 5' confirmation → confirmed (live-verified fixture)", () => {
  const pane = [
    "❯ /model sonnet",
    "  ⎿  Set model to Sonnet 5 and saved as your default for new sessions",
    "› ",
  ].join("\n");
  assert.equal(modelSwitchConfirmed(pane, "sonnet"), true);
  assert.equal(modelSwitchConfirmed(pane, "opus"), false); // not confirming opus
});

test("modelSwitchConfirmed: tolerant of a width-wrap between the cue and the model name", () => {
  const wrapped = ["  ⎿  Set model to", "     Sonnet 5 and saved as your default", "› "].join("\n");
  assert.equal(modelSwitchConfirmed(wrapped, "sonnet"), true);
});

test("modelSwitchConfirmed: no confirmation line → false", () => {
  assert.equal(modelSwitchConfirmed("just working\n› ", "sonnet"), false);
});

test("currentModelFromPane: after confirming, the banner reads the target (Switching… line is chrome)", () => {
  // post-confirm pane: the "Switching to…" line is picker chrome (skipped); banner shows Sonnet
  const after = ["Switching to Sonnet 5…", "  Sonnet 4.6 · claude-sonnet-5", "› "].join("\n");
  assert.equal(currentModelFromPane(after), "sonnet");
});

test("sanitizeModel: allows valid model aliases/ids", () => {
  assert.equal(sanitizeModel("opus"), "opus");
  assert.equal(sanitizeModel("sonnet"), "sonnet");
  assert.equal(sanitizeModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(sanitizeModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(sanitizeModel("  opus  "), "opus"); // trims
});

test("sanitizeModel: rejects shell/flag/newline injection to empty string", () => {
  assert.equal(sanitizeModel("opus; rm -rf ~"), "");
  assert.equal(sanitizeModel("opus\n/model"), "");
  assert.equal(sanitizeModel("opus --dangerously-skip"), "");
  assert.equal(sanitizeModel("$(whoami)"), "");
  assert.equal(sanitizeModel(""), "");
  assert.equal(sanitizeModel("  "), "");
});

test("withModel: appends --model when absent", () => {
  assert.equal(
    withModel("claude --permission-mode bypassPermissions", "opus"),
    "claude --permission-mode bypassPermissions --model opus"
  );
});

test("withModel: respects an existing --model (no duplicate)", () => {
  assert.equal(withModel("claude --model haiku", "opus"), "claude --model haiku");
  assert.equal(withModel("claude --model=haiku", "opus"), "claude --model=haiku");
});

test("withModel: handles quotes and spaces", () => {
  assert.equal(
    withModel('claude --flag "a b"', "sonnet"),
    'claude --flag "a b" --model sonnet'
  );
});

test("withModel: --model-foo is NOT treated as --model", () => {
  assert.equal(
    withModel("claude --model-foo bar", "opus"),
    "claude --model-foo bar --model opus"
  );
});

test("withModel: malicious model never reaches the command string (sanitized to empty → cmd unchanged)", () => {
  const cmd = "claude --permission-mode bypassPermissions";
  assert.equal(withModel(cmd, "opus; rm -rf ~"), cmd);
  assert.equal(withModel(cmd, "opus\n/model"), cmd);
});

test("withModel: blank/empty model leaves cmd unchanged", () => {
  const cmd = "claude";
  assert.equal(withModel(cmd, ""), cmd);
  assert.equal(withModel(cmd, "   "), cmd);
});

test("launchSwitchEnabled: PR never switches; other sources do", () => {
  assert.equal(launchSwitchEnabled("pr"), false);
  assert.equal(launchSwitchEnabled("clickup"), true);
  assert.equal(launchSwitchEnabled("custom"), true);
  assert.equal(launchSwitchEnabled("adhoc"), true);
});

test("modelFamily: maps aliases and ids to a family token", () => {
  assert.equal(modelFamily("opus"), "opus");
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("sonnet"), "sonnet");
  assert.equal(modelFamily("claude-sonnet-5"), "sonnet");
  assert.equal(modelFamily("haiku"), "haiku");
});

test("currentModelFromPane: reads the status-line model, ignoring the /model echo and input", () => {
  // Realistic: footer shows the active model; the command echo + prompt line must be skipped.
  const pane = [
    "  Some earlier output",
    "  Sonnet 4.6 · claude-sonnet-5",   // status/banner region
    "> /model sonnet",                   // echo of the command we just typed (must be ignored)
  ].join("\n");
  assert.equal(currentModelFromPane(pane), "sonnet");
});

test("currentModelFromPane: null when no model shown", () => {
  assert.equal(currentModelFromPane("just some text\nno models here"), null);
});

test("currentModelFromPane: point-1 guard — target only in the command echo does NOT count as switched", () => {
  // The pane still shows Opus in the status line; 'sonnet' appears ONLY in the typed echo.
  const pane = [
    "  Opus 4.8 with high effort",       // status line still Opus → NOT switched
    "> /model sonnet",                   // echo only
  ].join("\n");
  assert.equal(currentModelFromPane(pane), "opus"); // NOT "sonnet"
});

test("isModelPickerOpen: detects an interactive picker (≥2 options + cursor/prompt)", () => {
  const picker = [
    "Select a model:",
    "❯ Opus 4.8",
    "  Sonnet 4.6",
    "  Haiku 4.5",
  ].join("\n");
  assert.equal(isModelPickerOpen(picker), true);
});

test("isModelPickerOpen: false for a normal status line with a single model", () => {
  assert.equal(isModelPickerOpen("  Sonnet 4.6 · claude-sonnet-5"), false);
});
