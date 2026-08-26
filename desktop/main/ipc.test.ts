import assert from "node:assert/strict";
import test from "node:test";
import { installTerminalIpc, TERMINAL_IPC_CHANNELS, TERMINAL_IPC_INVOKE_CHANNELS, type IpcMainLike, type IpcSenderLike } from "./ipc.js";

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
}

function fakeSender() {
  const messages: Array<[string, unknown]> = [];
  const sender: IpcSenderLike = { send: (channel, payload) => { messages.push([channel, payload]); } };
  return { sender, messages };
}

test("installs only the terminal IPC allowlist and forwards PTY output to its sender", async () => {
  const ipcMain = new FakeIpcMain();
  const { sender, messages } = fakeSender();
  const calls: Array<[string, unknown]> = [];
  const manager = {
    openReadOnly: (options: unknown) => {
      calls.push(["open", options]);
      return { id: "pty-1", session: "cowork-safe", readOnly: true as const };
    },
    subscribe: (_id: string, subscriptions: { onData(data: string): void; onExit(event: { exitCode: number; signal?: number }): void }) => {
      subscriptions.onData("screen output");
      subscriptions.onExit({ exitCode: 0 });
      return () => {};
    },
    resize: (id: string, columns: number, rows: number) => { calls.push(["resize", { id, columns, rows }]); },
    write: (id: string, data: string) => { calls.push(["write", { id, data }]); },
    close: (id: string) => { calls.push(["close", id]); },
  };
  const dispose = installTerminalIpc(ipcMain, manager as any);

  assert.deepEqual([...ipcMain.handlers.keys()], TERMINAL_IPC_INVOKE_CHANNELS);
  const handle = await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender }, { session: "cowork-safe", cols: 120, rows: 40 });
  assert.deepEqual(handle, { id: "pty-1", session: "cowork-safe", readOnly: true });
  assert.deepEqual(messages, [
    [TERMINAL_IPC_CHANNELS.data, { id: "pty-1", data: "screen output" }],
    [TERMINAL_IPC_CHANNELS.exit, { id: "pty-1", exitCode: 0 }],
  ]);
  await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.resize)!({ sender }, { id: "pty-1", cols: 140, rows: 50 });
  assert.deepEqual(calls, [
    ["open", { session: "cowork-safe", cols: 120, rows: 40 }],
    ["resize", { id: "pty-1", columns: 140, rows: 50 }],
  ]);
  dispose();
  assert.equal(ipcMain.handlers.size, 0);
});

test("cleans up every PTY of a sender when it goes away, and stops forwarding its output", async () => {
  const ipcMain = new FakeIpcMain();
  const { sender, messages } = fakeSender();
  const closedIds: string[] = [];
  const capturedOnData = new Map<string, (data: string) => void>();
  let nextId = 1;
  const manager = {
    openReadOnly: () => ({ id: `pty-${nextId++}`, session: "cowork-safe", readOnly: true as const }),
    subscribe: (id: string, subscriptions: { onData(data: string): void }) => {
      capturedOnData.set(id, subscriptions.onData);
      return () => { capturedOnData.delete(id); };
    },
    resize: () => {},
    write: () => {},
    close: (id: string) => { closedIds.push(id); },
  };
  const goneCallbacks = new Map<unknown, () => void>();
  const onSenderGone = (forSender: unknown, cb: () => void) => { goneCallbacks.set(forSender, cb); };
  installTerminalIpc(ipcMain, manager as any, onSenderGone);

  const open = ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!;
  const handles = await Promise.all([
    open({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }),
    open({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }),
    open({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }),
  ]) as Array<{ id: string }>;

  assert.equal(goneCallbacks.size, 1, "un único registro por sender, no uno por PTY");
  goneCallbacks.get(sender)!();

  assert.deepEqual(closedIds.sort(), handles.map((h) => h.id).sort());

  // Un dato que llega DESPUÉS de la destrucción (carrera con el unsubscribe del manager real)
  // no debe reenviarse al sender ya muerto.
  const messagesBefore = messages.length;
  for (const handle of handles) capturedOnData.get(handle.id)?.("late output");
  assert.equal(messages.length, messagesBefore);
});

test("rejects an open payload whose session name is over 80 characters", async () => {
  const ipcMain = new FakeIpcMain();
  let calls = 0;
  const manager = { openReadOnly: () => { calls++; throw new Error("must not run"); }, subscribe: () => () => {}, resize: () => {}, write: () => {}, close: () => {} };
  installTerminalIpc(ipcMain, manager as any);
  const event = { sender: fakeSender().sender };

  await assert.rejects(
    async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!(event, { session: "a".repeat(200), cols: 120, rows: 40 }),
    /INVALID_IPC_PAYLOAD/,
  );
  assert.equal(calls, 0);
});

test("rejects an open payload carrying paneId, since attach can never target a pane", async () => {
  const ipcMain = new FakeIpcMain();
  let calls = 0;
  const manager = { openReadOnly: () => { calls++; throw new Error("must not run"); }, subscribe: () => () => {}, resize: () => {}, write: () => {}, close: () => {} };
  installTerminalIpc(ipcMain, manager as any);
  const event = { sender: fakeSender().sender };

  await assert.rejects(
    async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!(event, { session: "cowork-safe", paneId: "%42", cols: 120, rows: 40 }),
    /INVALID_IPC_PAYLOAD/,
  );
  assert.equal(calls, 0);
});

test("rejects malformed IPC payloads before they reach the PTY manager", async () => {
  const ipcMain = new FakeIpcMain();
  let calls = 0;
  const manager = {
    openReadOnly: () => { calls++; throw new Error("must not run"); },
    subscribe: () => () => {},
    resize: () => { calls++; },
    write: () => { calls++; },
    close: () => { calls++; },
  };
  installTerminalIpc(ipcMain, manager as any);
  const event = { sender: fakeSender().sender };

  await assert.rejects(async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!(event, { session: "../../escape", cols: 120, rows: 40 }), /INVALID_IPC_PAYLOAD/);
  await assert.rejects(async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.resize)!(event, { id: "not-a-pty", cols: 120, rows: 40 }), /INVALID_IPC_PAYLOAD/);
  await assert.rejects(async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.write)!(event, { id: "pty-1", data: 123 }), /INVALID_IPC_PAYLOAD/);
  assert.equal(calls, 0);
});

// ---- T6: autoridad de escritura resuelta por main contra el servidor ----

test("open: una clave extra ({readOnly:false}, {writable:true}, cualquiera) es INCODIFICABLE — el renderer no puede declarar su propia autoridad", async () => {
  const ipcMain = new FakeIpcMain();
  const manager = { openReadOnly: () => { throw new Error("must not run"); }, openWritable: () => { throw new Error("must not run"); }, subscribe: () => () => {}, resize: () => {}, write: () => {}, close: () => {} };
  installTerminalIpc(ipcMain, manager as any);
  const event = { sender: fakeSender().sender };
  for (const extra of [{ readOnly: false }, { writable: true }, { anything: 1 }]) {
    await assert.rejects(
      async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!(event, { session: "cowork-safe", cols: 120, rows: 40, ...extra }),
      /INVALID_IPC_PAYLOAD/,
    );
  }
});

function authorityManager(kind: "managed" | "foreign") {
  const writes: Array<[string, string]> = [];
  const manager = {
    openReadOnly: () => ({ id: "pty-1", session: "cowork-safe", readOnly: true as const }),
    openWritable: () => ({ id: "pty-1", session: "cowork-safe", readOnly: false as const }),
    subscribe: () => () => {},
    resize: () => {},
    write: (id: string, data: string) => {
      if (kind === "foreign") throw new Error("TERMINAL_READ_ONLY");
      writes.push([id, data]);
    },
    close: () => {},
  };
  return { manager, writes };
}

test("autoridad foreign: el open cae a openReadOnly y terminal.write da TERMINAL_READ_ONLY", async () => {
  const ipcMain = new FakeIpcMain();
  const { manager } = authorityManager("foreign");
  installTerminalIpc(ipcMain, manager as any, undefined, async () => "foreign");
  const sender = fakeSender().sender;
  const handle = await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }) as { id: string };
  assert.equal((handle as any).readOnly, true);
  await assert.rejects(
    () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.write)!({ sender }, { id: handle.id, data: "echo hi" }) as Promise<unknown>,
    /TERMINAL_READ_ONLY/,
  );
});

test("autoridad managed: el open usa openWritable y terminal.write LLEGA al PTY falso", async () => {
  const ipcMain = new FakeIpcMain();
  const { manager, writes } = authorityManager("managed");
  installTerminalIpc(ipcMain, manager as any, undefined, async () => "managed");
  const sender = fakeSender().sender;
  const handle = await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }) as { id: string };
  assert.equal((handle as any).readOnly, false);
  await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.write)!({ sender }, { id: handle.id, data: "echo hi" });
  assert.deepEqual(writes, [[handle.id, "echo hi"]]);
});

test("autoridad: si el resolutor FALLA (backend caído), cae a read-only — fail-closed", async () => {
  const ipcMain = new FakeIpcMain();
  const { manager } = authorityManager("foreign");
  installTerminalIpc(ipcMain, manager as any, undefined, async () => { throw new Error("backend unreachable"); });
  const sender = fakeSender().sender;
  const handle = await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }) as { id: string };
  assert.equal((handle as any).readOnly, true);
});

test("otro sender no puede escribir en un handle writable ajeno (extiende requireOwner a la superficie de escritura)", async () => {
  const ipcMain = new FakeIpcMain();
  const { manager } = authorityManager("managed");
  installTerminalIpc(ipcMain, manager as any, undefined, async () => "managed");
  const owner = fakeSender().sender;
  const stranger = fakeSender().sender;
  const handle = await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender: owner }, { session: "cowork-safe", cols: 120, rows: 40 }) as { id: string };
  await assert.rejects(
    () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.write)!({ sender: stranger }, { id: handle.id, data: "echo hi" }) as Promise<unknown>,
    /IPC_FORBIDDEN/,
  );
});

test("filtro de prefijo: los bytes de C-b (0x02, prefijo por defecto de tmux) se eliminan antes de escribir", async () => {
  const ipcMain = new FakeIpcMain();
  const { manager, writes } = authorityManager("managed");
  installTerminalIpc(ipcMain, manager as any, undefined, async () => "managed");
  const sender = fakeSender().sender;
  const handle = await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender }, { session: "cowork-safe", cols: 120, rows: 40 }) as { id: string };
  await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.write)!({ sender }, { id: handle.id, data: "\x02:new-session\r" });
  assert.deepEqual(writes, [[handle.id, ":new-session\r"]]);
});

test("read-only write is still rejected through the IPC boundary", async () => {
  const ipcMain = new FakeIpcMain();
  const manager = {
    openReadOnly: () => ({ id: "pty-1", session: "cowork-safe", readOnly: true as const }),
    subscribe: () => () => {},
    resize: () => {},
    write: () => { throw new Error("TERMINAL_READ_ONLY"); },
    close: () => {},
  };
  installTerminalIpc(ipcMain, manager as any);
  const sender = fakeSender().sender;
  await ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.open)!({ sender }, { session: "cowork-safe", cols: 120, rows: 40 });
  await assert.rejects(
    async () => ipcMain.handlers.get(TERMINAL_IPC_CHANNELS.write)!({ sender }, { id: "pty-1", data: "hello" }),
    /TERMINAL_READ_ONLY/,
  );
});
