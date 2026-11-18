import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("rechaza incident.json cuyo id no corresponde al repo y SHA", () => {
  withRoot((root) => {
    const manager = createIncidentManager({ root });
    const incident = manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    writeFileSync(join(root, "incidents", "api", "incident.json"), JSON.stringify({ ...incident, id: "../../escape" }));

    assert.equal(manager.readIncident("api"), null);
  });
});

test("cierra y archiva el incidente actual; cerrar de nuevo es no-op", () => {
  withRoot((root) => {
    let now = 2_000;
    const manager = createIncidentManager({ root, now: () => now });
    const opened = manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });
    now = 3_000;

    const closed = manager.closeIncident("api");

    assert.deepEqual(closed, { ...opened, closedAt: 3_000 });
    assert.equal(manager.readIncident("api"), null);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "incidents", "api.closed", `${opened.id}-3000`, "incident.json"), "utf8")),
      closed,
    );
    assert.equal(manager.closeIncident("api"), null);
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
    const manager = createIncidentManager({
      root,
      pid: () => 44,
      mutexToken: () => "token-falla-44444444",
      fs: {
        write() {
          throw new Error("falla al preparar mutex");
        },
      },
    });
    manager.openIncident({ repo: "api", firstRedSha: SHA, summary: "rojo", attribution: ATTRIBUTION });

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

    const second = createIncidentManager({ root: join(root, "health"), now: () => 1_700_000_001_000, pid: () => 222, host: () => "host-b" });
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
      settings: { aliases: { "repo-largo": "api" }, autoFix: true, remoteClaim: false },
      tmux: { hasSession: async (session) => sessions.has(session) },
      launch: {
        launchManagedSession: async (input) => {
          launches.push(input);
          const name = `cowork-${input.name}`;
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
      workflowId: "claude-plan-codex-impl",
      name: "main-health-api",
      mode: "workflow",
      request: undefined,
    });
    assert.match(launches[0].request, new RegExp(incident.id));
    assert.match(launches[0].request, /fix\/main-health-repo-largo/);
    assert.match(launches[0].request, /sin medición verde previa/);
    assert.equal(manager.readOwner("repo-largo")?.session, "cowork-main-health-api");
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
