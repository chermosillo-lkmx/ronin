import assert from "node:assert/strict";
import test from "node:test";
import { createPaneTerminal, type PaneTerminalDeps } from "./pane-terminal.js";

function baseDeps(overrides: Partial<PaneTerminalDeps> = {}): { deps: PaneTerminalDeps; writes: string[]; clearCount: () => number; resizes: Array<[number, number]>; sendKeysCalls: unknown[] } {
  const writes: string[] = [];
  let clears = 0;
  const resizes: Array<[number, number]> = [];
  const sendKeysCalls: unknown[] = [];
  const surface = {
    write: (data: string) => writes.push(data),
    resize: (cols: number, rows: number) => resizes.push([cols, rows] as [number, number]),
    clear: () => { clears++; },
  };
  const deps: PaneTerminalDeps = {
    kind: "managed",
    session: "cowork-safe",
    paneId: "%1",
    surface,
    capture: async () => ({ status: "ok", content: "hello", size: { cols: 80, rows: 24 } }),
    sendKeys: async (request) => { sendKeysCalls.push(request); },
    ...overrides,
  };
  return { deps, writes, clearCount: () => clears, resizes, sendKeysCalls };
}

test("createPaneTerminal: sesión foreign expone readOnly, y onData NO llama al canal de envío", () => {
  const { deps, sendKeysCalls } = baseDeps({ kind: "foreign" });
  const terminal = createPaneTerminal(deps);
  assert.equal(terminal.readOnly, true);
  terminal.onData("echo ok\r");
  assert.deepEqual(sendKeysCalls, []);
});

test("createPaneTerminal: sesión managed, onData llama a sendKeys EXACTAMENTE una vez con esos datos", async () => {
  const { deps, sendKeysCalls } = baseDeps({ kind: "managed" });
  const terminal = createPaneTerminal(deps);
  assert.equal(terminal.readOnly, false);
  terminal.onData("echo ok\r");
  await new Promise((r) => setTimeout(r, 0)); // la cola de envío corre en microtask/tick, no síncrona
  assert.equal(sendKeysCalls.length, 1);
  assert.deepEqual(sendKeysCalls[0], { session: "cowork-safe", paneId: "%1", data: "echo ok\r" });
});

test("createPaneTerminal: una captura 'gone' pasa a estado gone, deja de pedir, y onData posterior no envía nada", async () => {
  let captureCalls = 0;
  const { deps, sendKeysCalls } = baseDeps({
    kind: "managed",
    capture: async () => { captureCalls++; return { status: "gone", content: null, size: undefined }; },
  });
  const terminal = createPaneTerminal(deps);
  await terminal.poll();
  assert.equal(terminal.state, "gone");
  assert.equal(terminal.readOnly, true);

  await terminal.poll(); // "deja de pedir": una segunda llamada no debe volver a capturar
  assert.equal(captureCalls, 1);

  terminal.onData("echo ok\r");
  assert.deepEqual(sendKeysCalls, []);
});

test("createPaneTerminal: poll() limpia el buffer real (incluido scrollback) antes del contenido nuevo", async () => {
  const { deps, writes, clearCount } = baseDeps({ capture: async () => ({ status: "ok", content: "screen text", size: { cols: 80, rows: 24 } }) });
  const terminal = createPaneTerminal(deps);
  await terminal.poll();
  assert.equal(clearCount(), 1);
  assert.deepEqual(writes, ["screen text"]);
});

test("createPaneTerminal: si el size del pane cambia, redimensiona la superficie ANTES de escribir — nunca escribe un buffer de 65 filas en una terminal de 24 (bug real: scrollback sin límite)", async () => {
  const { deps, writes, clearCount, resizes } = baseDeps({
    capture: async () => ({ status: "ok", content: "screen text", size: { cols: 185, rows: 65 } }),
  });
  const terminal = createPaneTerminal(deps);
  await terminal.poll();
  assert.deepEqual(resizes, [[185, 65]]);
  assert.equal(clearCount(), 1);
  assert.deepEqual(writes, ["screen text"]);
});

test("createPaneTerminal: si el size NO cambió respecto al poll anterior, no vuelve a redimensionar", async () => {
  const { deps, resizes } = baseDeps({
    capture: async () => ({ status: "ok", content: "screen text", size: { cols: 80, rows: 24 } }),
  });
  const terminal = createPaneTerminal(deps);
  await terminal.poll();
  await terminal.poll();
  assert.deepEqual(resizes, [[80, 24]]);
});

test("createPaneTerminal: onData EN RÁFAGA (una tecla por llamada) llega a sendKeys EN ORDEN — bug real: peticiones concurrentes desordenaban las teclas (\"echo\" llegó como \"ehco\")", async () => {
  const order: string[] = [];
  // Latencia por carácter DECRECIENTE (30, 20, 10, 0ms): sin serializar, la petición de "o"
  // (0ms) resuelve ANTES que la de "e" (30ms) y el orden observado sería "ohce", no "echo" —
  // exactamente el bug reproducido en vivo contra tmux real.
  const delayFor: Record<string, number> = { e: 30, c: 20, h: 10, o: 0 };
  const { deps } = baseDeps({
    sendKeys: async (request) => {
      await new Promise((r) => setTimeout(r, delayFor[request.data] ?? 0));
      order.push(request.data);
    },
  });
  const terminal = createPaneTerminal(deps);
  terminal.onData("e");
  terminal.onData("c");
  terminal.onData("h");
  terminal.onData("o");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(order, ["e", "c", "h", "o"]);
});
