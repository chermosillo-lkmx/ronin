export class RendererReadinessError extends Error {
  constructor(readonly code: "RENDERER_DEV_TIMEOUT") {
    super(code);
  }
}

export interface RendererReadinessDependencies {
  fetch(url: string, options: { cache: "no-store" }): Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null } }>;
  loadURL(url: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const DEV_URL = "http://localhost:5180/";
const DEV_TIMEOUT_MS = 30_000;

function isHtml(response: { ok: boolean; status: number; headers: { get(name: string): string | null } }): boolean {
  return response.ok && response.status >= 200 && response.status < 300 && (response.headers.get("content-type") ?? "").includes("text/html");
}

export async function waitForVite(deps: Pick<RendererReadinessDependencies, "fetch" | "sleep" | "now">): Promise<void> {
  const deadline = deps.now() + DEV_TIMEOUT_MS;
  while (deps.now() < deadline) {
    const response = await deps.fetch(DEV_URL, { cache: "no-store" }).catch(() => undefined);
    if (response && isHtml(response)) return;
    await deps.sleep(250);
  }
  throw new RendererReadinessError("RENDERER_DEV_TIMEOUT");
}

/** The sole owner of dev Vite probing and resilient renderer navigation. */
export async function loadDevRenderer(deps: RendererReadinessDependencies): Promise<void> {
  const deadline = deps.now() + DEV_TIMEOUT_MS;
  await waitForVite(deps);
  let delay = 250;
  while (deps.now() < deadline) {
    try {
      await deps.loadURL(DEV_URL);
      return;
    } catch {
      await deps.sleep(delay);
      delay = Math.min(delay * 2, 2_000);
    }
  }
  throw new RendererReadinessError("RENDERER_DEV_TIMEOUT");
}
