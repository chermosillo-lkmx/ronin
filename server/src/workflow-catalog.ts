import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataPath } from "./data-dir.js";
import { getWorkflow, validateStages, type WorkflowConfig } from "./workflow.js";

export interface WorkflowCatalogItem {
  /** Stable identity used by launches. Renaming never changes this value. */
  id: string;
  name: string;
  config: WorkflowConfig;
  updatedAt: number;
}

export interface WorkflowCatalog {
  version: 1;
  items: WorkflowCatalogItem[];
}

function slug(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function cloneConfig(config: WorkflowConfig): WorkflowConfig {
  return { stages: config.stages.map((stage) => ({ ...stage })), verifyAfter: config.verifyAfter };
}

function cloneItem(item: WorkflowCatalogItem): WorkflowCatalogItem {
  return { ...item, config: cloneConfig(item.config) };
}

function fileFor(directory?: string): string {
  return directory ? join(directory, "workflows.json") : dataPath("workflows.json");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
}

function normalize(raw: unknown): WorkflowCatalog | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { items?: unknown }).items)) return null;
  const names = new Set<string>();
  const ids = new Set<string>();
  const items: WorkflowCatalogItem[] = [];
  for (const candidate of (raw as { items: unknown[] }).items) {
    const item = candidate as Partial<WorkflowCatalogItem>;
    const name = slug(item.name);
    if (!name || names.has(name) || !validId(item.id) || ids.has(item.id)) continue;
    try {
      const config = validateStages(item.config ?? {}, { strict: true });
      names.add(name);
      ids.add(item.id);
      items.push({ id: item.id, name, config, updatedAt: Number(item.updatedAt) || 0 });
    } catch {
      // A corrupt entry must not stop the Electron shell from starting.
    }
  }
  return { version: 1, items };
}

function defaultCatalog(): WorkflowCatalog {
  return {
    version: 1,
    items: [{ id: `wf-${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 18)}`, name: "refactor-v3", config: getWorkflow(), updatedAt: Date.now() }],
  };
}

/**
 * Read the named workflow catalog. The first read migrates the legacy global workflow so the
 * existing graph/JSON editor has a real named item without discarding its configuration.
 */
export function loadWorkflowCatalog(directory?: string): WorkflowCatalog {
  const file = fileFor(directory);
  let catalog: WorkflowCatalog | null = null;
  try {
    catalog = normalize(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // no catalog yet
  }
  if (catalog) return { version: 1, items: catalog.items.map(cloneItem) };
  const migrated = defaultCatalog();
  writeFileSync(file, JSON.stringify(migrated, null, 2) + "\n");
  return { version: 1, items: migrated.items.map(cloneItem) };
}

function writeCatalog(catalog: WorkflowCatalog, directory?: string): void {
  writeFileSync(fileFor(directory), JSON.stringify(catalog, null, 2) + "\n");
}

function requireName(value: unknown): string {
  const name = slug(value);
  if (!name) throw new Error("WORKFLOW_NAME_REQUIRED");
  return name;
}

function newId(): string {
  return `wf-${randomUUID().replace(/[^a-z0-9]/g, "").slice(0, 18)}`;
}

export function createWorkflowCatalogItem(nameInput: unknown, configInput: unknown, directory?: string): WorkflowCatalogItem {
  const name = requireName(nameInput);
  const catalog = loadWorkflowCatalog(directory);
  if (catalog.items.some((item) => item.name === name)) throw new Error("WORKFLOW_NAME_EXISTS");
  const item: WorkflowCatalogItem = {
    id: newId(),
    name,
    config: validateStages((configInput ?? {}) as Partial<WorkflowConfig>, { strict: true }),
    updatedAt: Date.now(),
  };
  catalog.items.push(item);
  writeCatalog(catalog, directory);
  return cloneItem(item);
}

/** Change name and/or config while preserving immutable `id`. */
export function updateWorkflowCatalogItem(id: string, input: { name?: unknown; config?: unknown }, directory?: string): WorkflowCatalogItem {
  const catalog = loadWorkflowCatalog(directory);
  const index = catalog.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("WORKFLOW_NOT_FOUND");
  const previous = catalog.items[index];
  const name = input.name === undefined ? previous.name : requireName(input.name);
  if (catalog.items.some((item, i) => i !== index && item.name === name)) throw new Error("WORKFLOW_NAME_EXISTS");
  const next: WorkflowCatalogItem = {
    id: previous.id,
    name,
    config: input.config === undefined ? previous.config : validateStages(input.config as Partial<WorkflowConfig>, { strict: true }),
    updatedAt: Date.now(),
  };
  catalog.items[index] = next;
  writeCatalog(catalog, directory);
  return cloneItem(next);
}

/** Remove a named workflow without allowing the catalog to become empty. */
export function deleteWorkflowCatalogItem(id: string, directory?: string): void {
  const catalog = loadWorkflowCatalog(directory);
  const index = catalog.items.findIndex((item) => item.id === id);
  if (index < 0) throw new Error("WORKFLOW_NOT_FOUND");
  if (catalog.items.length === 1) throw new Error("WORKFLOW_LAST");
  catalog.items.splice(index, 1);
  writeCatalog(catalog, directory);
}

export function findWorkflowCatalogItem(id: string, directory?: string): WorkflowCatalogItem | null {
  const found = loadWorkflowCatalog(directory).items.find((item) => item.id === id);
  return found ? cloneItem(found) : null;
}

/** Import uses the same strict validation but always gives a newly imported item a new identity. */
export function importWorkflowCatalogItem(name: unknown, config: unknown, directory?: string): WorkflowCatalogItem {
  return createWorkflowCatalogItem(name, config, directory);
}

export function workflowCatalogExists(directory?: string): boolean {
  return existsSync(fileFor(directory));
}
