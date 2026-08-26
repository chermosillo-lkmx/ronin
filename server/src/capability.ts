import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { dataPath } from "./data-dir.js";
import { constantTimeEqual } from "./security.js";

/**
 * Alcance real de esta defensa, sin adornos: protege frente a CSRF de navegador (una pestaña
 * hostil no puede leer este archivo ni poner la cabecera) y frente a procesos de OTROS
 * usuarios (el archivo es 0600). NO protege frente a otro proceso del MISMO usuario, que
 * puede leerlo y suplantar a la UI. El usuario eligió este alcance a sabiendas; no se
 * presenta como más de lo que es.
 */
export const CAPABILITY_FILE = dataPath("capability-token");

export function ensureCapabilityToken(file: string = CAPABILITY_FILE): string {
  const existing = readCapabilityToken(file);
  if (existing !== null) return existing;
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function readCapabilityToken(file: string = CAPABILITY_FILE): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

export function verifyCapability(header: string | undefined, file: string = CAPABILITY_FILE): boolean {
  const expected = readCapabilityToken(file);
  if (expected === null) return false;
  return constantTimeEqual(expected, header ?? "");
}

/**
 * Puerta general de todo `/api` no-GET (T4, B3). Deja pasar GET/HEAD/OPTIONS sin mirar nada
 * (no hay mutación que proteger). Para el resto: si el token aún no existe en disco → 503
 * fail-closed (arranque incompleto, nunca 200); si existe pero la cabecera no coincide en
 * tiempo constante → 401. Por MÉTODO, no enumerando rutas — una ruta nueva queda cubierta por
 * construcción en vez de depender de que alguien la añada a una lista.
 */
export function requireCapability(req: Request, res: Response, next: NextFunction, file: string = CAPABILITY_FILE): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  // No es una exención: /webhook/dm ya pasó por su propia puerta (requireWebhookSecret,
  // montada antes) — se deja pasar aquí, no se ignora una comprobación que nunca corrió.
  if (req.path === "/webhook/dm") return next();
  const expected = readCapabilityToken(file);
  if (expected === null) {
    res.status(503).json({ error: "capability aún no disponible", code: "CAPABILITY_UNAVAILABLE" });
    return;
  }
  if (!constantTimeEqual(expected, req.get("x-ronin-capability") ?? "")) {
    res.status(401).json({ error: "capability requerida", code: "CAPABILITY_REQUIRED" });
    return;
  }
  next();
}
