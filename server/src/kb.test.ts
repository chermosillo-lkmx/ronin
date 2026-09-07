import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KB_CANDIDATES, resolveKbDir, scanKb, zipKb } from "./kb.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ronin-kb-"));
  const outside = mkdtempSync(join(tmpdir(), "ronin-kb-outside-"));
  const cleanup = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  };
  return { root, outside, cleanup };
}

test("resolveKbDir prefiere la ruta configurada y detecta el primer candidato existente", () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, "kb"));
    mkdirSync(join(root, "manual"));
    assert.equal(resolveKbDir(root, "manual"), realpathSync(join(root, "manual")));
    assert.equal(resolveKbDir(root, null), realpathSync(join(root, "kb")));
  } finally {
    cleanup();
  }
});

test("resolveKbDir devuelve null sin KB y rechaza rutas que escapan o enlaces simbólicos externos", () => {
  const { root, outside, cleanup } = fixture();
  try {
    assert.equal(resolveKbDir(root, null), null);
    assert.equal(resolveKbDir(root, "../fuera"), null);
    symlinkSync(outside, join(root, "enlace-externo"));
    assert.equal(resolveKbDir(root, "enlace-externo"), null);
  } finally {
    cleanup();
  }
});

test("scanKb cuenta archivos y bytes, y expone sólo candidatos existentes", () => {
  const { root, cleanup } = fixture();
  try {
    mkdirSync(join(root, "knowledge-base", "nested"), { recursive: true });
    mkdirSync(join(root, "kb"));
    writeFileSync(join(root, "knowledge-base", "uno.md"), "hola");
    writeFileSync(join(root, "knowledge-base", "nested", "dos.txt"), "mundo!");
    assert.deepEqual(scanKb(root, null), {
      path: realpathSync(join(root, "knowledge-base")),
      relativePath: "knowledge-base",
      exists: true,
      files: 2,
      bytes: 10,
      candidates: ["knowledge-base", "kb"],
    });
  } finally {
    cleanup();
  }
});

test("scanKb reporta que no existe cuando no hay una base de conocimiento", () => {
  const { root, cleanup } = fixture();
  try {
    assert.deepEqual(scanKb(root, null), {
      path: null,
      relativePath: null,
      exists: false,
      files: 0,
      bytes: 0,
      candidates: [],
    });
  } finally {
    cleanup();
  }
});

test("zipKb crea un ZIP no vacío y explica claramente si zip no está instalado", async () => {
  const { root, cleanup } = fixture();
  const out = mkdtempSync(join(tmpdir(), "ronin-kb-output-"));
  try {
    mkdirSync(join(root, "kb"));
    writeFileSync(join(root, "kb", "nota.md"), "contenido");
    const archive = await zipKb(join(root, "kb"), out, "repositorio");
    assert.equal(existsSync(archive), true);
    assert.ok(statSync(archive).size > 0);
    await assert.rejects(
      zipKb(join(root, "kb"), out, "fallo", { binary: "zip-ronin-inexistente" }),
      /binario 'zip'.*instálalo/i,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
    cleanup();
  }
});

test("KB_CANDIDATES conserva el orden de detección público", () => {
  assert.deepEqual(KB_CANDIDATES, ["knowledge-base", "kb", "docs/kb"]);
});
