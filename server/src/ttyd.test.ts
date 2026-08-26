import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTtydManager } from "./ttyd.js";

test("startTtyd deduplica solicitudes simultáneas de la misma sesión", async () => {
  let spawned = 0;
  const manager = createTtydManager({
    hasTtyd: async () => true,
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
