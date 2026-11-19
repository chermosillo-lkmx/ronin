import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import type { Incident, IncidentOwner } from "./incident.js";
import { createMainHealthStore, type MainHealthMeasurement } from "./store.js";
import { createMainHealthRouter, type MainHealthRoutesDeps } from "./routes.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function measurement(repo: string, sha: string, status: "green" | "red" = "green"): MainHealthMeasurement {
  return {
    repo,
    sha,
    status,
    tests: 12,
    total: 93.5,
    floor: 90,
    failed: status === "red" ? ["suite::uno"] : [],
    errors: status === "red" ? ["infra"] : [],
    skipped: 0,
    skipped_by_reason: {},
    uncovered_by_file: {},
    duration: 45,
    at: sha === SHA_A ? 1_000 : 2_000,
    gate_rc: status === "red" ? 1 : 0,
  };
}

function incident(repo: string, sha: string, patch: Partial<Incident> = {}): Incident {
  return {
    id: `${repo}@${sha.slice(0, 7)}`,
    repo,
    firstRedSha: sha,
    openedAt: 3_000,
    summary: "secreto interno",
    attribution: {
      status: "no_prior_green",
      reason: "detalle interno",
      redSha: sha,
      greenSha: null,
      commits: [],
      culpritShas: [],
      newRed: [],
      unattributedRed: [],
    },
    ...patch,
  };
}

async function getStatus(deps: MainHealthRoutesDeps): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.use("/api/main-health", createMainHealthRouter(deps));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/main-health`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("GET / proyecta mediciones e incidente público en orden configurado", async () => {
  const measurements = new Map([
    ["beta", measurement("beta", SHA_B, "red")],
    ["alpha", measurement("alpha", SHA_A)],
  ]);
  const betaIncident = incident("beta", SHA_B, {
    remoteOwner: "dueño-remoto",
    claimSha: "c".repeat(40),
    claimBranch: "fix/main-health-beta",
  });
  const owner: IncidentOwner = {
    session: "cowork-main-health-beta",
    pid: 9876,
    started: 2_500,
    heartbeat: 3_500,
  };
  const { status, body } = await getStatus({
    repos: () => ["beta", "alpha"],
    store: { latestOperationalMeasurement: (repo) => measurements.get(repo) ?? null },
    incidents: {
      readIncident: (repo) => repo === "beta" ? betaIncident : null,
      readOwner: (repo) => repo === "beta" ? owner : null,
    },
  });

  assert.equal(status, 200);
  assert.deepEqual(body, [
    {
      repo: "beta",
      sha: SHA_B,
      status: "red",
      total: 93.5,
      floor: 90,
      failedCount: 2,
      measuredAt: 2_000,
      incident: {
        id: `beta@${SHA_B.slice(0, 7)}`,
        openedAt: 3_000,
        owner: { session: "cowork-main-health-beta", heartbeat: 3_500 },
        remoteOwner: "dueño-remoto",
      },
    },
    {
      repo: "alpha",
      sha: SHA_A,
      status: "green",
      total: 93.5,
      floor: 90,
      failedCount: 0,
      measuredAt: 1_000,
    },
  ]);
  const serialized = JSON.stringify(body);
  for (const forbidden of ["attribution", "claimSha", "claimBranch", "summary", "pid", "started"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("omite repos sin medición, duplicados, inseguros y veto sin tumbar filas sanas", async () => {
  const good = measurement("good", SHA_A, "green");
  const duplicate = measurement("duplicate", SHA_B, "red");
  const incidentWithoutReadableOwner = incident("good", SHA_A, { remoteOwner: "otro" });
  const { status, body } = await getStatus({
    repos: () => [
      "missing",
      "duplicate",
      "duplicate",
      "a..b",
      "a.lock",
      "trailing.",
      "ant-liebre-app",
      "corrupt",
      "throws",
      "good",
    ],
    store: {
      latestOperationalMeasurement: (repo) => {
        if (repo === "throws") throw new Error("disco roto");
        if (repo === "corrupt") return { repo, sha: SHA_A, status: "green" } as MainHealthMeasurement;
        if (repo === "duplicate") return duplicate;
        if (repo === "good") return good;
        return null;
      },
    },
    incidents: {
      readIncident: (repo) => {
        if (repo === "duplicate") throw new Error("incidente corrupto");
        return repo === "good" ? incidentWithoutReadableOwner : null;
      },
      readOwner: () => { throw new Error("owner corrupto"); },
    },
  });

  assert.equal(status, 200);
  assert.deepEqual((body as Array<Record<string, unknown>>).map(({ repo }) => repo), ["duplicate", "good"]);
  assert.equal((body as Array<Record<string, unknown>>)[0]!.incident, undefined);
  assert.deepEqual((body as Array<Record<string, unknown>>)[1]!.incident, {
    id: `good@${SHA_A.slice(0, 7)}`,
    openedAt: 3_000,
    remoteOwner: "otro",
  });
});

test("omite incidentes cerrados o con identidad inválida y owners corruptos", async () => {
  const current = measurement("current", SHA_A, "red");
  const closed = measurement("closed", SHA_B, "green");
  const corruptOwner = { session: "", heartbeat: Number.NaN } as IncidentOwner;
  const { body } = await getStatus({
    repos: () => ["current", "closed"],
    store: { latestOperationalMeasurement: (repo) => repo === "current" ? current : closed },
    incidents: {
      readIncident: (repo) => repo === "current"
        ? incident("current", SHA_A, { id: "../../escape" })
        : incident("closed", SHA_B, { closedAt: 4_000 }),
      readOwner: () => corruptOwner,
    },
  });

  assert.deepEqual((body as Array<Record<string, unknown>>).map(({ incident: value }) => value), [undefined, undefined]);
});

test("GET / conserva la medición operacional aunque un baseline histórico sea más reciente", async () => {
  const root = mkdtempSync(join(tmpdir(), "cowork-main-health-routes-"));
  try {
    const store = createMainHealthStore({ root, now: () => 3_000 });
    const main = measurement("api", SHA_A, "red");
    const historical = { ...measurement("api", SHA_B, "green"), at: 9_000 };
    store.writeMeasurement(main);
    store.confirmOperationalMeasurement("api", main.sha);
    store.writeMeasurement(historical);

    const { body } = await getStatus({
      repos: () => ["api"],
      store,
      incidents: { readIncident: () => null, readOwner: () => null },
    });

    assert.deepEqual((body as Array<Record<string, unknown>>).map(({ sha, status }) => ({ sha, status })), [
      { sha: SHA_A, status: "red" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
