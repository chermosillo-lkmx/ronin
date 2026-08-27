import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTtydAvailability, createTtydManager, ttydCommand } from "./ttyd.js";

test("COWORK_TTYD_BIN controla tanto la comprobación como el spawn", async () => {
  const previous = process.env.COWORK_TTYD_BIN;
  process.env.COWORK_TTYD_BIN = "/ruta/falsa/ttyd";
  try {
    const checked: string[] = [];
    const available = createTtydAvailability(async (command) => { checked.push(command); });
    assert.equal(ttydCommand(), "/ruta/falsa/ttyd");
    assert.equal(await available(), true);
    assert.deepEqual(checked, ["/ruta/falsa/ttyd"]);

    const spawned: string[] = [];
    const manager = createTtydManager({
      hasTtyd: available,
      waitReady: async () => true,
      spawn: (command) => {
        spawned.push(command);
        const proc = new EventEmitter();
        queueMicrotask(() => proc.emit("spawn"));
        return proc as any;
      },
    });
    assert.equal(await manager.start("con-bin-configurado"), 7781);
    assert.deepEqual(spawned, ["/ruta/falsa/ttyd"]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_TTYD_BIN;
    else process.env.COWORK_TTYD_BIN = previous;
  }
});

test("startTtyd deduplica solicitudes simultáneas de la misma sesión", async () => {
  let spawned = 0;
  const manager = createTtydManager({
    hasTtyd: async () => true,
    waitReady: async () => true,
    spawn: () => {
      spawned++;
      const proc = new EventEmitter();
      queueMicrotask(() => proc.emit("spawn"));
      return proc as any;
    },
  });

  const [first, second] = await Promise.all([manager.start("misma-sesion"), manager.start("misma-sesion")]);
  assert.deepEqual([first, second], [7781, 7781]);
  assert.equal(spawned, 1);
});

test("startTtyd no devuelve el puerto hasta que ttyd acepta conexiones (evita el iframe en blanco)", async () => {
  let release!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { release = resolve; });
  const manager = createTtydManager({
    hasTtyd: async () => true,
    waitReady: () => ready,
    spawn: () => { const proc = new EventEmitter(); queueMicrotask(() => proc.emit("spawn")); return proc as any; },
  });
  let settled = false;
  const pending = manager.start("lenta").then((port) => { settled = true; return port; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  release(true);
  assert.equal(await pending, 7781);
});

test("startTtyd devuelve null y mata el proceso si el puerto nunca abre", async () => {
  let killed = false;
  const manager = createTtydManager({
    hasTtyd: async () => true,
    waitReady: async () => false,
    spawn: () => { const proc = new EventEmitter() as any; proc.kill = () => { killed = true; }; queueMicrotask(() => proc.emit("spawn")); return proc; },
  });
  assert.equal(await manager.start("muerta"), null);
  assert.equal(killed, true);
  // y una segunda llamada vuelve a intentar (no queda un puerto muerto cacheado)
  assert.equal(await manager.start("muerta"), null);
});
