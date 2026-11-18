import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../atomic.js";
import type { MainHealthAttribution } from "./attribution.js";
import { createIncidentManager, type IncidentGitPort, type IncidentLaunchInput } from "./incident.js";

const SHA = "a".repeat(40);
const ATTRIBUTION: MainHealthAttribution = {
  status: "no_prior_green",
  reason: "sin medición verde previa",
  redSha: SHA,
  greenSha: null,
  commits: [],
  culpritShas: [],
  newRed: [],
  unattributedRed: [],
};

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-incident-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-incident-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function recoveryGuards(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.startsWith("owner.mutex.recover-") && !name.includes(".tmp-"))
    .map((name) => join(directory, name));
}

test("abre un solo incidente rojo, lo lee y lo lista", () => {
  withRoot((root) => {
    let now = 1_700_000_000_000;
    const manager = createIncidentManager({ root, now: () => now });
    const first = manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "fallaron 2 pruebas", attribution: ATTRIBUTION });
    now += 10_000;
    const duplicate = manager.openIncident({ repo: "api", firstRedSha: "b".repeat(40), summary: "otra roja", attribution: ATTRIBUTION });

    assert.deepEqual(first, {
      id: `api@${SHA.slice(0, 7)}`,
      repo: "api",
      firstRedSha: SHA,
      openedAt: 1_700_000_000_000,
      summary: "fallaron 2 pruebas",
      attribution: ATTRIBUTION,
    });
    assert.deepEqual(duplicate, first);
    assert.deepEqual(manager.readIncident("api"), first);
    assert.deepEqual(manager.listIncidents(), [first]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "incidents", "api", "incident.json"), "utf8")), first);
  });
});

test("resuelve root configurable y rechaza repo o SHA inseguros", () => {
  assert.equal(createIncidentManager({ env: { MAIN_HEALTH_DIR: "/salud" } }).root, "/salud");
  assert.equal(createIncidentManager({ env: {}, home: () => "/casa" }).root, join("/casa", ".cowork", "main-health"));
  withRoot((root) => {
    const manager = createIncidentManager({ root });
    assert.throws(() => manager.openIncident({ repo: "../api", firstRedSha: SHA, summary: "x", attribution: ATTRIBUTION }), /repo inválido/);
    assert.throws(() => manager.openIncident({ repo: "a..b", firstRedSha: SHA, summary: "x", attribution: ATTRIBUTION }), /repo inválido/);
    assert.throws(() => manager.openIncident({ repo: "a.lock", firstRedSha: SHA, summary: "x", attribution: ATTRIBUTION }), /repo inválido/);
    assert.throws(() => manager.openIncident({ repo: "a".repeat(62), firstRedSha: SHA, summary: "x", attribution: ATTRIBUTION }), /repo inválido/);
    assert.throws(() => manager.openIncident({ repo: "api", firstRedSha: "../mal", summary: "x", attribution: ATTRIBUTION }), /SHA inválido/);
    assert.equal(manager.readIncident("../api"), null);
  });
});

test("rechaza incident.json cuyo id no corresponde al repo y SHA", async () => {
  await withRootAsync(async (root) => {
    const manager = createIncidentManager({ root });
    const incident = manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    writeFileSync(join(root, "incidents", "api", "incident.json"), JSON.stringify({ ...incident, id: "../../escape" }));

    assert.equal(manager.readIncident("api"), null);
    assert.equal(await manager.closeIncident("api"), null);
  });
});

test("cierra y archiva el incidente actual; cerrar de nuevo es no-op", async () => {
  await withRootAsync(async (root) => {
    let now = 2_000;
    const manager = createIncidentManager({ root, now: () => now });
    const opened = manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    now = 3_000;

    const closed = await manager.closeIncident("api");

    assert.deepEqual(closed, { ...opened, closingAt: 3_000, closedAt: 3_000 });
    assert.equal(manager.readIncident("api"), null);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "incidents", "api.closed", `${opened.id}-3000`, "incident.json"), "utf8")),
      closed,
    );
    assert.equal(await manager.closeIncident("api"), null);
  });
});

test("owner exclusivo respeta lease y permite takeover al vencer", () => {
  withRoot((root) => {
    let now = 10_000;
    const first = createIncidentManager({ root, now: () => now, pid: () => 101, leaseMin: 1 });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    assert.deepEqual(first.claimOwner("api", "cowork-main-health-api"), {
      acquired: true,
      takeover: false,
      owner: { session: "cowork-main-health-api", pid: 101, started: 10_000, heartbeat: 10_000 },
    });

    now = 69_999;
    const second = createIncidentManager({ root, now: () => now, pid: () => 202, leaseMin: 1 });
    assert.deepEqual(second.claimOwner("api", "cowork-main-health-api-2"), {
      acquired: false,
      takeover: false,
      owner: { session: "cowork-main-health-api", pid: 101, started: 10_000, heartbeat: 10_000 },
    });

    now = 70_000;
    assert.deepEqual(second.claimOwner("api", "cowork-main-health-api-2"), {
      acquired: true,
      takeover: true,
      owner: { session: "cowork-main-health-api-2", pid: 202, started: 70_000, heartbeat: 70_000 },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(root, "incidents", "api", "owner.stale-202-70000"), "utf8")), {
      session: "cowork-main-health-api", pid: 101, started: 10_000, heartbeat: 10_000,
    });
  });
});

test("heartbeat renueva sólo el owner propio mientras su sesión vive", async () => {
  await withRootAsync(async (root) => {
      let now = 1_000;
      let alive = true;
      const manager = createIncidentManager({
        root,
        now: () => now,
        pid: () => 303,
        tmux: { hasSession: async () => alive },
      });
      manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
      manager.claimOwner("api", "cowork-main-health-api");
      now = 2_000;
      assert.equal(await manager.heartbeatOwner("api"), true);
      assert.equal(manager.readOwner("api")?.heartbeat, 2_000);

      alive = false;
      now = 3_000;
      assert.equal(await manager.heartbeatOwner("api"), false);
      assert.equal(manager.readOwner("api")?.heartbeat, 2_000);

      const other = createIncidentManager({ root, now: () => now, pid: () => 404, tmux: { hasSession: async () => true } });
      assert.equal(await other.heartbeatOwner("api"), false);
      assert.equal(manager.readOwner("api")?.heartbeat, 2_000);
  });
});

test("takeover relee sin sobrescribir cuando pierde la carrera de rename", () => {
  withRoot((root) => {
    const incidentDir = join(root, "incidents", "api");
    const first = createIncidentManager({ root, now: () => 1_000, pid: () => 11, leaseMin: 1 });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    first.claimOwner("api", "cowork-viejo");
    let raced = false;
    const winner = { session: "cowork-ganador", pid: 22, started: 70_000, heartbeat: 70_000 };
    const contender = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 33,
      leaseMin: 1,
      fs: {
        rename(source, target) {
          if (!raced && source === join(incidentDir, "owner.json")) {
            raced = true;
            renameSync(source, join(incidentDir, "owner.stale-22-70000"));
            writeFileSync(source, JSON.stringify(winner));
            const error = new Error("otro proceso ganó") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return renameSync(source, target);
        },
      },
    });

    assert.deepEqual(contender.claimOwner("api", "cowork-contendiente"), {
      acquired: false,
      takeover: false,
      owner: winner,
    });
    assert.deepEqual(JSON.parse(readFileSync(join(incidentDir, "owner.json"), "utf8")), winner);
  });
});

test("mutex impide que un segundo contender adquiera owner durante la ventana de takeover", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");

    let resultB: ReturnType<typeof original.claimOwner> | undefined;
    const contenderB = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 22,
      leaseMin: 1,
      pidAlive: (ownerPid) => ownerPid === 11,
      mutexToken: () => "token-b-22222222",
    });
    let interleaved = false;
    const contenderA = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 11,
      leaseMin: 1,
      pidAlive: (ownerPid) => ownerPid === 11,
      mutexToken: () => "token-a-11111111",
      fs: {
        rename(source, target) {
          if (!interleaved && source === join(directory, "owner.json")) {
            interleaved = true;
            const renamed = renameSync(source, target);
            resultB = contenderB.claimOwner("api", "cowork-b");
            return renamed;
          }
          return renameSync(source, target);
        },
      },
    });

    const resultA = contenderA.claimOwner("api", "cowork-a");

    assert.equal(resultA.acquired, true);
    assert.equal(resultB?.acquired, false);
    assert.equal(resultB?.owner, null);
    assert.deepEqual(contenderA.readOwner("api"), resultA.owner);
    assert.equal(contenderA.readOwner("api")?.session, "cowork-a");
    assert.equal(existsSync(join(directory, "owner.mutex.json")), false);
  });
});

test("recupera mutex de owner cuando su PID ya no vive", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");
    writeFileSync(join(directory, "owner.mutex.json"), JSON.stringify({ token: "token-muerto", pid: 999, createdAt: 1_000 }));
    const contender = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 33,
      leaseMin: 1,
      pidAlive: () => false,
      mutexToken: () => "token-vivo-33333333",
    });

    const result = contender.claimOwner("api", "cowork-nuevo");

    assert.equal(result.acquired, true);
    assert.equal(result.owner?.session, "cowork-nuevo");
    assert.equal(existsSync(join(directory, "owner.mutex.json")), false);
    assert.equal(recoveryGuards(directory).length, 1);
  });
});

test("guard de recovery impide que un loser retire el mutex vivo instalado por el ganador", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const mutex = join(directory, "owner.mutex.json");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");
    writeFileSync(mutex, JSON.stringify({ token: "token-muerto", pid: 999, createdAt: 1_000 }));

    let resultA: ReturnType<typeof original.claimOwner> | undefined;
    const contenderA = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 11,
      leaseMin: 1,
      pidAlive: (ownerPid) => ownerPid === 11,
      mutexToken: () => "token-a-11111111",
    });
    let interleaved = false;
    const contenderB = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 22,
      leaseMin: 1,
      pidAlive: (ownerPid) => ownerPid === 11,
      mutexToken: () => "token-b-22222222",
      fs: {
        link(source, target) {
          if (!interleaved && String(target).includes("owner.mutex.recover-") && !String(target).includes(".tmp-")) {
            interleaved = true;
            // B ya leyó el mutex muerto. A gana recovery completo antes de que B continúe.
            resultA = contenderA.claimOwner("api", "cowork-a");
          }
          return linkSync(source, target);
        },
      },
    });

    const resultB = contenderB.claimOwner("api", "cowork-b");

    assert.equal(resultA?.acquired, true);
    assert.equal(resultB.acquired, false);
    assert.equal(contenderA.readOwner("api")?.session, "cowork-a");
    assert.equal(contenderB.claimOwner("api", "cowork-b").acquired, false);
    assert.equal(contenderA.readOwner("api")?.session, "cowork-a");
    assert.equal(recoveryGuards(directory).length, 1);
  });
});

test("encadena guard generacional si el recuperador anterior muere antes de reemplazar mutex", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const mutex = join(directory, "owner.mutex.json");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");
    writeFileSync(mutex, JSON.stringify({ token: "token-muerto", pid: 999, createdAt: 1_000 }));

    const dyingRecovery = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 88,
      leaseMin: 1,
      pidAlive: () => false,
      mutexToken: () => "token-recuperador-8888",
      fs: {
        unlink(target) {
          if (target === mutex) throw new Error("recuperador murió antes de reemplazar");
          return rmSync(target);
        },
      },
    });

    assert.throws(
      () => dyingRecovery.claimOwner("api", "cowork-no-llega"),
      /recuperador murió antes de reemplazar/,
    );
    const baseGuard = recoveryGuards(directory)[0];
    assert.deepEqual(JSON.parse(readFileSync(baseGuard, "utf8")), {
      observed: { pid: 999, token: "token-muerto", createdAt: 1_000 },
      recovery: { pid: 88, token: "token-recuperador-8888", createdAt: 70_000 },
    });
    assert.deepEqual(JSON.parse(readFileSync(mutex, "utf8")), { token: "token-muerto", pid: 999, createdAt: 1_000 });

    const successor = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 99,
      leaseMin: 1,
      pidAlive: () => false,
      mutexToken: () => "token-sucesor-99999999",
    });
    const result = successor.claimOwner("api", "cowork-recuperado");

    assert.equal(result.acquired, true);
    assert.equal(result.owner?.session, "cowork-recuperado");
    const childGuard = recoveryGuards(directory)
      .find((target) => JSON.parse(readFileSync(target, "utf8")).recovery.pid === 99);
    assert.ok(childGuard);
    assert.deepEqual(JSON.parse(readFileSync(childGuard, "utf8")), {
      observed: { pid: 999, token: "token-muerto", createdAt: 1_000 },
      recovery: { pid: 99, token: "token-sucesor-99999999", createdAt: 70_000 },
    });
  });
});

test("el mismo proceso reintenta recovery tras una excepción operacional", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const mutex = join(directory, "owner.mutex.json");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");
    writeFileSync(mutex, JSON.stringify({ token: "token-muerto", pid: 999, createdAt: 1_000 }));
    const tokens = ["token-primer-intento-7777", "token-segundo-intento-777"];
    let failOnce = true;
    const manager = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 77,
      leaseMin: 1,
      pidAlive: (ownerPid) => ownerPid === 77,
      mutexToken: () => tokens.shift()!,
      fs: {
        unlink(target) {
          if (failOnce && target === mutex) {
            failOnce = false;
            throw new Error("fallo operacional después del guard");
          }
          return rmSync(target);
        },
      },
    });

    assert.throws(() => manager.claimOwner("api", "cowork-retry"), /fallo operacional/);
    const result = manager.claimOwner("api", "cowork-retry");

    assert.equal(result.acquired, true);
    assert.equal(result.owner?.session, "cowork-retry");
    assert.equal(recoveryGuards(directory).length, 2);
  });
});

test("recovery progresa por una cadena mayor a ocho generaciones muertas", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const mutex = join(directory, "owner.mutex.json");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");
    writeFileSync(mutex, JSON.stringify({ token: "token-muerto", pid: 999, createdAt: 1_000 }));

    for (let index = 0; index < 10; index += 1) {
      const dying = createIncidentManager({
        root,
        now: () => 70_000,
        pid: () => 100 + index,
        leaseMin: 1,
        pidAlive: () => false,
        mutexToken: () => `token-generacion-${String(index).padStart(8, "0")}`,
        fs: {
          unlink(target) {
            if (target === mutex) throw new Error(`muere generación ${index}`);
            return rmSync(target);
          },
        },
      });
      assert.throws(() => dying.claimOwner("api", `cowork-dying-${index}`), new RegExp(`muere generación ${index}`));
    }

    const successor = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 500,
      leaseMin: 1,
      pidAlive: () => false,
      mutexToken: () => "token-final-50000000",
    });
    const result = successor.claimOwner("api", "cowork-final");

    assert.equal(result.acquired, true);
    assert.equal(result.owner?.session, "cowork-final");
    assert.equal(recoveryGuards(directory).length, 11);
  });
});

test("recupera mutex vencido aunque el PID haya sido reutilizado y siga vivo", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const original = createIncidentManager({ root, now: () => 1_000, pid: () => 1, leaseMin: 1 });
    original.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    original.claimOwner("api", "cowork-viejo");
    writeFileSync(join(directory, "owner.mutex.json"), JSON.stringify({ token: "token-pid-reusado", pid: 77, createdAt: 1_000 }));
    const contender = createIncidentManager({
      root,
      now: () => 70_000,
      pid: () => 77,
      pidAlive: () => true,
      mutexLeaseMs: 30_000,
      leaseMin: 1,
      mutexToken: () => "token-nueva-generacion-77",
    });

    const result = contender.claimOwner("api", "cowork-nuevo");

    assert.equal(result.acquired, true);
    assert.equal(result.owner?.session, "cowork-nuevo");
  });
});

test("publicación indivisible del mutex nunca deja JSON parcial visible", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    let failWrites = false;
    const manager = createIncidentManager({
      root,
      pid: () => 44,
      mutexToken: () => "token-falla-44444444",
      fs: {
        write(fd, buffer, offset, length, position) {
          if (failWrites) throw new Error("falla al preparar mutex");
          const data = typeof buffer === "string" ? Buffer.from(buffer) : buffer as Uint8Array;
          const start = typeof offset === "number" ? offset : 0;
          const requested = typeof length === "number" ? length : data.byteLength - start;
          return writeSync(fd, data, start, requested, typeof position === "number" ? position : null);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    failWrites = true;

    assert.throws(() => manager.claimOwner("api", "cowork-a"), /falla al preparar mutex/);
    assert.equal(existsSync(join(directory, "owner.mutex.json")), false);
    assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("owner.mutex.tmp-")), []);

    const retry = createIncidentManager({ root, pid: () => 55 });
    assert.equal(retry.claimOwner("api", "cowork-b").acquired, true);
  });
});

test("writeFully completa short writes al publicar mutex y owner", () => {
  withRoot((root) => {
    const manager = createIncidentManager({
      root,
      pid: () => 66,
      fs: {
        write(fd, buffer, offset, length, position) {
          const data = typeof buffer === "string" ? Buffer.from(buffer) : buffer as Uint8Array;
          const start = typeof offset === "number" ? offset : 0;
          const requested = typeof length === "number" ? length : data.byteLength - start;
          return writeSync(fd, data, start, Math.min(requested, 3), typeof position === "number" ? position : null);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const result = manager.claimOwner("api", "cowork-short-write");

    assert.equal(result.acquired, true);
    assert.equal(manager.readOwner("api")?.session, "cowork-short-write");
  });
});

test("fallo preparando owner no deja target parcial y permite reintento", () => {
  withRoot((root) => {
    const directory = join(root, "incidents", "api");
    const manager = createIncidentManager({
      root,
      pid: () => 67,
      fs: {
        write(fd, buffer, offset, length, position) {
          const data = typeof buffer === "string" ? Buffer.from(buffer) : buffer as Uint8Array;
          const text = Buffer.from(data).toString("utf8");
          if (text.includes("session")) throw new Error("falla preparando owner");
          const start = typeof offset === "number" ? offset : 0;
          const requested = typeof length === "number" ? length : data.byteLength - start;
          return writeSync(fd, data, start, requested, typeof position === "number" ? position : null);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    assert.throws(() => manager.claimOwner("api", "cowork-falla"), /falla preparando owner/);
    assert.equal(existsSync(join(directory, "owner.json")), false);
    assert.deepEqual(readdirSync(directory).filter((name) => name.startsWith("owner.json.tmp-")), []);
    assert.equal(createIncidentManager({ root, pid: () => 68 }).claimOwner("api", "cowork-retry").acquired, true);
  });
});

test("claim remoto crea una sola rama y anota al ganador cuando el push es rechazado", async () => {
  await withRootAsync(async (root) => {
    const repoDir = join(root, "repo");
    const remoteDir = join(root, "remote.git");
    git(root, "init", "--bare", remoteDir);
    git(root, "init", "-b", "main", repoDir);
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, "README.md"), "base\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "chore: base");
    const redSha = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "remote", "add", "origin", remoteDir);

    const first = createIncidentManager({ root: join(root, "health"), now: () => 1_700_000_000_000, pid: () => 111, host: () => "host-a" });
    first.openIncident({ repo: "api", firstRedSha: redSha, summary: "rojo", attribution: { ...ATTRIBUTION, redSha } });
    const accepted = await first.claimRemote("api", repoDir);
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.branch, "fix/main-health-api");
    assert.equal(git(repoDir, "rev-parse", `${accepted.claimSha}^`), redSha);
    const message = git(repoDir, "show", "-s", "--format=%B", accepted.claimSha!);
    assert.match(message, /host-a/);
    assert.match(message, /111/);
    assert.match(message, /2023-11-14T22:13:20.000Z/);
    assert.equal(git(remoteDir, "rev-parse", "refs/heads/fix/main-health-api"), accepted.claimSha);
    assert.equal(first.readIncident("api")?.claimSha, accepted.claimSha);
    assert.equal(first.readIncident("api")?.claimBranch, "fix/main-health-api");

    const second = createIncidentManager({ root: join(root, "health-contender"), now: () => 1_700_000_001_000, pid: () => 222, host: () => "host-b" });
    second.openIncident({ repo: "api", firstRedSha: redSha, summary: "rojo", attribution: { ...ATTRIBUTION, redSha } });
    const rejected = await second.claimRemote("api", repoDir);
    assert.deepEqual(rejected, {
      accepted: false,
      branch: "fix/main-health-api",
      claimSha: rejected.claimSha,
      remoteOwner: accepted.claimSha,
    });
    assert.notEqual(rejected.claimSha, accepted.claimSha);
    assert.equal(second.readIncident("api")?.remoteOwner, accepted.claimSha);
    assert.equal(git(remoteDir, "rev-parse", "refs/heads/fix/main-health-api"), accepted.claimSha);
  });
});

test("ensureFixer reutiliza claim propio si el primer launch falla", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let commits = 0;
    let pushes = 0;
    let launches = 0;
    const sessions = new Set<string>();
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") { commits += 1; return `${claimSha}\n`; }
        if (args[0] === "push") { pushes += 1; return ""; }
        if (args[0] === "ls-remote") return `${claimSha}\trefs/heads/fix/main-health-api\n`;
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    const manager = createIncidentManager({
      root,
      pid: () => 801,
      workflowId: () => "wf-reintento",
      settings: { aliases: {}, autoFix: true, remoteClaim: true },
      tmux: { hasSession: async (session) => sessions.has(session) },
      git: gitPort,
      launch: {
        async launchManagedSession(input) {
          launches += 1;
          if (launches === 1) throw new Error("launch temporal");
          const name = input.name;
          sessions.add(name);
          return { name };
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await assert.rejects(() => manager.ensureFixer("api", "/repo"), /launch temporal/);
    const second = await manager.ensureFixer("api", "/repo");

    assert.deepEqual(second, { status: "launched", session: "cowork-main-health-api" });
    assert.equal(commits, 1);
    assert.equal(pushes, 1);
    assert.equal(launches, 2);
    assert.equal(manager.readIncident("api")?.claimSha, claimSha);
    assert.equal(manager.readIncident("api")?.remoteOwner, undefined);
  });
});

test("claim propio vuelve a publicar el mismo SHA si la rama remota desaparece", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let commits = 0;
    let pushes = 0;
    const manager = createIncidentManager({
      root,
      git: {
        async run(args) {
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") { commits += 1; return `${claimSha}\n`; }
          if (args[0] === "push") { pushes += 1; remoteSha = args[2]!.split(":", 1)[0]!; return ""; }
          if (args[0] === "ls-remote") return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const first = await manager.claimRemote("api", "/repo");
    remoteSha = null;
    const repeated = await manager.claimRemote("api", "/repo");

    assert.deepEqual(repeated, first);
    assert.equal(commits, 1);
    assert.equal(pushes, 2);
  });
});

test("persiste la intención antes del push y reutiliza el claim tras una caída con efecto remoto", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let commits = 0;
    let pushes = 0;
    const manager = createIncidentManager({
      root,
      git: {
        async run(args) {
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") { commits += 1; return `${claimSha}\n`; }
          if (args[0] === "push") {
            pushes += 1;
            remoteSha = claimSha;
            throw new Error("conexión perdida después del push");
          }
          if (args[0] === "ls-remote") return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await assert.rejects(() => manager.claimRemote("api", "/repo"), /conexión perdida/);
    assert.equal(manager.readIncident("api")?.claimSha, claimSha);
    const retried = await manager.claimRemote("api", "/repo");

    assert.deepEqual(retried, { accepted: true, branch: "fix/main-health-api", claimSha });
    assert.equal(commits, 1);
    assert.equal(pushes, 1);
  });
});

test("close retira sólo claim propio y un incidente posterior puede reclamar", async () => {
  await withRootAsync(async (root) => {
    const repoDir = join(root, "repo-close");
    const remoteDir = join(root, "remote-close.git");
    git(root, "init", "--bare", remoteDir);
    git(root, "init", "-b", "main", repoDir);
    git(repoDir, "config", "user.name", "Ada Tester");
    git(repoDir, "config", "user.email", "ada@example.com");
    writeFileSync(join(repoDir, "README.md"), "uno\n");
    git(repoDir, "add", "README.md");
    git(repoDir, "commit", "-m", "chore: uno");
    const firstRed = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "remote", "add", "origin", remoteDir);
    const manager = createIncidentManager({ root: join(root, "health"), pid: () => 901 });
    manager.openIncident({ repo: "api", firstRedSha: firstRed, summary: "rojo uno", attribution: { ...ATTRIBUTION, redSha: firstRed } });
    const firstClaim = await manager.claimRemote("api", repoDir);

    await assert.rejects(() => manager.closeIncident("api"), /repoDir.*claim/i);
    assert.equal(manager.readIncident("api")?.claimSha, firstClaim.claimSha);

    await manager.closeIncident("api", repoDir);

    assert.equal(git(repoDir, "ls-remote", "origin", "refs/heads/fix/main-health-api"), "");
    writeFileSync(join(repoDir, "README.md"), "dos\n");
    git(repoDir, "commit", "-am", "chore: dos");
    const secondRed = git(repoDir, "rev-parse", "HEAD");
    manager.openIncident({ repo: "api", firstRedSha: secondRed, summary: "rojo dos", attribution: { ...ATTRIBUTION, redSha: secondRed } });
    const secondClaim = await manager.claimRemote("api", repoDir);
    assert.equal(secondClaim.accepted, true);
    assert.notEqual(secondClaim.claimSha, firstClaim.claimSha);

    git(repoDir, "push", "--force", "origin", `${secondRed}:refs/heads/fix/main-health-api`);
    await manager.closeIncident("api", repoDir);
    assert.equal(git(repoDir, "ls-remote", "origin", "refs/heads/fix/main-health-api").split(/\s+/)[0], secondRed);
  });
});

test("close marca el incidente antes de esperar Git y bloquea fixers locales y externos", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let now = 1_000;
    let launches = 0;
    let pauseNextLookup = false;
    let paused = false;
    let releaseLookup: () => void = () => {};
    let reportLookup: () => void = () => {};
    const lookupPaused = new Promise<void>((resolve) => { reportLookup = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") return `${claimSha}\n`;
        if (args[0] === "ls-remote") {
          if (pauseNextLookup && !paused) {
            paused = true;
            reportLookup();
            await lookupGate;
          }
          return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
        }
        if (args[0] === "push") {
          if (args.includes(":refs/heads/fix/main-health-api")) remoteSha = null;
          else remoteSha = claimSha;
          return "";
        }
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    const deps = {
      root,
      now: () => now,
      pid: () => 811,
      settings: { aliases: {}, autoFix: true, remoteClaim: true },
      tmux: { hasSession: async () => false },
      git: gitPort,
      launch: {
        launchManagedSession: async () => {
          launches += 1;
          return { name: "cowork-main-health-api" };
        },
      },
    } as const;
    const manager = createIncidentManager(deps);
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    await manager.claimRemote("api", "/repo");
    now = 2_000;
    pauseNextLookup = true;

    const closing = manager.closeIncident("api", "/repo");
    await lookupPaused;
    let assertionFailure: unknown;
    try {
      assert.equal(manager.readIncident("api")?.closingAt, 2_000);
      assert.equal(manager.closeIncident("api", "/repo"), closing);
      assert.deepEqual(await manager.ensureFixer("api", "/repo"), { status: "busy", session: null });
      const otherManager = createIncidentManager({ ...deps, pid: () => 812 });
      assert.deepEqual(await otherManager.ensureFixer("api", "/repo"), { status: "busy", session: null });
      await assert.rejects(() => otherManager.claimRemote("api", "/repo"), /se está cerrando/);
      assert.equal(launches, 0);
    } catch (error) {
      assertionFailure = error;
    } finally {
      releaseLookup();
    }

    const closed = await closing;
    if (assertionFailure) throw assertionFailure;
    assert.equal(closed?.closingAt, 2_000);
    assert.equal(manager.readIncident("api"), null);
    assert.equal(remoteSha, null);
  });
});

test("close conserva closingAt si falla cleanup y permite reintentar", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let now = 1_000;
    let deletionAttempts = 0;
    const manager = createIncidentManager({
      root,
      now: () => now,
      git: {
        async run(args) {
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") return `${claimSha}\n`;
          if (args[0] === "ls-remote") return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
          if (args[0] === "push" && args.includes(":refs/heads/fix/main-health-api")) {
            deletionAttempts += 1;
            if (deletionAttempts === 1) throw new Error("remote temporalmente caído");
            remoteSha = null;
            return "";
          }
          if (args[0] === "push") { remoteSha = claimSha; return ""; }
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    await manager.claimRemote("api", "/repo");
    now = 2_000;

    await assert.rejects(() => manager.closeIncident("api", "/repo"), /remote temporalmente caído/);
    assert.equal(manager.readIncident("api")?.closingAt, 2_000);
    now = 3_000;
    const closed = await manager.closeIncident("api", "/repo");

    assert.equal(closed?.closingAt, 2_000);
    assert.equal(closed?.closedAt, 3_000);
    assert.equal(deletionAttempts, 2);
    assert.equal(manager.readIncident("api"), null);
  });
});

test("close de otro manager drena un claim cuyo push ya está en vuelo", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let reportPush: () => void = () => {};
    let releasePush: () => void = () => {};
    const pushStarted = new Promise<void>((resolve) => { reportPush = resolve; });
    const pushGate = new Promise<void>((resolve) => { releasePush = resolve; });
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") return `${claimSha}\n`;
        if (args[0] === "ls-remote") return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
        if (args[0] === "push" && args.includes(":refs/heads/fix/main-health-api")) {
          remoteSha = null;
          return "";
        }
        if (args[0] === "push") {
          reportPush();
          await pushGate;
          remoteSha = claimSha;
          return "";
        }
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    const first = createIncidentManager({ root, pid: () => 1_001, pidAlive: () => true, git: gitPort });
    const second = createIncidentManager({ root, pid: () => 1_002, pidAlive: () => true, git: gitPort });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const claiming = first.claimRemote("api", "/repo");
    await pushStarted;
    let closeSettled = false;
    const closing = second.closeIncident("api", "/repo");
    void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let midFlightFailure: unknown;
    try {
      assert.equal(closeSettled, false);
      assert.notEqual(second.readIncident("api"), null);
    } catch (error) {
      midFlightFailure = error;
    } finally {
      releasePush();
    }

    const [claimOutcome, closeOutcome] = await Promise.allSettled([claiming, closing]);
    if (midFlightFailure) throw midFlightFailure;
    assert.equal(claimOutcome.status, "fulfilled");
    assert.equal(closeOutcome.status, "fulfilled");
    assert.equal(remoteSha, null);
    assert.equal(second.readIncident("api"), null);
  });
});

test("close externo espera launch y rewrite de owner antes de archivar", async () => {
  await withRootAsync(async (root) => {
    let now = 1_000;
    let launches = 0;
    let archivedOwnerHeartbeat: number | null = null;
    let reportLaunch: () => void = () => {};
    let releaseLaunch: () => void = () => {};
    const launchStarted = new Promise<void>((resolve) => { reportLaunch = resolve; });
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const sessions = new Set<string>();
    const first = createIncidentManager({
      root,
      now: () => now,
      pid: () => 1_101,
      pidAlive: () => true,
      workflowId: () => "wf-close",
      settings: { aliases: {}, autoFix: true, remoteClaim: false },
      tmux: { hasSession: async (session) => sessions.has(session) },
      launch: {
        async launchManagedSession(input) {
          launches += 1;
          reportLaunch();
          await launchGate;
          const session = input.name;
          sessions.add(session);
          return { name: session };
        },
      },
    });
    const incidentDirectory = join(root, "incidents", "api");
    const second = createIncidentManager({
      root,
      now: () => now,
      pid: () => 1_102,
      pidAlive: () => true,
      settings: { aliases: {}, autoFix: true, remoteClaim: false },
      tmux: { hasSession: async (session) => sessions.has(session) },
      fs: {
        rename(oldPath, newPath) {
          if (oldPath === incidentDirectory && String(newPath).includes("api.closed")) {
            archivedOwnerHeartbeat = JSON.parse(readFileSync(join(incidentDirectory, "owner.json"), "utf8")).heartbeat;
          }
          renameSync(oldPath, newPath);
        },
      },
    });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const fixing = first.ensureFixer("api", "/repo");
    await launchStarted;
    let closeSettled = false;
    const closing = second.closeIncident("api");
    void closing.then(() => { closeSettled = true; }, () => { closeSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let midFlightFailure: unknown;
    try {
      assert.equal(closeSettled, false);
      assert.notEqual(second.readIncident("api"), null);
    } catch (error) {
      midFlightFailure = error;
    } finally {
      now = 2_000;
      releaseLaunch();
    }

    const [fixOutcome, closeOutcome] = await Promise.allSettled([fixing, closing]);
    if (midFlightFailure) throw midFlightFailure;
    assert.equal(fixOutcome.status, "fulfilled");
    assert.equal(closeOutcome.status, "fulfilled");
    assert.equal(archivedOwnerHeartbeat, 2_000);
    assert.equal(launches, 1);
    assert.equal(second.readIncident("api"), null);
  });
});

test("dos managers cierran concurrentemente con un solo cleanup y archivo", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let deletionAttempts = 0;
    let pauseLookup = false;
    let lookupPaused = false;
    let reportLookup: () => void = () => {};
    let releaseLookup: () => void = () => {};
    const lookupStarted = new Promise<void>((resolve) => { reportLookup = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") return `${claimSha}\n`;
        if (args[0] === "ls-remote") {
          if (pauseLookup && !lookupPaused) {
            lookupPaused = true;
            reportLookup();
            await lookupGate;
          }
          return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
        }
        if (args[0] === "push" && args.includes(":refs/heads/fix/main-health-api")) {
          deletionAttempts += 1;
          remoteSha = null;
          return "";
        }
        if (args[0] === "push") { remoteSha = claimSha; return ""; }
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    const first = createIncidentManager({ root, pid: () => 1_201, pidAlive: () => true, git: gitPort });
    const second = createIncidentManager({ root, pid: () => 1_202, pidAlive: () => true, git: gitPort });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    await first.claimRemote("api", "/repo");
    pauseLookup = true;

    const firstClose = first.closeIncident("api", "/repo");
    await lookupStarted;
    const secondClose = second.closeIncident("api", "/repo");
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseLookup();
    const outcomes = await Promise.allSettled([firstClose, secondClose]);

    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"]);
    const closedValues = outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : null);
    assert.equal(closedValues.filter(Boolean).length, 1);
    assert.equal(deletionAttempts, 1);
    assert.equal(readdirSync(join(root, "incidents", "api.closed")).length, 1);
  });
});

test("close recupera leases durables de un proceso muerto sin esperar indefinidamente", async () => {
  await withRootAsync(async (root) => {
    const manager = createIncidentManager({
      root,
      now: () => 10_000,
      pid: () => 1_302,
      pidAlive: (candidate) => candidate === 1_302,
      operationLeaseMs: 100,
      operationPollMs: 1,
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    const directory = join(root, "incidents", "api");
    const operationToken = "dead-operation-token";
    const closeToken = "dead-close-token";
    writeFileSync(join(directory, `operation-${operationToken}.json`), JSON.stringify({
      token: operationToken,
      pid: 1_301,
      kind: "claim",
      createdAt: 1_000,
      heartbeat: 1_000,
    }));
    writeFileSync(join(directory, "close.lease.json"), JSON.stringify({
      token: closeToken,
      pid: 1_301,
      createdAt: 1_000,
      heartbeat: 1_000,
    }));

    const closed = await manager.closeIncident("api");

    assert.equal(closed?.repo, "api");
    assert.equal(manager.readIncident("api"), null);
    const archive = join(root, "incidents", "api.closed", `${closed!.id}-${closed!.closedAt}`);
    assert.equal(readdirSync(archive).some((entry) => entry.startsWith("operation-")), false);
    assert.equal(readdirSync(archive).some((entry) => entry.startsWith("close.lease.stale-")), true);
  });
});

test("close nunca roba una operación cuyo PID sigue vivo aunque venza el heartbeat", async () => {
  await withRootAsync(async (root) => {
    let operationAlive = true;
    const manager = createIncidentManager({
      root,
      now: () => 10_000,
      pid: () => 1_312,
      pidAlive: (candidate) => candidate === 1_312 || (candidate === 1_311 && operationAlive),
      operationLeaseMs: 100,
      operationPollMs: 1,
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    const directory = join(root, "incidents", "api");
    const operationToken = "live-operation-token";
    writeFileSync(join(directory, `operation-${operationToken}.json`), JSON.stringify({
      token: operationToken,
      pid: 1_311,
      kind: "claim",
      createdAt: 1_000,
      heartbeat: 1_000,
    }));

    let settled = false;
    const closing = manager.closeIncident("api");
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    operationAlive = false;
    const closed = await closing;
    assert.equal(closed?.repo, "api");
  });
});

test("close recupera marker stale cuando el PID vivo pertenece a otro nacimiento", async () => {
  await withRootAsync(async (root) => {
    let pidStillAlive = true;
    const manager = createIncidentManager({
      root,
      now: () => 10_000,
      pid: () => 1_311,
      pidAlive: () => pidStillAlive,
      processStartToken: () => "birth-new",
      processIdentity: () => ({ host: "host-a", startToken: "birth-new" }),
      host: () => "host-a",
      operationLeaseMs: 100,
      operationPollMs: 1,
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    const directory = join(root, "incidents", "api");
    const operationToken = "reused-pid-operation";
    writeFileSync(join(directory, `operation-${operationToken}.json`), JSON.stringify({
      token: operationToken,
      pid: 1_311,
      host: "host-a",
      processStartToken: "birth-old",
      kind: "claim",
      createdAt: 1_000,
      heartbeat: 1_000,
    }));

    let settled = false;
    const closing = manager.closeIncident("api");
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recoveredWhilePidWasAlive = settled;
    pidStillAlive = false;
    await closing;

    assert.equal(recoveredWhilePidWasAlive, true);
  });
});

test("resolver default recupera otro PID local cuyo birth token cambió", async () => {
  await withRootAsync(async (root) => {
    let pidStillAlive = true;
    const manager = createIncidentManager({
      root,
      now: () => 10_000,
      pid: () => 1_401,
      pidAlive: () => pidStillAlive,
      processStartToken: () => "birth-manager",
      processStartTokenForPid: (candidate) => candidate === 1_400 ? "birth-new" : "birth-manager",
      host: () => "host-local",
      operationLeaseMs: 100,
      operationPollMs: 1,
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    const token = "other-local-reused-pid";
    writeFileSync(join(root, "incidents", "api", `operation-${token}.json`), JSON.stringify({
      token,
      pid: 1_400,
      host: "host-local",
      processStartToken: "birth-old",
      kind: "claim",
      createdAt: 1_000,
      heartbeat: 1_000,
    }));

    let settled = false;
    const closing = manager.closeIncident("api");
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recoveredWhilePidWasAlive = settled;
    pidStillAlive = false;
    await closing;

    assert.equal(recoveredWhilePidWasAlive, true);
  });
});

test("lease de host remoto ignora PID local coincidente y vence sólo por edad", async () => {
  await withRootAsync(async (root) => {
    let now = 1_000;
    const manager = createIncidentManager({
      root,
      now: () => now,
      pid: () => 1_501,
      pidAlive: () => true,
      processStartToken: () => "birth-local",
      processIdentity: () => ({ host: "host-local", startToken: "birth-local" }),
      host: () => "host-local",
      operationLeaseMs: 100,
      operationPollMs: 1,
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    const token = "remote-host-same-pid";
    writeFileSync(join(root, "incidents", "api", `operation-${token}.json`), JSON.stringify({
      token,
      pid: 1_501,
      host: "host-remoto",
      processStartToken: "birth-remoto",
      kind: "claim",
      createdAt: now,
      heartbeat: now,
    }));

    let settled = false;
    const closing = manager.closeIncident("api");
    void closing.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stolenWhileFresh = settled;
    now += 101;
    await closing;

    assert.equal(stolenWhileFresh, false);
  });
});

test("release reintenta unlink transitorio y no deja marker vivo bloqueando close", async () => {
  await withRootAsync(async (root) => {
    let operationUnlinkAttempts = 0;
    const claimSha = "c".repeat(40);
    const manager = createIncidentManager({
      root,
      pidAlive: () => true,
      fs: {
        unlink(path) {
          if (/\/operation-[^/]+\.json$/.test(String(path))) {
            operationUnlinkAttempts += 1;
            if (operationUnlinkAttempts <= 2) {
              const error = new Error("unlink transitorio") as NodeJS.ErrnoException;
              error.code = "EIO";
              throw error;
            }
          }
          unlinkSync(path);
        },
      },
      git: {
        async run(args) {
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") return `${claimSha}\n`;
          if (args[0] === "ls-remote") return `${claimSha}\trefs/heads/fix/main-health-api\n`;
          if (args[0] === "push") return "";
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await manager.claimRemote("api", "/repo");
    const closed = await manager.closeIncident("api", "/repo");

    assert.equal(operationUnlinkAttempts, 3);
    assert.equal(closed?.repo, "api");
  });
});

test("release reintenta completed fallido y siempre detiene el heartbeat", async () => {
  await withRootAsync(async (root) => {
    let completedWrites = 0;
    let heartbeatStopped = false;
    const claimSha = "c".repeat(40);
    const manager = createIncidentManager({
      root,
      operationLeaseMs: 1_000_000,
      heartbeatScheduler() {
        return () => { heartbeatStopped = true; };
      },
      atomicWrite(target, value) {
        if (typeof value === "object"
          && value !== null
          && "state" in value
          && value.state === "completed") {
          completedWrites += 1;
          if (completedWrites === 1) throw new Error("write completed transitorio");
        }
        writeJsonAtomic(target, value);
      },
      git: {
        async run(args) {
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") return `${claimSha}\n`;
          if (args[0] === "ls-remote") return `${claimSha}\trefs/heads/fix/main-health-api\n`;
          if (args[0] === "push") return "";
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await manager.claimRemote("api", "/repo");
    const closed = await manager.closeIncident("api", "/repo");

    assert.equal(completedWrites, 2);
    assert.equal(heartbeatStopped, true);
    assert.equal(closed?.repo, "api");
  });
});

test("incident y heartbeat de protocolo completan short writes con JSON legible", async () => {
  await withRootAsync(async (root) => {
    let incidentSnapshot: unknown;
    let heartbeatSnapshot: unknown;
    let reportPush: () => void = () => {};
    let releasePush: () => void = () => {};
    const pushStarted = new Promise<void>((resolve) => { reportPush = resolve; });
    const pushGate = new Promise<void>((resolve) => { releasePush = resolve; });
    const manager = createIncidentManager({
      root,
      operationLeaseMs: 1,
      fs: {
        write(fd, buffer, offset, length, position) {
          const data = typeof buffer === "string" ? Buffer.from(buffer) : buffer as Uint8Array;
          const start = typeof offset === "number" ? offset : 0;
          const requested = typeof length === "number" ? length : data.byteLength - start;
          return writeSync(fd, data, start, Math.min(requested, 3), typeof position === "number" ? position : null);
        },
        rename(oldPath, newPath) {
          const oldName = String(oldPath);
          const newName = String(newPath);
          if (oldName.includes(".atomic-") && newName.endsWith("/incident.json")) {
            incidentSnapshot = JSON.parse(readFileSync(oldPath, "utf8"));
          }
          if (oldName.includes(".atomic-") && /\/operation-[^/]+\.json$/.test(newName)) {
            const parsed = JSON.parse(readFileSync(oldPath, "utf8"));
            if (parsed.state === "active") heartbeatSnapshot = parsed;
          }
          renameSync(oldPath, newPath);
        },
      },
      git: {
        async run(args) {
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") return `${"c".repeat(40)}\n`;
          if (args[0] === "push") {
            reportPush();
            await pushGate;
            return "";
          }
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const claiming = manager.claimRemote("api", "/repo");
    await pushStarted;
    for (let turn = 0; turn < 1_000 && !heartbeatSnapshot; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    releasePush();
    await claiming;

    assert.equal((incidentSnapshot as { repo?: string } | undefined)?.repo, "api");
    assert.equal((heartbeatSnapshot as { state?: string } | undefined)?.state, "active");
    assert.deepEqual(
      readdirSync(join(root, "incidents", "api")).filter((entry) => entry.includes(".atomic-")),
      [],
    );
  });
});

test("rename final ocurre bajo el mutex durable del protocolo", async () => {
  await withRootAsync(async (root) => {
    const incidentDirectory = join(root, "incidents", "api");
    let renameHeldMutex = false;
    const first = createIncidentManager({
      root,
      pid: () => 1_321,
      pidAlive: () => true,
      operationPollMs: 1,
      fs: {
        rename(oldPath, newPath) {
          if (oldPath === incidentDirectory && String(newPath).includes("api.closed")) {
            renameHeldMutex = existsSync(join(incidentDirectory, "owner.mutex.json"));
          }
          renameSync(oldPath, newPath);
        },
      },
    });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const firstResult = await first.closeIncident("api");

    assert.equal(firstResult?.repo, "api");
    assert.equal(renameHeldMutex, true);
  });
});

test("closingAt no borra la intención de claim persistida concurrentemente", async () => {
  await withRootAsync(async (root) => {
    const claimSha = "c".repeat(40);
    let remoteSha: string | null = null;
    let closing: Promise<unknown> | undefined;
    let closeScheduled = false;
    let staleIncident: string | undefined;
    let servedStaleIncident = false;
    let second!: ReturnType<typeof createIncidentManager>;
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") return `${claimSha}\n`;
        if (args[0] === "ls-remote") return remoteSha ? `${remoteSha}\trefs/heads/fix/main-health-api\n` : "";
        if (args[0] === "push" && args.includes(":refs/heads/fix/main-health-api")) {
          remoteSha = null;
          return "";
        }
        if (args[0] === "push") {
          remoteSha = claimSha;
          return "";
        }
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    const first = createIncidentManager({
      root,
      pid: () => 1_401,
      pidAlive: () => true,
      git: gitPort,
      atomicWrite(target, value) {
        if (!closeScheduled
          && typeof value === "object"
          && value !== null
          && "claimSha" in value) {
          closeScheduled = true;
          staleIncident = readFileSync(target, "utf8");
          closing = Promise.resolve().then(() => second.closeIncident("api", "/repo"));
        }
        writeJsonAtomic(target, value);
      },
    });
    second = createIncidentManager({
      root,
      pid: () => 1_402,
      pidAlive: () => true,
      git: gitPort,
      fs: {
        readFile(path, options) {
          if (!servedStaleIncident
            && staleIncident
            && path === join(root, "incidents", "api", "incident.json")
            && !existsSync(join(root, "incidents", "api", "owner.mutex.json"))) {
            servedStaleIncident = true;
            return staleIncident;
          }
          return readFileSync(path, options as never);
        },
      },
    });
    first.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await first.claimRemote("api", "/repo");
    assert.ok(closing);
    await closing;

    assert.equal(remoteSha, null);
    assert.equal(second.readIncident("api"), null);
  });
});

test("claim remoto propaga un fallo operativo de push sin inventar owner", async () => {
  await withRootAsync(async (root) => {
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") return `${"c".repeat(40)}\n`;
        if (args[0] === "push") throw new Error("failed to push some refs: hook remoto caído");
        if (args[0] === "ls-remote") return `${"d".repeat(40)}\trefs/heads/fix/main-health-api\n`;
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    const manager = createIncidentManager({ root, git: gitPort });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await assert.rejects(() => manager.claimRemote("api", "/repo"), /hook remoto caído/);
    assert.equal(manager.readIncident("api")?.remoteOwner, undefined);
  });
});

test("ensureFixer adopta sesión por alias aun con autoFix apagado", async () => {
  await withRootAsync(async (root) => {
    const launches: IncidentLaunchInput[] = [];
    const manager = createIncidentManager({
      root,
      pid: () => 501,
      now: () => 5_000,
      workflowId: () => { throw new Error("no debe resolver workflow al adoptar"); },
      settings: { aliases: { "repo-largo": "api" }, autoFix: false, remoteClaim: true },
      tmux: { hasSession: async (session) => session === "cowork-main-health-api" },
      launch: { launchManagedSession: async (input) => { launches.push(input); return { name: `cowork-${input.name}` }; } },
    });
    manager.openIncident({ repo: "repo-largo", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const result = await manager.ensureFixer("repo-largo", "/repo/no-usado");

    assert.deepEqual(result, { status: "adopted", session: "cowork-main-health-api" });
    assert.equal(manager.readOwner("repo-largo")?.session, "cowork-main-health-api");
    assert.deepEqual(launches, []);
  });
});

test("ensureFixer lanza una sola vez con request completo cuando remoteClaim está apagado", async () => {
  await withRootAsync(async (root) => {
    const sessions = new Set<string>();
    const launches: IncidentLaunchInput[] = [];
    const manager = createIncidentManager({
      root,
      pid: () => 601,
      now: () => 6_000,
      workflowId: () => "wf-estable-resuelto",
      settings: { aliases: { "repo-largo": "api" }, autoFix: true, remoteClaim: false },
      tmux: { hasSession: async (session) => sessions.has(session) },
      launch: {
        launchManagedSession: async (input) => {
          launches.push(input);
          const name = input.name;
          sessions.add(name);
          return { name };
        },
      },
    });
    const incident = manager.openIncident({ repo: "repo-largo", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    const first = await manager.ensureFixer("repo-largo", "/repo/no-usado");
    const repeated = await manager.ensureFixer("repo-largo", "/repo/no-usado");

    assert.deepEqual(first, { status: "launched", session: "cowork-main-health-api" });
    assert.deepEqual(repeated, { status: "active", session: "cowork-main-health-api" });
    assert.equal(launches.length, 1);
    assert.deepEqual({ ...launches[0], request: undefined }, {
      repo: "repo-largo",
      workflowId: "wf-estable-resuelto",
      name: "cowork-main-health-api",
      mode: "workflow",
      request: undefined,
    });
    assert.match(launches[0].request, new RegExp(incident.id));
    assert.match(launches[0].request, /fix\/main-health-repo-largo/);
    assert.match(launches[0].request, /sin medición verde previa/);
    assert.equal(manager.readOwner("repo-largo")?.session, "cowork-main-health-api");
  });
});

test("ensureFixer falla cerrado sin workflow y libera owner para reintento", async () => {
  await withRootAsync(async (root) => {
    let resolved: string | null = null;
    let launches = 0;
    const gitCalls: string[][] = [];
    const manager = createIncidentManager({
      root,
      pid: () => 602,
      workflowId: () => resolved,
      settings: { aliases: {}, autoFix: true, remoteClaim: true },
      tmux: { hasSession: async () => false },
      git: {
        async run(args) {
          gitCalls.push(args);
          if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
          if (args[0] === "commit-tree") return `${"c".repeat(40)}\n`;
          if (args[0] === "ls-remote") return "";
          if (args[0] === "push") return "";
          throw new Error(`Git inesperado: ${args.join(" ")}`);
        },
      },
      launch: {
        launchManagedSession: async (input) => {
          launches += 1;
          return { name: input.name };
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    await assert.rejects(() => manager.ensureFixer("api", "/repo"), /workflow.*no disponible/i);
    assert.equal(launches, 0);
    assert.deepEqual(gitCalls, [], "catálogo ausente falla antes de crear o publicar claim remoto");
    assert.equal(manager.readOwner("api"), null, "un resolver fallido no deja ownership bloqueado");

    resolved = "wf-recuperado";
    assert.deepEqual(await manager.ensureFixer("api", "/repo"), {
      status: "launched", session: "cowork-main-health-api",
    });
    assert.equal(launches, 1);
    assert.ok(gitCalls.some(([command]) => command === "push"));
  });
});

test("ensureFixer no lanza cuando otro proceso ganó el claim remoto", async () => {
  await withRootAsync(async (root) => {
    const remoteOwner = "d".repeat(40);
    const gitPort: IncidentGitPort = {
      async run(args) {
        if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
        if (args[0] === "commit-tree") return `${"c".repeat(40)}\n`;
        if (args[0] === "ls-remote") return `${remoteOwner}\trefs/heads/fix/main-health-api\n`;
        if (args[0] === "push") throw new Error("[rejected] non-fast-forward");
        throw new Error(`Git inesperado: ${args.join(" ")}`);
      },
    };
    let launches = 0;
    const manager = createIncidentManager({
      root,
      pid: () => 701,
      now: () => 7_000,
      settings: { aliases: {}, autoFix: true, remoteClaim: true },
      tmux: { hasSession: async () => false },
      git: gitPort,
      launch: { launchManagedSession: async () => { launches += 1; return { name: "no-debe-ocurrir" }; } },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

    assert.deepEqual(await manager.ensureFixer("api", "/repo"), {
      status: "remote-owned",
      session: null,
      remoteOwner,
    });
    assert.equal(launches, 0);
    assert.equal(manager.readOwner("api"), null);
    assert.equal(manager.readIncident("api")?.remoteOwner, remoteOwner);
    assert.deepEqual(await manager.ensureFixer("api", "/repo"), {
      status: "remote-owned",
      session: null,
      remoteOwner,
    });
  });
});
