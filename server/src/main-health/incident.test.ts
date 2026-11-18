import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    assert.throws(() => manager.openIncident({ repo: "api", firstRedSha: "../mal", summary: "x", attribution: ATTRIBUTION }), /SHA inválido/);
    assert.equal(manager.readIncident("../api"), null);
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
