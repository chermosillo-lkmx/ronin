import assert from "node:assert/strict";
import test from "node:test";
import { connectNativeTerminal, createReadonlyTerminalRequest, type NativeTerminalBridge, type TerminalSurface } from "./native-terminal-controller.js";

test("the read-only open request never carries a pane id", () => {
  assert.deepEqual(createReadonlyTerminalRequest("cowork-safe", 120, 40), {
    session: "cowork-safe",
    cols: 120,
    rows: 40,
  });
});

test("connects output, resize and cleanup through the renderer bridge", async () => {
  const output: string[] = [];
  const calls: Array<[string, unknown]> = [];
  const surface: TerminalSurface = { write: (data) => output.push(data) };
  let onData: ((data: string) => void) | undefined;
  const bridge: NativeTerminalBridge = {
    open: async (request) => { calls.push(["open", request]); return { id: "pty-1", session: request.session, readOnly: true }; },
    resize: async (request) => { calls.push(["resize", request]); },
    write: async (request) => { calls.push(["write", request]); },
    close: async (request) => { calls.push(["close", request]); },
    onData: (_id, listener) => { onData = listener; return () => { onData = undefined; }; },
    onExit: () => () => {},
  };
  const connection = connectNativeTerminal(bridge, surface, createReadonlyTerminalRequest("cowork-safe", 120, 40));
  await connection.ready;
  onData?.("live");
  await connection.resize(140, 50);
  await connection.close();
  await connection.close();

  assert.deepEqual(output, ["live"]);
  assert.deepEqual(calls, [
    ["open", { session: "cowork-safe", cols: 120, rows: 40 }],
    ["resize", { id: "pty-1", cols: 140, rows: 50 }],
    ["close", { id: "pty-1" }],
  ]);
});

test("write(): llega a bridge.write({id, data}) sólo una vez la conexión está lista", async () => {
  const calls: Array<[string, unknown]> = [];
  const surface: TerminalSurface = { write: () => {} };
  const bridge: NativeTerminalBridge = {
    open: async () => { calls.push(["open", {}]); return { id: "pty-2", session: "cowork-managed", readOnly: false }; },
    resize: async () => {},
    write: async (request) => { calls.push(["write", request]); },
    close: async () => {},
    onData: () => () => {},
    onExit: () => () => {},
  };
  const connection = connectNativeTerminal(bridge, surface, createReadonlyTerminalRequest("cowork-managed", 120, 40));
  connection.write("echo hi\r"); // llamado ANTES de que resuelva `open` — no debe perderse
  await connection.ready;
  await Promise.resolve(); // deja correr el microtask de la escritura encolada
  assert.deepEqual(calls, [["open", {}], ["write", { id: "pty-2", data: "echo hi\r" }]]);
});

test("exit: se entrega TIPADO {exitCode, signal} a un callback, no como texto escrito en el buffer", async () => {
  const output: string[] = [];
  const surface: TerminalSurface = { write: (data) => output.push(data) };
  let emitExit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const bridge: NativeTerminalBridge = {
    open: async () => ({ id: "pty-3", session: "cowork-safe", readOnly: true }),
    resize: async () => {},
    write: async () => {},
    close: async () => {},
    onData: () => () => {},
    onExit: (_id, listener) => { emitExit = listener; return () => { emitExit = undefined; }; },
  };
  const exits: Array<{ exitCode: number; signal?: number }> = [];
  const connection = connectNativeTerminal(bridge, surface, createReadonlyTerminalRequest("cowork-safe", 120, 40), {
    onExit: (event) => exits.push(event),
  });
  await connection.ready;
  emitExit?.({ exitCode: 137, signal: 9 });

  assert.deepEqual(exits, [{ exitCode: 137, signal: 9 }]);
  assert.deepEqual(output, [], "el exit no se escribe como texto cosmético en el buffer");
});
