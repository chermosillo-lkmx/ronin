import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PTY_INPUT_BYTES, PtyManager, PtyManagerError, type PtyFactory, type PtyProcess } from "./pty.js";

class FakePty implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = 0;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((entry) => entry !== listener); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((entry) => entry !== listener); } };
  }

  resize(columns: number, rows: number): void { this.resizes.push([columns, rows]); }
  write(data: string): void { this.writes.push(data); }
  kill(): void { this.killed++; }
  emitData(data: string): void { for (const listener of this.dataListeners) listener(data); }
  emitExit(event: { exitCode: number; signal?: number }): void { for (const listener of this.exitListeners) listener(event); }
}

function fakeFactory(expectedTarget = "cowork-safe") {
  const processes: FakePty[] = [];
  const factory: PtyFactory = {
    spawn: (_file, args, options) => {
      assert.deepEqual(args, ["attach-session", "-r", "-f", "ignore-size", "-t", expectedTarget]);
      assert.equal(options.cols, 120);
      assert.equal(options.rows, 40);
      const process = new FakePty();
      processes.push(process);
      return process;
    },
  };
  return { factory, processes };
}

test("openReadOnly rejects a session name over 80 characters (KB electron-desktop:94)", () => {
  const { factory, processes } = fakeFactory();
  const manager = new PtyManager(factory);
  assert.throws(
    () => manager.openReadOnly({ session: "a".repeat(200), cols: 120, rows: 40 }),
    (error: unknown) => error instanceof PtyManagerError && error.code === "INVALID_SESSION",
  );
  assert.equal(processes.length, 0);
});

test("the attach API rejects a paneId outright instead of targeting it", () => {
  const { factory, processes } = fakeFactory();
  const manager = new PtyManager(factory);

  assert.throws(
    () => (manager as any).openReadOnly({ session: "cowork-safe", paneId: "%42", cols: 120, rows: 40 }),
    (error: unknown) => error instanceof PtyManagerError && error.code === "INVALID_PANE",
  );
  assert.equal(processes.length, 0);
});

test("rejects unsafe session names and dimensions before spawning", () => {
  const { factory, processes } = fakeFactory();
  const manager = new PtyManager(factory);

  assert.throws(() => manager.openReadOnly({ session: "../../other", cols: 120, rows: 40 }), (error) => error instanceof PtyManagerError && error.code === "INVALID_SESSION");
  assert.throws(() => manager.openReadOnly({ session: "cowork-safe", cols: 0, rows: 40 }), (error) => error instanceof PtyManagerError && error.code === "INVALID_DIMENSIONS");
  assert.equal(processes.length, 0);
});

test("keeps the first terminal API read-only and validates payloads", () => {
  const { factory } = fakeFactory();
  const manager = new PtyManager(factory);
  const handle = manager.openReadOnly({ session: "cowork-safe", cols: 120, rows: 40 });

  assert.deepEqual(handle, { id: handle.id, session: "cowork-safe", readOnly: true });
  assert.throws(() => manager.write(handle.id, "hello"), (error) => error instanceof PtyManagerError && error.code === "TERMINAL_READ_ONLY");
});

test("MAX_PTY_INPUT_BYTES is 16 KiB (T6, bajado de 64 KiB — KB electron-desktop:94)", () => {
  assert.equal(MAX_PTY_INPUT_BYTES, 16 * 1024);
  const { factory } = fakeFactory();
  const manager = new PtyManager(factory);
  const handle = manager.openReadOnly({ session: "cowork-safe", cols: 120, rows: 40 });
  assert.throws(
    () => manager.write(handle.id, "x".repeat(16 * 1024 + 1)),
    (error) => error instanceof PtyManagerError && error.code === "INVALID_PAYLOAD",
  );
});

test("openWritable: attach SIN -r (ignore-size explícito), handle con readOnly:false, y write() llega al PTY", () => {
  const processes: FakePty[] = [];
  const factory: PtyFactory = {
    spawn: (_file, args, options) => {
      assert.deepEqual(args, ["attach-session", "-f", "ignore-size", "-t", "cowork-managed"]);
      assert.equal(options.cols, 120);
      assert.equal(options.rows, 40);
      const process = new FakePty();
      processes.push(process);
      return process;
    },
  };
  const manager = new PtyManager(factory);
  const handle = manager.openWritable({ session: "cowork-managed", cols: 120, rows: 40 });

  assert.deepEqual(handle, { id: handle.id, session: "cowork-managed", readOnly: false });
  manager.write(handle.id, "echo hi\r");
  assert.deepEqual(processes[0]!.writes, ["echo hi\r"]);
});

test("el attach usa el mismo tmux resuelto y socket que el inventario, sin heredar TMUX", () => {
  const previousBinary = process.env.COWORK_TMUX_BIN;
  const previousSocket = process.env.COWORK_TMUX_SOCKET;
  const previousTmux = process.env.TMUX;
  process.env.COWORK_TMUX_BIN = "/opt/homebrew/bin/tmux";
  process.env.COWORK_TMUX_SOCKET = "ronin-fixture";
  process.env.TMUX = "/private/tmp/tmux-501/default,123,0";
  try {
    const factory: PtyFactory = {
      spawn: (file, args, options) => {
        assert.equal(file, "/opt/homebrew/bin/tmux");
        assert.deepEqual(args, ["-L", "ronin-fixture", "attach-session", "-r", "-f", "ignore-size", "-t", "cowork-safe"]);
        assert.equal(options.env?.TMUX, undefined);
        return new FakePty();
      },
    };
    new PtyManager(factory).openReadOnly({ session: "cowork-safe", cols: 120, rows: 40 });
  } finally {
    if (previousBinary === undefined) delete process.env.COWORK_TMUX_BIN;
    else process.env.COWORK_TMUX_BIN = previousBinary;
    if (previousSocket === undefined) delete process.env.COWORK_TMUX_SOCKET;
    else process.env.COWORK_TMUX_SOCKET = previousSocket;
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
});

test("el attach acepta una ruta de socket explícita", () => {
  const factory: PtyFactory = {
    spawn: (_file, args) => {
      assert.deepEqual(args, ["-S", "/tmp/ronin-fixture/tmux.sock", "attach-session", "-r", "-f", "ignore-size", "-t", "cowork-safe"]);
      return new FakePty();
    },
  };
  new PtyManager(factory, { tmuxSocket: "/tmp/ronin-fixture/tmux.sock" }).openReadOnly({ session: "cowork-safe", cols: 120, rows: 40 });
});

test("write(): elimina bytes NUL antes de escribir", () => {
  const processes: FakePty[] = [];
  const factory: PtyFactory = { spawn: () => { const p = new FakePty(); processes.push(p); return p; } };
  const manager = new PtyManager(factory);
  const writable = manager.openWritable({ session: "cowork-safe2", cols: 120, rows: 40 });
  manager.write(writable.id, "a\0b\0c");
  assert.deepEqual(processes[0]!.writes, ["abc"]);
});

test("forwards output and exit events, resizes, and closes each PTY once", () => {
  const { factory, processes } = fakeFactory();
  const manager = new PtyManager(factory);
  const handle = manager.openReadOnly({ session: "cowork-safe", cols: 120, rows: 40 });
  const output: string[] = [];
  const exits: Array<{ exitCode: number; signal?: number }> = [];
  const unsubscribe = manager.subscribe(handle.id, { onData: (data) => output.push(data), onExit: (event) => exits.push(event) });
  processes[0]!.emitData("live output");
  processes[0]!.emitExit({ exitCode: 0 });
  manager.resize(handle.id, 140, 50);
  manager.close(handle.id);
  manager.close(handle.id);
  unsubscribe();

  assert.deepEqual(output, ["live output"]);
  assert.deepEqual(exits, [{ exitCode: 0 }]);
  assert.deepEqual(processes[0]!.resizes, [[140, 50]]);
  assert.equal(processes[0]!.killed, 1);
});

test("unknown handles are typed errors for active operations and harmless on close", () => {
  const manager = new PtyManager({ spawn: () => new FakePty() });
  assert.throws(() => manager.resize("pty-missing", 120, 40), (error) => error instanceof PtyManagerError && error.code === "PTY_NOT_FOUND");
  assert.throws(() => manager.write("pty-missing", "hello"), (error) => error instanceof PtyManagerError && error.code === "PTY_NOT_FOUND");
  assert.doesNotThrow(() => manager.close("pty-missing"));
});
