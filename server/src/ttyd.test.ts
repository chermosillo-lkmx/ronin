import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTtydManager } from "./ttyd.js";

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
