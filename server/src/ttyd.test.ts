import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { tmuxArgs } from "./tmux.js";
import { createTtydAvailability, createTtydManager, ttydCommand } from "./ttyd.js";

const alwaysFree = async () => true;

function spawnCapturingArgs(captured: string[][]) {
  return (_command: string, args: readonly string[]) => {
    captured.push([...args]);
    const proc = new EventEmitter();
    queueMicrotask(() => proc.emit("spawn"));
    return proc as any;
  };
}

function spawnCapturingLaunches(captured: Array<{ args: string[]; options: { env?: NodeJS.ProcessEnv } | undefined }>) {
  return (_command: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    captured.push({ args: [...args], options });
    const proc = new EventEmitter();
    queueMicrotask(() => proc.emit("spawn"));
    return proc as any;
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("startTtyd entrega a ttyd el binario tmux configurado", async () => {
  const previous = process.env.COWORK_TMUX_BIN;
  process.env.COWORK_TMUX_BIN = "/ruta/falsa/tmux";
  try {
    const spawned: string[][] = [];
    const manager = createTtydManager({
      hasTtyd: async () => true,
      waitReady: async () => true,
      reservePort: alwaysFree,
      spawn: spawnCapturingArgs(spawned) as any,
    });

    await manager.start("con-bin-tmux-configurado");

    assert.ok(spawned[0].includes("/ruta/falsa/tmux"));
    assert.ok(!spawned[0].includes("tmux"));
  } finally {
    restoreEnv("COWORK_TMUX_BIN", previous);
  }
});

test("startTtyd entrega a ttyd los argumentos del socket tmux configurado", async () => {
  const previous = process.env.COWORK_TMUX_SOCKET;
  process.env.COWORK_TMUX_SOCKET = "/ruta/falsa/tmux.sock";
  try {
    const session = "con-socket-tmux-configurado";
    const spawned: string[][] = [];
    const manager = createTtydManager({
      hasTtyd: async () => true,
      waitReady: async () => true,
      reservePort: alwaysFree,
      spawn: spawnCapturingArgs(spawned) as any,
    });

    await manager.start(session);

    assert.deepEqual(
      spawned[0].slice(-tmuxArgs("attach", "-t", session).length),
      tmuxArgs("attach", "-t", session)
    );
  } finally {
    restoreEnv("COWORK_TMUX_SOCKET", previous);
  }
});

test("startTtyd conserva el argv de desarrollo sin configuración tmux", async () => {
  const previousBin = process.env.COWORK_TMUX_BIN;
  const previousSocket = process.env.COWORK_TMUX_SOCKET;
  delete process.env.COWORK_TMUX_BIN;
  delete process.env.COWORK_TMUX_SOCKET;
  try {
    const session = "sin-configuracion-tmux";
    const spawned: string[][] = [];
    const manager = createTtydManager({
      hasTtyd: async () => true,
      waitReady: async () => true,
      reservePort: alwaysFree,
      spawn: spawnCapturingArgs(spawned) as any,
    });

    await manager.start(session);

    assert.deepEqual(spawned, [["-p", "7781", "-i", "127.0.0.1", "-W", "-t", "fontSize=13", "tmux", "-u", "attach", "-t", session]]);
  } finally {
    restoreEnv("COWORK_TMUX_BIN", previousBin);
    restoreEnv("COWORK_TMUX_SOCKET", previousSocket);
  }
});

test("startTtyd completa LANG y LC_ALL UTF-8 cuando faltan y fuerza tmux -u", async () => {
  const previousLang = process.env.LANG;
  const previousLcAll = process.env.LC_ALL;
  delete process.env.LANG;
  delete process.env.LC_ALL;
  try {
    const spawned: Array<{ args: string[]; options: { env?: NodeJS.ProcessEnv } | undefined }> = [];
    const manager = createTtydManager({
      hasTtyd: async () => true,
      waitReady: async () => true,
      reservePort: alwaysFree,
      spawn: spawnCapturingLaunches(spawned) as any,
    });

    await manager.start("locale-ausente");

    assert.equal(spawned[0].options?.env?.LANG, "en_US.UTF-8");
    assert.equal(spawned[0].options?.env?.LC_ALL, "en_US.UTF-8");
    assert.deepEqual(spawned[0].args.slice(-5), ["tmux", "-u", "attach", "-t", "locale-ausente"]);
  } finally {
    restoreEnv("LANG", previousLang);
    restoreEnv("LC_ALL", previousLcAll);
  }
});

test("startTtyd conserva los locales configurados por el usuario", async () => {
  const previousLang = process.env.LANG;
  const previousLcAll = process.env.LC_ALL;
  process.env.LANG = "es_MX.UTF-8";
  process.env.LC_ALL = "fr_FR.UTF-8";
  try {
    const spawned: Array<{ args: string[]; options: { env?: NodeJS.ProcessEnv } | undefined }> = [];
    const manager = createTtydManager({
      hasTtyd: async () => true,
      waitReady: async () => true,
      reservePort: alwaysFree,
      spawn: spawnCapturingLaunches(spawned) as any,
    });

    await manager.start("locale-configurado");

    assert.equal(spawned[0].options?.env?.LANG, "es_MX.UTF-8");
    assert.equal(spawned[0].options?.env?.LC_ALL, "fr_FR.UTF-8");
  } finally {
    restoreEnv("LANG", previousLang);
    restoreEnv("LC_ALL", previousLcAll);
  }
});

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
      reservePort: alwaysFree,
      spawn: (command) => {
        spawned.push(command);
        const proc = new EventEmitter();
        queueMicrotask(() => proc.emit("spawn"));
        return proc as any;
      },
    });
    assert.deepEqual(await manager.start("con-bin-configurado"), { ok: true, port: 7781 });
    assert.deepEqual(spawned, ["/ruta/falsa/ttyd"]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_TTYD_BIN;
    else process.env.COWORK_TTYD_BIN = previous;
  }
});

test("startTtyd distingue que ttyd no está instalado", async () => {
  const manager = createTtydManager({
    hasTtyd: async () => false,
  });

  assert.deepEqual(await manager.start("sin-ttyd-instalado"), { ok: false, reason: "not-installed" });
});

test("startTtyd deduplica solicitudes simultáneas de la misma sesión", async () => {
  let spawned = 0;
  const manager = createTtydManager({
    hasTtyd: async () => true,
    waitReady: async () => true,
    reservePort: alwaysFree,
    spawn: () => {
      spawned++;
      const proc = new EventEmitter();
      queueMicrotask(() => proc.emit("spawn"));
      return proc as any;
    },
  });

  const [first, second] = await Promise.all([manager.start("misma-sesion"), manager.start("misma-sesion")]);
  assert.deepEqual([first, second], [{ ok: true, port: 7781 }, { ok: true, port: 7781 }]);
  assert.equal(spawned, 1);
});

test("startTtyd reutiliza el ttyd ya vivo de la misma sesión", async () => {
  let spawned = 0;
  const manager = createTtydManager({
    hasTtyd: async () => true,
    reservePort: alwaysFree,
    waitReady: async () => true,
    spawn: () => {
      spawned++;
      const proc = new EventEmitter();
      queueMicrotask(() => proc.emit("spawn"));
      return proc as any;
    },
  });

  assert.deepEqual(await manager.start("reutilizada"), { ok: true, port: 7781 });
  assert.deepEqual(await manager.start("reutilizada"), { ok: true, port: 7781 });
  assert.equal(spawned, 1);
});

test("startTtyd no devuelve el puerto hasta que ttyd acepta conexiones (evita el iframe en blanco)", async () => {
  let release!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => { release = resolve; });
  const manager = createTtydManager({
    hasTtyd: async () => true,
    waitReady: () => ready,
    reservePort: alwaysFree,
    spawn: () => { const proc = new EventEmitter(); queueMicrotask(() => proc.emit("spawn")); return proc as any; },
  });
  let settled = false;
  const pending = manager.start("lenta").then((port) => { settled = true; return port; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false);
  release(true);
  assert.deepEqual(await pending, { ok: true, port: 7781 });
});

test("startTtyd devuelve no-free-port y mata el proceso si el puerto nunca abre", async () => {
  let killed = false;
  const manager = createTtydManager({
    hasTtyd: async () => true,
    waitReady: async () => false,
    reservePort: alwaysFree,
    spawn: () => { const proc = new EventEmitter() as any; proc.kill = () => { killed = true; }; queueMicrotask(() => proc.emit("spawn")); return proc; },
  });
  assert.deepEqual(await manager.start("muerta"), { ok: false, reason: "no-free-port" });
  assert.equal(killed, true);
  // y una segunda llamada vuelve a intentar (no queda un puerto muerto cacheado)
  assert.deepEqual(await manager.start("muerta"), { ok: false, reason: "no-free-port" });
});

test("startTtyd descarta un puerto que responde si el ttyd propio ya murió", async () => {
  const spawned: string[][] = [];
  const manager = createTtydManager({
    hasTtyd: async () => true,
    reservePort: alwaysFree,
    waitReady: async () => true,
    spawn: (_command, args) => {
      spawned.push([...args]);
      const proc = new EventEmitter() as any;
      proc.exitCode = null;
      queueMicrotask(() => {
        proc.emit("spawn");
        proc.exitCode = 1;
        proc.emit("exit", 1);
      });
      return proc;
    },
  });

  assert.deepEqual(await manager.start("no-cruzar-sesiones"), { ok: false, reason: "no-free-port" });
  assert.equal(spawned.length, 10);
});

test("startTtyd salta el puerto base ocupado y lanza en el siguiente libre", async () => {
  const spawned: string[][] = [];
  const manager = createTtydManager({
    hasTtyd: async () => true,
    reservePort: async (port) => port !== 7781,
    waitReady: async () => true,
    spawn: spawnCapturingArgs(spawned) as any,
  });

  assert.deepEqual(await manager.start("puerto-base-ocupado"), { ok: true, port: 7782 });
  assert.equal(spawned[0][1], "7782");
});

test("startTtyd distingue que no queda ningún puerto candidato libre", async () => {
  let spawned = 0;
  const manager = createTtydManager({
    hasTtyd: async () => true,
    reservePort: async () => false,
    waitReady: async () => true,
    spawn: () => { spawned++; throw new Error("no debe lanzar"); },
  });

  assert.deepEqual(await manager.start("sin-puertos"), { ok: false, reason: "no-free-port" });
  assert.equal(spawned, 0);
});
