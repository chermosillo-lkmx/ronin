import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { writeJsonAtomic } from "./atomic.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "cowork-atomic-"));
}

test("writeJsonAtomic: sobre un destino no escribible LANZA (no traga)", () => {
  const dir = freshDir();
  try {
    const target = join(dir, "does", "not", "exist", "file.json");
    assert.throws(() => writeJsonAtomic(target, { ok: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic: un fallo antes del rename deja el destino con su contenido anterior íntegro, sin archivo parcial visible", () => {
  const dir = freshDir();
  try {
    const target = join(dir, "adopted.json");
    writeFileSync(target, JSON.stringify({ version: 1, previous: true }));

    // Simula la interrupción: writeJsonAtomic acepta un renamer inyectable que falla ANTES de
    // mover el temporal sobre el destino final.
    assert.throws(() => writeJsonAtomic(target, { version: 1, previous: false }, {
      rename: () => { throw new Error("simulated crash before rename"); },
    }));

    assert.equal(JSON.parse(readFileSync(target, "utf8")).previous, true);
    const leftovers = readdirSync(dir).filter((name) => name !== "adopted.json");
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJsonAtomic: escritura normal deja el destino legible y sin temporal residual", () => {
  const dir = freshDir();
  try {
    const target = join(dir, "flow.json");
    writeJsonAtomic(target, { stages: [], verifyAfter: null });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { stages: [], verifyAfter: null });
    assert.equal(readdirSync(dir).length, 1);
    assert.equal(existsSync(target), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
