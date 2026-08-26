import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "ronin";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:*; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";

export type AppRoute =
  | { kind: "asset"; filePath: string; csp: string }
  | { kind: "api"; path: string; csp: string }
  | { kind: "recovery"; action: "view" | "retry" | "close"; csp: string }
  | { kind: "bad-request" }
  | { kind: "not-found" };

export interface AppProtocolOptions {
  distDir: string;
  exists?: (path: string) => boolean;
}

function rawPathname(rawUrl: string): string | null {
  const match = /^[a-z][a-z\d+.-]*:\/\/[^/]*(\/[^?#]*)?/i.exec(rawUrl);
  if (!match) return null;
  return match[1] || "/";
}

function hasTraversal(rawPath: string): boolean {
  try {
    return rawPath.split("/").some((segment) => {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    });
  } catch {
    return true;
  }
}

/** Resolves only validated app://ronin requests; Electron-specific I/O belongs in bootstrap. */
export function resolveAppRequest(rawUrl: string, method: string, options: AppProtocolOptions): AppRoute {
  let url: URL;
  const rawPath = rawPathname(rawUrl);
  try {
    url = new URL(rawUrl);
  } catch {
    return { kind: "bad-request" };
  }
  if (
    rawPath === null ||
    url.protocol !== `${APP_SCHEME}:` ||
    url.hostname !== APP_HOST ||
    url.port ||
    url.username ||
    url.password ||
    hasTraversal(rawPath)
  ) {
    return { kind: "bad-request" };
  }

  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("//")) return { kind: "bad-request" };
  // T9 (bug real, verificado en vivo): /api se reenvía con `url.pathname` SIN decodificar, no
  // con el `pathname` ya decodificado de arriba. Un `%N` (pane id) llega doblemente codificado
  // (`%251`, la forma correcta para que un decode LO RECUPERE) — decodificarlo aquí y reenviar
  // ese resultado le da a Express un `%1` ya "una vez decodificado", y el decode PROPIO de
  // Express sobre eso revienta con URIError (escape incompleto). El chequeo de prefijo sí puede
  // usar la versión decodificada: "/api/" es ASCII plano, la codificación no lo afecta.
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return { kind: "api", path: `${url.pathname}${url.search}`, csp: APP_CSP };
  }
  if (method !== "GET" && method !== "HEAD") return { kind: "bad-request" };
  if (pathname === "/recovery") return { kind: "recovery", action: "view", csp: APP_CSP };
  if (pathname === "/recovery/retry") return { kind: "recovery", action: "retry", csp: APP_CSP };
  if (pathname === "/recovery/close") return { kind: "recovery", action: "close", csp: APP_CSP };

  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const distDir = resolve(options.distDir);
  const filePath = resolve(join(distDir, relativePath));
  const outsideDist = isAbsolute(relative(distDir, filePath)) || relative(distDir, filePath).startsWith("..");
  if (outsideDist) return { kind: "bad-request" };
  if (!(options.exists ?? existsSync)(filePath)) return { kind: "not-found" };
  return { kind: "asset", filePath, csp: APP_CSP };
}
