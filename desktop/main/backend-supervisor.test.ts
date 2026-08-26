import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BackendSupervisor, BackendSupervisorError, MAX_BACKEND_LOG_BYTES } from "./backend-supervisor.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kills = 0;
  kill() { this.kills++; this.emit("exit", 0); }
}

class AsyncExitChild extends FakeChild {
  override kill() {
    this.kills++;
    queueMicrotask(() => this.emit("exit", 0));
  }
}

class StuckChild extends FakeChild {
  override kill() { this.kills++; }
}

function readyDependencies(children: FakeChild[]) {
  let now = 0;
  let token = 0;
  const urls: string[] = [];
  return {
    urls,
    deps: {
      entry: "server/dist/server-entry.js",
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        queueMicrotask(() => child.emit("message", { type: "ronin-backend-listening", version: 1, port: 45678 }));
        return child as any;
      },
      fetch: async (url: string) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => ({ ok: true, version: 1, service: "ronin-api", tokenOk: true }) };
      },
      sleep: async (ms: number) => { now += ms; },
      now: () => now,
      createToken: () => `token-${++token}`,
      onExit: undefined as (() => void) | undefined,
    },
  };
}

test("BackendSupervisor requires its child message and matching tokenized health on the published port", async () => {
  const children: FakeChild[] = [];
  const { deps, urls } = readyDependencies(children);
  const supervisor = new BackendSupervisor(deps);
  await supervisor.start();
  assert.equal(supervisor.port, 45678);
  assert.deepEqual(urls, ["http://127.0.0.1:45678/api/health"]);
  await supervisor.close();
  await supervisor.close();
  assert.equal(children[0]!.kills, 1);
});

test("BackendSupervisor presents its token as a header and never reads it back from the body", async () => {
  const children: FakeChild[] = [];
  const headersSeen: Array<Record<string, string> | undefined> = [];
  const supervisor = new BackendSupervisor({
    entry: "server/dist/server-entry.js",
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      queueMicrotask(() => child.emit("message", { type: "ronin-backend-listening", version: 1, port: 45678 }));
      return child as any;
    },
    fetch: async (_url, options) => {
      headersSeen.push(options?.headers);
      return { ok: true, status: 200, json: async () => ({ ok: true, version: 1, service: "ronin-api", tokenOk: true }) };
    },
    sleep: async () => {},
    now: () => 0,
    createToken: () => "token-1",
  });
  await supervisor.start();
  assert.equal(supervisor.port, 45678);
  assert.equal(headersSeen[0]?.["x-ronin-boot-token"], "token-1");
  await supervisor.close();
});

test("BackendSupervisor rejects readiness when the backend reports tokenOk:false", async () => {
  const child = new FakeChild();
  let now = 0;
  const supervisor = new BackendSupervisor({
    entry: "server/dist/server-entry.js",
    fork: () => { queueMicrotask(() => child.emit("message", { type: "ronin-backend-listening", version: 1, port: 45678 })); return child as any; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: 1, service: "ronin-api", tokenOk: false }) }),
    sleep: async (ms) => { now += ms; },
    now: () => now,
    createToken: () => "token-1",
  });
  await assert.rejects(supervisor.start(), (error: unknown) => error instanceof BackendSupervisorError && error.code === "BACKEND_PROTOCOL_ERROR");
});

test("BackendSupervisor clears the published port when the active backend exits", async () => {
  const children: FakeChild[] = [];
  const { deps } = readyDependencies(children);
  let exitNotifications = 0;
  deps.onExit = () => { exitNotifications++; };
  const supervisor = new BackendSupervisor(deps);

  await supervisor.start();
  assert.equal(supervisor.port, 45678);

  children[0]!.emit("exit", 1);
  children[0]!.emit("exit", 1);

  assert.equal(supervisor.port, undefined);
  assert.equal(exitNotifications, 1);
  await supervisor.close();
});

test("BackendSupervisor rejects an exited child before readiness", async () => {
  let now = 0;
  const child = new FakeChild();
  const supervisor = new BackendSupervisor({
    entry: "server/dist/server-entry.js",
    fork: () => { queueMicrotask(() => child.emit("exit", 1)); return child as any; },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    sleep: async (ms) => { now += ms; }, now: () => now, createToken: () => "token",
  });
  await assert.rejects(supervisor.start(), (error: unknown) => error instanceof BackendSupervisorError && error.code === "BACKEND_EXITED");
});

test("BackendSupervisor terminates and observes every failed startup attempt before rejecting", async () => {
  const cases = [
    { name: "timeout", expected: "BACKEND_START_TIMEOUT", signal: () => undefined, health: async () => undefined },
    { name: "invalid message", expected: "BACKEND_PROTOCOL_ERROR", signal: (child: FakeChild) => child.emit("message", { type: "wrong" }), health: async () => undefined },
    { name: "invalid health", expected: "BACKEND_PROTOCOL_ERROR", signal: (child: FakeChild) => child.emit("message", { type: "ronin-backend-listening", version: 1, port: 45678 }), health: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) },
    { name: "early exit", expected: "BACKEND_EXITED", signal: (child: FakeChild) => child.emit("exit", 1), health: async () => undefined },
  ] as const;

  for (const scenario of cases) {
    let now = 0;
    const child = new AsyncExitChild();
    const supervisor = new BackendSupervisor({
      entry: "server/dist/server-entry.js",
      fork: () => { queueMicrotask(() => scenario.signal(child)); return child as any; },
      fetch: async () => scenario.health() as any,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      createToken: () => "token",
    });

    await assert.rejects(
      supervisor.start(),
      (error: unknown) => error instanceof BackendSupervisorError && error.code === scenario.expected,
      scenario.name,
    );
    assert.equal(child.kills, 1, `${scenario.name} child must be killed`);
  }
});

test("BackendSupervisor reports one close timeout after waiting for its child exit", async () => {
  let now = 0;
  const child = new StuckChild();
  const supervisor = new BackendSupervisor({
    entry: "server/dist/server-entry.js",
    fork: () => {
      queueMicrotask(() => child.emit("message", { type: "ronin-backend-listening", version: 1, port: 45678 }));
      return child as any;
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: 1, service: "ronin-api", tokenOk: true }) }),
    sleep: async (ms) => { now += ms; },
    now: () => now,
    createToken: () => "token",
  });

  await supervisor.start();
  await assert.rejects(supervisor.close(), (error: unknown) => error instanceof BackendSupervisorError && error.code === "BACKEND_CLOSE_TIMEOUT");
  await assert.rejects(supervisor.close(), (error: unknown) => error instanceof BackendSupervisorError && error.code === "BACKEND_CLOSE_TIMEOUT");
  assert.equal(child.kills, 1);
  assert.ok(now >= 5_000);
});

test("BackendSupervisor sanitizes fragmented child logs before retaining the bounded tail", async () => {
  const children: FakeChild[] = [];
  const { deps } = readyDependencies(children);
  const supervisor = new BackendSupervisor(deps);
  await supervisor.start();
  const child = children[0]!;
  const utf8 = Buffer.from("é");
  child.stdout.emit("data", Buffer.from("x".repeat(MAX_BACKEND_LOG_BYTES + 100)));
  child.stdout.emit("data", Buffer.from("Authorization: Bea"));
  child.stdout.emit("data", Buffer.from("rer top-secret\napi_"));
  child.stderr.emit("data", Buffer.from("key=hunter2\n\u001b[3"));
  child.stderr.emit("data", Buffer.from("1msecret=hidden\u001b[0m\n"));
  child.stdout.emit("data", utf8.subarray(0, 1));
  child.stdout.emit("data", utf8.subarray(1));
  child.stdout.emit("data", Buffer.from("\n"));
  child.stdout.emit("end");
  child.stderr.emit("end");

  const logs = supervisor.logs;
  assert.ok(Buffer.byteLength(logs, "utf8") <= MAX_BACKEND_LOG_BYTES);
  assert.match(logs, /<redacted>/);
  assert.doesNotMatch(logs, /top-secret|hunter2|hidden|\u001b/);
  assert.ok(!logs.includes("�"));
  const recovery = supervisor.recoverySnapshot();
  assert.ok(Buffer.byteLength(recovery, "utf8") <= 4 * 1024);
  assert.ok(recovery.split(/\r?\n/).length <= 20);
  await supervisor.close();
});

test("BackendSupervisor redacts fragmented token, password, and cookie names and values", async () => {
  const children: FakeChild[] = [];
  const { deps } = readyDependencies(children);
  const supervisor = new BackendSupervisor(deps);
  await supervisor.start();
  const child = children[0]!;

  child.stdout.emit("data", Buffer.from("to"));
  child.stdout.emit("data", Buffer.from("ken=token-"));
  child.stdout.emit("data", Buffer.from("value\npass"));
  child.stdout.emit("data", Buffer.from("word=pass-"));
  child.stdout.emit("data", Buffer.from("value\n"));
  child.stderr.emit("data", Buffer.from("co"));
  child.stderr.emit("data", Buffer.from("okie=cookie-"));
  child.stderr.emit("data", Buffer.from("value\n"));
  child.stdout.emit("end");
  child.stderr.emit("end");

  assert.doesNotMatch(supervisor.logs, /token|password|cookie|token-value|pass-value|cookie-value/i);
  assert.doesNotMatch(supervisor.recoverySnapshot(), /token|password|cookie|token-value|pass-value|cookie-value/i);
  assert.match(supervisor.logs, /<redacted>/);
  await supervisor.close();
});

test("BackendSupervisor retry replaces the child, token, and retained diagnostics", async () => {
  let now = 0;
  let token = 0;
  const children: FakeChild[] = [];
  const bootTokens: string[] = [];
  const ports = [45678, 45679];
  const supervisor = new BackendSupervisor({
    entry: "server/dist/server-entry.js",
    fork: (_entry, options) => {
      const child = new FakeChild();
      children.push(child);
      bootTokens.push(options.env.COWORK_DESKTOP_BOOT_TOKEN!);
      const port = ports[children.length - 1]!;
      queueMicrotask(() => child.emit("message", { type: "ronin-backend-listening", version: 1, port }));
      return child as any;
    },
    fetch: async (url, options) => {
      const port = Number(new URL(url).port);
      const index = ports.indexOf(port);
      const tokenOk = options?.headers?.["x-ronin-boot-token"] === bootTokens[index];
      return { ok: true, status: 200, json: async () => ({ ok: true, version: 1, service: "ronin-api", tokenOk }) };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    createToken: () => `token-${++token}`,
  });

  await supervisor.start();
  children[0]!.stdout.emit("data", Buffer.from("first diagnostic\n"));
  children[0]!.stdout.emit("end");
  await supervisor.retry();
  children[0]!.stdout.emit("data", Buffer.from("late first diagnostic\n"));
  children[0]!.stdout.emit("end");
  children[1]!.stdout.emit("data", Buffer.from("second diagnostic\n"));
  children[1]!.stdout.emit("end");

  assert.deepEqual(bootTokens, ["token-1", "token-2"]);
  assert.equal(children.length, 2);
  assert.equal(supervisor.port, 45679);
  assert.doesNotMatch(supervisor.logs, /first diagnostic/);
  assert.match(supervisor.logs, /second diagnostic/);
  assert.doesNotMatch(supervisor.recoverySnapshot(), /first diagnostic/);
  await supervisor.close();
});
