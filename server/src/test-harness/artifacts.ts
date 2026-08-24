import { XMLParser, XMLValidator } from "fast-xml-parser";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Coverage, FailedCase, TestTotals } from "./model.js";

/**
 * Lectura de artefactos (JUnit / Cobertura XML / LCOV) y redacción de evidencia. Este módulo no
 * ejecuta nada ni conoce perfiles: recibe texto o rutas ya validadas y devuelve estructuras
 * normalizadas. La cobertura sólo se reporta cuando se leyó un artefacto válido; su ausencia es
 * `not_reported`, nunca un 0%.
 */

export interface JUnitSummary {
  totals: TestTotals;
  failures: FailedCase[];
}

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_FAILURES = 200;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

type Node = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function attr(node: Node | undefined, name: string): string | undefined {
  const v = node?.[`@_${name}`];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function parseXml(text: string, what: string): Node {
  if (XMLValidator.validate(text) !== true) throw new Error(`${what} inválido: XML mal formado`);
  return parser.parse(text) as Node;
}

function messageOf(node: unknown): string {
  if (typeof node === "string") return node.slice(0, 2000);
  if (typeof node === "object" && node !== null) {
    const n = node as Node;
    return (attr(n, "message") ?? (typeof n["#text"] === "string" ? n["#text"] : "") ?? "").slice(0, 2000);
  }
  return "";
}

function walkSuites(node: Node, totals: TestTotals, failures: FailedCase[]): void {
  for (const suite of asArray(node.testsuite as Node | Node[] | undefined)) {
    for (const tc of asArray(suite.testcase as Node | Node[] | undefined)) {
      totals.total++;
      const name = attr(tc, "name") ?? "(sin nombre)";
      const classname = attr(tc, "classname");
      const record = (message: string): FailedCase => ({ name, ...(classname ? { classname } : {}), message });
      if (tc.failure !== undefined) {
        totals.failed++;
        if (failures.length < MAX_FAILURES) failures.push(record(messageOf(asArray(tc.failure)[0])));
      } else if (tc.error !== undefined) {
        totals.errors++;
        if (failures.length < MAX_FAILURES) failures.push(record(messageOf(asArray(tc.error)[0])));
      } else if (tc.skipped !== undefined) {
        totals.skipped++;
      } else {
        totals.passed++;
      }
    }
    walkSuites(suite, totals, failures);
  }
}

export function summarizeJUnit(text: string): JUnitSummary {
  const doc = parseXml(text, "JUnit");
  const root: Node = {};
  if (doc.testsuites !== undefined) {
    const ts = asArray(doc.testsuites as Node | Node[]);
    root.testsuite = ts.flatMap((t) => asArray(t.testsuite as Node | Node[] | undefined));
  } else if (doc.testsuite !== undefined) {
    root.testsuite = doc.testsuite;
  } else {
    throw new Error("JUnit inválido: no hay <testsuite>");
  }
  const totals: TestTotals = { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 };
  const failures: FailedCase[] = [];
  walkSuites(root, totals, failures);
  return { totals, failures };
}

function pct(rate: number): number {
  return Math.round(rate * 10000) / 100;
}

export function summarizeCobertura(text: string): Coverage {
  let doc: Node;
  try {
    doc = parseXml(text, "Cobertura");
  } catch (e) {
    return { status: "invalid", reason: (e as Error).message };
  }
  const cov = asArray(doc.coverage as Node | Node[] | undefined)[0];
  const lineRate = Number(attr(cov, "line-rate"));
  if (!cov || !Number.isFinite(lineRate)) return { status: "invalid", reason: "Cobertura inválido: falta <coverage line-rate>" };
  const out: Coverage = { status: "reported", lines: pct(lineRate) };
  const branchRate = Number(attr(cov, "branch-rate"));
  if (attr(cov, "branch-rate") !== undefined && Number.isFinite(branchRate)) out.branches = pct(branchRate);
  return out;
}

export function summarizeLcov(text: string): Coverage {
  let lf = 0, lh = 0, brf = 0, brh = 0, records = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(LF|LH|BRF|BRH):(\d+)$/.exec(line);
    if (m) {
      const n = Number(m[2]);
      if (m[1] === "LF") lf += n;
      else if (m[1] === "LH") lh += n;
      else if (m[1] === "BRF") brf += n;
      else brh += n;
    } else if (line === "end_of_record") records++;
  }
  if (records === 0 || lf === 0) return { status: "invalid", reason: "LCOV inválido: sin registros LF/end_of_record" };
  const out: Coverage = { status: "reported", lines: pct(lh / lf) };
  if (brf > 0) out.branches = pct(brh / brf);
  return out;
}

export function readCoverageFile(file: string | undefined, format: "cobertura" | "lcov"): Coverage {
  if (!file) return { status: "not_reported", reason: "sin ruta de cobertura declarada" };
  if (!existsSync(file)) return { status: "not_reported", reason: `cobertura no encontrada: ${basename(file)}` };
  const text = readFileSync(file, "utf8");
  return format === "cobertura" ? summarizeCobertura(text) : summarizeLcov(text);
}

export function readJUnitFile(file: string | undefined): { summary?: JUnitSummary; reason?: string } {
  if (!file) return { reason: "sin junitPath declarado" };
  if (!existsSync(file)) return { reason: `JUnit no encontrado: ${basename(file)}` };
  try {
    return { summary: summarizeJUnit(readFileSync(file, "utf8")) };
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HEADER_RE = /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)\s*:\s*)(.*)$/gim;
const AUTH_SCHEME_RE = /((?:bearer|basic|token)\s+)(\S+)/gi;

/**
 * Redacta ANTES de persistir: valores de variables del perfil (literal, los más largos primero
 * para que un valor contenido en otro no deje restos), cabeceras de credenciales y esquemas
 * Bearer/Basic. Un valor vacío o de 1-2 caracteres no se redacta (borraría texto legítimo).
 */
export function redactEvidence(text: string, secrets: readonly string[]): string {
  let out = text;
  const values = [...new Set(secrets.filter((s) => s.length >= 3))].sort((a, b) => b.length - a.length);
  for (const v of values) out = out.replace(new RegExp(escapeRe(v), "g"), "***");
  out = out.replace(HEADER_RE, (_m, prefix: string, value: string) => {
    const scheme = /^(bearer|basic|token)\s+/i.exec(value);
    return `${prefix}${scheme ? scheme[0] : ""}***`;
  });
  out = out.replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme}***`);
  return out;
}

/** Conserva la COLA (donde está el resumen y el fallo), acotada a `max` bytes. */
export function boundOutput(text: string, max = MAX_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  const omitted = buf.length - max;
  return `[… ${omitted} bytes omitidos …]\n${buf.subarray(omitted).toString("utf8")}`;
}
