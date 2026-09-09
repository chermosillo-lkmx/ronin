import assert from "node:assert/strict";
import test from "node:test";
import { armVerifyCmds } from "./harness-arm.js";

test("M3a armVerifyCmds confirma antes de aplicar", async () => {
  const events: string[] = [];

  const result = await armVerifyCmds([{ stageKey: "test", cmd: "npm test" }], "repo", {
    getSessions: async () => [],
    confirm: async () => { events.push("confirm"); return true; },
    apply: () => { events.push("apply"); },
  });

  assert.deepEqual(events, ["confirm", "apply"]);
  assert.equal(result, "applied");
});

test("M3b confirm false cancela sin aplicar", async () => {
  let applied = false;

  const result = await armVerifyCmds([{ stageKey: "test", cmd: "npm test" }], "repo", {
    getSessions: async () => [],
    confirm: async () => false,
    apply: () => { applied = true; },
  });

  assert.equal(result, "cancelled");
  assert.equal(applied, false);
});

test("M3c fallo o null de getSessions conserva la confirmación genérica", async () => {
  for (const getSessions of [
    async () => Promise.reject(new Error("offline")),
    async () => null,
  ]) {
    let warning = "";
    await armVerifyCmds([{ stageKey: "test", cmd: "npm test" }], "repo", {
      getSessions,
      confirm: async (value) => { warning = value.message; return false; },
      apply: () => assert.fail("no debe aplicar al cancelar"),
    });
    assert.match(warning, /ejecuta shell/i);
    assert.match(warning, /worktree.*sesiones vivas/i);
    assert.match(warning, /aplica hacia atrás/i);
  }
});

test("M3d apagar verifyCmd no consulta, confirma ni aplica", async () => {
  const events: string[] = [];

  const result = await armVerifyCmds([], "repo", {
    getSessions: async () => { events.push("sessions"); return []; },
    confirm: async () => { events.push("confirm"); return true; },
    apply: () => { events.push("apply"); },
  });

  assert.equal(result, "cancelled");
  assert.deepEqual(events, []);
});

test("B6a vía masiva confirma una vez antes de aplicar una vez", async () => {
  const events: string[] = [];
  await armVerifyCmds([
    { stageKey: "a", cmd: "npm test" },
    { stageKey: "b", cmd: "npm run lint" },
  ], "repo", {
    getSessions: async () => [],
    confirm: async () => { events.push("confirm"); return true; },
    apply: () => { events.push("apply"); },
  });

  assert.deepEqual(events, ["confirm", "apply"]);
});

test("B6b aviso masivo enumera etapas y comandos", async () => {
  let message = "";
  await armVerifyCmds([
    { stageKey: "unit", cmd: "npm test" },
    { stageKey: "lint", cmd: "npm run lint" },
  ], "repo", {
    getSessions: async () => [],
    confirm: async (warning) => { message = warning.message; return false; },
    apply: () => assert.fail("cancelled"),
  });

  assert.match(message, /unit.*npm test/s);
  assert.match(message, /lint.*npm run lint/s);
});

test("B6c cancelar la vía masiva no aplica nada parcialmente", async () => {
  let applyCount = 0;
  const result = await armVerifyCmds([
    { stageKey: "a", cmd: "npm test" },
    { stageKey: "b", cmd: "npm run lint" },
  ], "repo", {
    getSessions: async () => [],
    confirm: async () => false,
    apply: () => { applyCount += 1; },
  });

  assert.equal(result, "cancelled");
  assert.equal(applyCount, 0);
});

test("B6d fallo de sesiones en vía masiva confirma con aviso genérico", async () => {
  let warning = "";
  await armVerifyCmds([
    { stageKey: "a", cmd: "npm test" },
    { stageKey: "b", cmd: "npm run lint" },
  ], "repo", {
    getSessions: async () => { throw new Error("offline"); },
    confirm: async (value) => { warning = value.message; return false; },
    apply: () => assert.fail("cancelled"),
  });

  assert.match(warning, /ejecuta shell.*sesiones vivas.*aplica hacia atrás/is);
});

test("B6e banda sin comandos stasheados no confirma ni aplica", async () => {
  const events: string[] = [];
  await armVerifyCmds([], "repo", {
    getSessions: async () => { events.push("sessions"); return []; },
    confirm: async () => { events.push("confirm"); return true; },
    apply: () => { events.push("apply"); },
  });

  assert.deepEqual(events, []);
});

test("detalle del aviso identifica etapas alcanzadas en sesiones vivas del repo", async () => {
  let reached: Array<{ session: string; stageKey: string }> = [];
  await armVerifyCmds([
    { stageKey: "a", cmd: "npm test" },
    { stageKey: "b", cmd: "npm run lint" },
  ], "repo", {
    getSessions: async () => [{
      name: "live-session",
      presentation: { title: "Live", repo: "repo" },
      flow: {
        done: 1,
        total: 2,
        stages: [
          { key: "a", label: "A", status: "done" },
          { key: "b", label: "B", status: "pending" },
        ],
      },
    } as any],
    confirm: async (warning) => { reached = warning.reached; return false; },
    apply: () => assert.fail("cancelled"),
  });

  assert.deepEqual(reached, [{ session: "live-session", stageKey: "a" }]);
});
