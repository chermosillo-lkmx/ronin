import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeTrustedRoots, isWithinTrustedRoot, trustedRoots } from "./repo-roots.js";

function tempDir(): { dir: string; cleanup: () => void } {
  // realpath de entrada: en macOS $TMPDIR vive bajo un symlink (/var -> /private/var), y sin
  // esto las expectativas de abajo divergerían del resultado de computeTrustedRoots (que SIEMPRE
  // resuelve realpath) por una razón ajena a la lógica que este archivo prueba.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cowork-roots-")));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("computeTrustedRoots: sin COWORK_ALLOWED_ROOTS, cae al fallback (LIEBRE_ROOT)", () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.deepEqual(computeTrustedRoots(undefined, dir), [dir]);
  } finally {
    cleanup();
  }
});

test("computeTrustedRoots: COWORK_ALLOWED_ROOTS separa por ':' y resuelve realpath de cada una", () => {
  const a = tempDir();
  const b = tempDir();
  try {
    assert.deepEqual(computeTrustedRoots(`${a.dir}:${b.dir}`, "/unused"), [a.dir, b.dir]);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("computeTrustedRoots: ignora segmentos vacíos (colon doble, espacios)", () => {
  const { dir, cleanup } = tempDir();
  try {
    assert.deepEqual(computeTrustedRoots(`  ${dir}  ::`, "/unused"), [dir]);
  } finally {
    cleanup();
  }
});

test("trustedRoots: con COWORK_ALLOWED_ROOTS definida ignora las raíces guardadas", () => {
  const envRoot = tempDir();
  const settingsRoot = tempDir();
  const previous = process.env.COWORK_ALLOWED_ROOTS;
  try {
    process.env.COWORK_ALLOWED_ROOTS = envRoot.dir;
    assert.deepEqual(trustedRoots({ allowedRoots: [settingsRoot.dir], defaultRoot: "/unused" }), [envRoot.dir]);
  } finally {
    if (previous === undefined) delete process.env.COWORK_ALLOWED_ROOTS;
    else process.env.COWORK_ALLOWED_ROOTS = previous;
    envRoot.cleanup();
    settingsRoot.cleanup();
  }
});

test("trustedRoots: sin env une settings y la raíz por defecto, omitiendo settings inexistentes", () => {
  const settingsRoot = tempDir();
  const defaultRoot = tempDir();
  const previous = process.env.COWORK_ALLOWED_ROOTS;
  try {
    delete process.env.COWORK_ALLOWED_ROOTS;
    assert.deepEqual(
      trustedRoots({ allowedRoots: [settingsRoot.dir, "/no/existe/cowork-root"], defaultRoot: defaultRoot.dir }),
      [settingsRoot.dir, defaultRoot.dir],
    );
  } finally {
    if (previous === undefined) delete process.env.COWORK_ALLOWED_ROOTS;
    else process.env.COWORK_ALLOWED_ROOTS = previous;
    settingsRoot.cleanup();
    defaultRoot.cleanup();
  }
});

test("isWithinTrustedRoot: comprobación por SEGMENTO, no por prefijo de cadena (/a/bc no está dentro de /a/b)", () => {
  assert.equal(isWithinTrustedRoot("/a/bc/file", ["/a/b"]), false);
  assert.equal(isWithinTrustedRoot("/a/b/file", ["/a/b"]), true);
  assert.equal(isWithinTrustedRoot("/a/b", ["/a/b"]), true, "la raíz misma cuenta como dentro");
});

test("isWithinTrustedRoot (M1, con fs real): un symlink que escapa la raíz de confianza NO cuenta como dentro, uno que resuelve adentro sí", () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    mkdirSync(join(root.dir, "ok"), { recursive: true });
    symlinkSync(outside.dir, join(root.dir, "link-outside"));
    symlinkSync(join(root.dir, "ok"), join(root.dir, "link-inside"));

    const realOutsideLink = realpathSync(join(root.dir, "link-outside"));
    const realInsideLink = realpathSync(join(root.dir, "link-inside"));

    assert.equal(isWithinTrustedRoot(realOutsideLink, [root.dir]), false);
    assert.equal(isWithinTrustedRoot(realInsideLink, [root.dir]), true);
  } finally {
    root.cleanup();
    outside.cleanup();
  }
});
