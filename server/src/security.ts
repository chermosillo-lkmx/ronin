import type { CorsOptions } from "cors";
import type { NextFunction, Request, Response } from "express";

/**
 * Hostnames que cuentan como el propio equipo. Verificado: `new URL("http://[::1]:5180").hostname`
 * devuelve `"[::1]"` CON corchetes — que es la forma que realmente llega. `"::1"` se incluye
 * igualmente por si el origen llega ya normalizado o desde un cliente que no es el navegador.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Rechaza un POST cross-site desde el navegador del operador. El bind a 127.0.0.1 protege de la
 * red, pero NO de una pestaña maliciosa en el mismo navegador: `cors()` iba sin opciones y
 * respondía el preflight de forma permisiva.
 *
 * Un POST cross-site SIEMPRE manda `Origin`; la app legítima llega por el proxy de Vite, que
 * reenvía `Origin: http://localhost:5180` (`changeOrigin: true` reescribe `Host`, no `Origin`).
 * Sin `Origin` se deja pasar: son curl, EventSource same-origin y las cargas no-cors como el
 * `<img>` de `/api/workers/:id/evidence/file/:name`.
 *
 * Un `Origin` presente pero impresentable se RECHAZA. Eso incluye el literal `null`, que es el
 * `Origin` de un iframe `sandbox` sin `allow-same-origin` — contenido que un atacante controla y
 * puede incrustar en cualquier página. Aceptarlo convertiría este guard en un filtro evadible con
 * tres atributos de HTML.
 *
 * RESTRICCIÓN QUE ESTO IMPONE A F6, y que es la salida buena: el renderer de Electron NO puede
 * cargarse desde `file://`. Desde un documento `file://` toda llamada a http://localhost:8787 es
 * cross-origin (`fetch` va en modo `cors` por defecto), así que el navegador manda `Origin: null`
 * en TODAS las peticiones, GET incluidos. F6 debe registrar un esquema propio (`app://`, vía
 * `protocol.handle()`) — que es además lo que quiere un CSP estricto — y añadirlo a LOOPBACK por
 * allowlist explícita. Un esquema concreto, nunca "cualquier cosa opaca".
 */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return LOOPBACK.has(host);
}

/**
 * OJO CON LA ASIMETRÍA, que es lo que hace falta el middleware además de esto: el paquete `cors`
 * con un callback que devuelve `false` **no rechaza nada** — llama a `next()` sin poner
 * `Access-Control-Allow-Origin` y la petición llega igual al handler (cors/lib/index.js:218-226).
 * Es decir: CORS sólo impide que el atacante LEA la respuesta; no impide que el efecto ocurra.
 * El que bloquea de verdad es `requireLocalOrigin`.
 */
export const corsOptions: CorsOptions = {
  origin(origin, cb) {
    cb(null, isLoopbackOrigin(origin ?? undefined));
  },
};

/** Rechaza con 403 cualquier petición cuyo `Origin` esté presente y no sea loopback. */
export function requireLocalOrigin(req: Request, res: Response, next: NextFunction) {
  if (!isLoopbackOrigin(req.get("origin"))) {
    return res.status(403).json({ error: "origen no permitido" });
  }
  next();
}
