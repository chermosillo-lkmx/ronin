import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { APP_CSP, APP_ORIGIN, APP_SCHEME, resolveAppRequest } from "./app-protocol.js";
import { BackendSupervisor } from "./backend-supervisor.js";
import { installTerminalIpc, type AuthorityResolver, type IpcMainLike } from "./ipc.js";
import type { PtyManager } from "./pty.js";
import { loadDevRenderer, waitForVite, type RendererReadinessDependencies } from "./renderer-readiness.js";
import { installWindowSecurity, type SecurityWebContents } from "./window-security.js";

export interface DesktopWindow {
  webContents: SecurityWebContents & { executeJavaScript?(script: string): Promise<unknown> };
  loadURL(url: string): Promise<void>;
  destroy(): void;
  isDestroyed?(): boolean;
  on?(event: "did-finish-load", listener: () => void): unknown;
}

export interface ProtocolLike {
  handle(scheme: string, handler: (request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }) => Promise<Response>): void;
}

export interface DesktopDependencies {
  protocol: ProtocolLike;
  ipcMain?: IpcMainLike;
  ptyManager?: PtyManager;
  createWindow(options: { width: number; height: number; webPreferences: Record<string, unknown> }): DesktopWindow;
  createSupervisor(onExit?: () => void): BackendSupervisor;
  shell: { openExternal(url: string): Promise<void> | void };
  quit?: () => void;
  fetch(url: string, options?: Record<string, unknown>): Promise<Response>;
  readiness: Pick<RendererReadinessDependencies, "fetch" | "sleep" | "now">;
  distDir: string;
  preloadPath: string;
  /** Ruta al `capability-token` (T0.2b/capability-path.ts). Ausente ⇒ no se manda cabecera. */
  capabilityFile?: string;
}

/**
 * Lectura perezosa POR PETICIÓN, nunca cacheada: el backend puede no haber escrito el
 * archivo todavía cuando arranca este proxy (P14). El renderer NUNCA ve este valor —
 * sólo viaja de este proceso al backend por la cabecera que el fetch de abajo añade.
 */
function readCapabilityHeader(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export interface BootstrapOptions {
  dev?: boolean;
}

export interface DesktopController {
  window: DesktopWindow;
  supervisor: BackendSupervisor;
  shutdown(): Promise<void>;
}

export type InvalidatableAuthorityResolver = AuthorityResolver & { invalidate(): void };

/**
 * T6: autoridad resuelta por MAIN contra el servidor — nunca un booleano que el renderer
 * declare. `getPort()` es una función (no un valor) porque `supervisor.port` cambia con el
 * tiempo (undefined hasta que el backend está listo): sin puerto, foreign — fail-closed. Cache
 * de 2s: la misma llamada de `/api/sessions` que ya usa el inventario, no una por cada open.
 *
 * D3 (bloqueante, hallado en review): el TTL de 2s por sí solo deja una ventana real en la que
 * `openWritable` sigue resolviendo "managed" hasta 2s DESPUÉS de un `DELETE …/adopt` real — el
 * servidor quita la marca al instante, pero este cache no se enteraba hasta que expiraba solo.
 * `invalidate()` (adjunto a la función devuelta, no un tipo de retorno nuevo — así ningún
 * llamador/test existente que la trata como función plana se rompe) la limpia; el único
 * llamador es `createProtocolHandler`, que la invoca justo después de reenviar cualquier
 * mutación real sobre `/api/sessions/:name/adopt` (POST=adoptar, DELETE=soltar) — así la
 * PRÓXIMA resolución después de esa mutación siempre re-consulta, cerrando la ventana por
 * completo en vez de acortarla a un TTL más corto (que seguiría siendo una ventana, sólo menor).
 *
 * D3 (review 2): `invalidate()` sólo lo dispara `createProtocolHandler`, que ve una mutación
 * `/api/sessions/:name/adopt` SOLO cuando pasa por el esquema `app://` de Electron. En `--dev`
 * (`bootstrapDesktop({dev:true})`), `loadDevRenderer` navega la ventana a
 * `http://localhost:5180/` (el dev server de Vite) en vez de `app://ronin/` — TODO el `fetch()`
 * del renderer, incluido un adopt/release real, sale por el proxy de Vite (`web/vite.config.ts`)
 * y JAMÁS pasa por `createProtocolHandler`. La IPC de terminal (`installTerminalIpc`, que SÍ
 * consulta esta misma caché compartida) funciona igual en dev — así que en dev la caché nunca
 * se invalidaría, dejando la ventana de 2s abierta de forma permanente. `alwaysFresh` (sólo
 * `dev:true`) desactiva la caché por completo: cada resolución re-consulta, así que no hay
 * ventana que cerrar porque nunca hay nada que quede rancio. El costo (un fetch extra por cada
 * `open()`) es aceptable en dev; producción (empaquetado, sin Vite, `app://` es la ÚNICA vía)
 * sigue con el TTL + invalidate() de siempre.
 */
export function createAuthorityResolver(
  fetchImpl: (url: string, options?: Record<string, unknown>) => Promise<Response>,
  getPort: () => number | undefined,
  now: () => number = Date.now,
  options: { alwaysFresh?: boolean } = {},
): InvalidatableAuthorityResolver {
  const TTL_MS = 2000;
  let cache: { at: number; sessions: Array<{ name: string; kind: string }> } | null = null;
  const resolve = async (session: string) => {
    const port = getPort();
    if (!port) return "foreign";
    if (options.alwaysFresh || !cache || now() - cache.at > TTL_MS) {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/sessions`, { cache: "no-store" });
      const body = (await response.json()) as { sessions?: Array<{ name: string; kind: string }> };
      cache = { at: now(), sessions: Array.isArray(body.sessions) ? body.sessions : [] };
    }
    const found = cache.sessions.find((s) => s.name === session);
    return found?.kind === "managed" ? "managed" : "foreign";
  };
  return Object.assign(resolve, { invalidate: () => { cache = null; } });
}

// D3: cualquier mutación real (nunca GET/HEAD) sobre el endpoint de adopción — reenviada por
// createProtocolHandler ANTES de que este chequeo corra, así que sólo dispara sobre lo que ya
// llegó de verdad al backend, no sobre una simple lectura del inventario.
const ADOPT_MUTATION_RE = /^\/api\/sessions\/[^/]+\/adopt(?:\?.*)?$/;
function isAdoptMutation(path: string, method: string): boolean {
  return method !== "GET" && method !== "HEAD" && ADOPT_MUTATION_RE.test(path);
}

/**
 * `protocol.handle` de Electron entrega `request.headers` como una `Headers` real (WHATWG),
 * no un objeto plano — `{ ...headers }` sobre eso produce `{}` (T9, bug real: silenciosamente
 * perdía el Content-Type en cada mutación, dejando el body sin parsear en el backend).
 */
function toHeaderRecord(headers: unknown): Record<string, string> {
  if (!headers) return {};
  if (typeof (headers as Headers).entries === "function") {
    return Object.fromEntries((headers as Headers).entries());
  }
  return { ...(headers as Record<string, string>) };
}

function withCsp(response: Response, csp: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", csp);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function recoveryResponse(snapshot: string, message = "Ronin no pudo iniciar"): Response {
  const diagnostic = snapshot ? `<pre>${escapeHtml(snapshot)}</pre>` : "";
  return new Response(`<!doctype html><meta charset="utf-8"><title>Ronin recovery</title><main><h1>${escapeHtml(message)}</h1><p><a href="${APP_ORIGIN}/recovery/retry">Reintentar</a> · <a href="${APP_ORIGIN}/recovery/close">Cerrar</a></p>${diagnostic}</main>`, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": APP_CSP },
  });
}

function createProtocolHandler(
  deps: DesktopDependencies,
  supervisor: BackendSupervisor,
  authority?: InvalidatableAuthorityResolver
) {
  return async (request: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): Promise<Response> => {
    const route = resolveAppRequest(request.url, request.method, { distDir: deps.distDir });
    if (route.kind === "bad-request") return new Response("Bad request", { status: 400 });
    if (route.kind === "not-found") return new Response("Not found", { status: 404 });
    if (route.kind === "recovery") {
      if (route.action === "close") {
        deps.quit?.();
        return recoveryResponse(supervisor.recoverySnapshot(), "Ronin se está cerrando");
      }
      if (route.action === "retry") {
        try {
          await supervisor.retry();
          return new Response(null, { status: 302, headers: { Location: `${APP_ORIGIN}/` } });
        } catch {
          return recoveryResponse(supervisor.recoverySnapshot(), "Ronin no pudo reintentar el backend");
        }
      }
      return recoveryResponse(supervisor.recoverySnapshot());
    }
    if (route.kind === "asset") return withCsp(await deps.fetch(pathToFileURL(route.filePath).href), route.csp);

    const port = supervisor.port;
    if (!port) return new Response("Backend unavailable", { status: 503 });
    try {
      const capability = readCapabilityHeader(deps.capabilityFile);
      const headers = toHeaderRecord(request.headers);
      const upstreamOptions: Record<string, unknown> = {
        method: request.method,
        headers: capability === undefined ? headers : { ...headers, "x-ronin-capability": capability },
      };
      // `request.body` (cuando existe) es un ReadableStream real que entrega `protocol.handle`
      // (WHATWG Request) — el fetch de Node/Chromium exige `duplex: "half"` para cualquier body
      // en forma de stream, o lanza un TypeError que el catch de abajo convertiría, en silencio,
      // en un 503 indistinguible de un backend caído (T9, bug real).
      if (request.body !== undefined) {
        upstreamOptions.body = request.body;
        upstreamOptions.duplex = "half";
      }
      const response = await deps.fetch(`http://127.0.0.1:${port}${route.path}`, {
        ...upstreamOptions,
      });
      // D3: la mutación YA llegó al backend (aunque la respuesta sea un rechazo 4xx — invalidar
      // de más nunca es incorrecto, sólo cuesta un fetch extra en el próximo open()) — cerrar la
      // ventana de la caché de autoridad aquí, no esperar a que el TTL expire solo.
      if (isAdoptMutation(route.path, request.method)) authority?.invalidate();
      return withCsp(response, route.csp);
    } catch {
      return new Response("Backend unavailable", { status: 503 });
    }
  };
}

/** Precondition: Electron app.whenReady() has resolved. This function never registers schemes. */
export async function bootstrapDesktop(deps: DesktopDependencies, options: BootstrapOptions = {}): Promise<DesktopController> {
  const dev = options.dev === true;
  let shuttingDown = false;
  let window: DesktopWindow | undefined;
  const supervisor = deps.createSupervisor(() => {
    if (shuttingDown || !window || window.isDestroyed?.()) return;
    void window.loadURL(`${APP_ORIGIN}/recovery`).catch(() => {});
  });

  // D3: UNA sola instancia — el protocolo la invalida al ver pasar un adopt/release real, y
  // installTerminalIpc consulta esa MISMA caché al decidir managed/foreign. Dos resolvers
  // independientes (uno por sitio) dejarían al protocolo invalidando una caché que el IPC
  // nunca lee, reabriendo la ventana de D3 con otro nombre.
  // D3 (review 2): en dev, el fetch del renderer sale por el proxy de Vite, no por
  // createProtocolHandler — invalidate() nunca dispararía. alwaysFresh cierra esa vía sin caché.
  const authority = createAuthorityResolver(deps.fetch, () => supervisor.port, undefined, { alwaysFresh: dev });
  deps.protocol.handle(APP_SCHEME, createProtocolHandler(deps, supervisor, authority));
  // Un ⌘R deja vivo un `tmux attach` por recarga, y en macOS `window-all-closed` no cierra
  // la app (index.ts:78-80): sin esto, el único cleanup era el dispose de shutdown, que en
  // ese caso nunca llega. `destroyed`/`render-process-gone` son los dos eventos reales de
  // Electron para "este webContents ya no existe".
  const disposeTerminalIpc = deps.ipcMain && deps.ptyManager
    ? installTerminalIpc(
        deps.ipcMain,
        deps.ptyManager,
        (sender, cb) => {
          sender.once?.("destroyed", cb);
          sender.once?.("render-process-gone", cb);
        },
        authority,
      )
    : undefined;
  window = deps.createWindow({
    width: 1440,
    height: 920,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: deps.preloadPath,
    },
  });
  const appWindow = window;
  installWindowSecurity(appWindow.webContents, deps.shell, dev);
  try {
    await supervisor.start();
    if (dev) await waitForVite(deps.readiness);
    if (dev) {
      await loadDevRenderer({ ...deps.readiness, loadURL: (url) => appWindow.loadURL(url) });
    } else {
      await appWindow.loadURL(`${APP_ORIGIN}/`);
    }
  } catch {
    await appWindow.loadURL(`${APP_ORIGIN}/recovery`);
  }

  let shutdownPromise: Promise<void> | undefined;
  return {
    window,
    supervisor,
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        shuttingDown = true;
        disposeTerminalIpc?.();
        deps.ptyManager?.closeAll();
        await supervisor.close();
        if (!appWindow.isDestroyed?.()) appWindow.destroy();
      })();
      return shutdownPromise;
    },
  };
}
