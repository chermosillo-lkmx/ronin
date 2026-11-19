import { Router } from "express";
import type { Incident, IncidentOwner, IncidentManager } from "./incident.js";
import { isMainHealthMeasurement, type MainHealthMeasurement, type MainHealthStore } from "./store.js";

const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_SHA = /^[A-Fa-f0-9]{7,64}$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VETOED_REPO = "ant-liebre-app";

type RoutesStore = Pick<MainHealthStore, "latestOperationalMeasurement">;
type RoutesIncidents = Pick<IncidentManager, "readIncident" | "readOwner">;

export interface MainHealthRoutesDeps {
  repos(): string[];
  store: RoutesStore;
  incidents: RoutesIncidents;
}

interface PublicOwner {
  session: string;
  heartbeat: number;
}

interface PublicIncident {
  id: string;
  openedAt: number;
  owner?: PublicOwner;
  remoteOwner?: string;
}

interface MainHealthStatusRow {
  repo: string;
  sha: string;
  status: "green" | "red";
  total: number | null;
  floor: number | null;
  failedCount: number;
  measuredAt: number;
  incident?: PublicIncident;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRepo(repo: string): boolean {
  return repo !== VETOED_REPO
    && repo.length <= 61
    && SAFE_REPO.test(repo)
    && !repo.includes("..")
    && !repo.endsWith(".")
    && !repo.toLowerCase().endsWith(".lock");
}

function validMeasurement(value: unknown, repo: string): value is MainHealthMeasurement {
  return isMainHealthMeasurement(value)
    && value.repo === repo
    && SAFE_SHA.test(value.sha);
}

function validOpenIncident(value: unknown, repo: string): value is Incident {
  if (!isRecord(value)) return false;
  return value.repo === repo
    && typeof value.firstRedSha === "string"
    && SAFE_SHA.test(value.firstRedSha)
    && value.id === `${repo}@${value.firstRedSha.slice(0, 7)}`
    && typeof value.openedAt === "number"
    && Number.isFinite(value.openedAt)
    && value.closedAt === undefined
    && (value.remoteOwner === undefined || typeof value.remoteOwner === "string");
}

function validOwner(value: unknown): value is IncidentOwner {
  if (!isRecord(value)) return false;
  return typeof value.session === "string"
    && SAFE_SESSION.test(value.session)
    && Number.isInteger(value.pid)
    && (value.pid as number) > 0
    && typeof value.started === "number"
    && Number.isFinite(value.started)
    && typeof value.heartbeat === "number"
    && Number.isFinite(value.heartbeat);
}

function readPublicIncident(deps: MainHealthRoutesDeps, repo: string): PublicIncident | undefined {
  let value: Incident | null;
  try {
    value = deps.incidents.readIncident(repo);
  } catch {
    return undefined;
  }
  if (!validOpenIncident(value, repo)) return undefined;

  const incident: PublicIncident = {
    id: value.id,
    openedAt: value.openedAt,
    ...(value.remoteOwner === undefined ? {} : { remoteOwner: value.remoteOwner }),
  };
  try {
    const owner = deps.incidents.readOwner(repo);
    if (validOwner(owner)) {
      incident.owner = { session: owner.session, heartbeat: owner.heartbeat };
    }
  } catch {
    // Un owner corrupto o en reemplazo no oculta el resto del estado del repo.
  }
  return incident;
}

/** Router aislado; el servidor principal decide después dónde montarlo. */
export function createMainHealthRouter(deps: MainHealthRoutesDeps): Router {
  const router = Router();
  router.get("/", (_request, response) => {
    let configured: string[];
    try {
      configured = deps.repos();
    } catch {
      configured = [];
    }
    const rows: MainHealthStatusRow[] = [];
    const seen = new Set<string>();
    for (const repo of configured) {
      if (typeof repo !== "string" || seen.has(repo)) continue;
      seen.add(repo);
      if (!safeRepo(repo)) continue;

      let measurement: MainHealthMeasurement | null;
      try {
        measurement = deps.store.latestOperationalMeasurement(repo);
      } catch {
        continue;
      }
      if (!validMeasurement(measurement, repo)) continue;
      const incident = readPublicIncident(deps, repo);
      rows.push({
        repo,
        sha: measurement.sha,
        status: measurement.status,
        total: measurement.total,
        floor: measurement.floor,
        failedCount: measurement.failed.length + measurement.errors.length,
        measuredAt: measurement.at,
        ...(incident ? { incident } : {}),
      });
    }
    response.status(200).json(rows);
  });
  return router;
}
