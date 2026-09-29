import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildMemoryBlock,
  createMemoryStore,
  dedupeKey,
  isStorableRepo,
  MEMORY_BLOCK_MAX_BYTES,
  MemoryError,
  memoryView,
  normalizeMemoryText,
  type MemoryEntry,
} from "./memory.js";

function fixture(repos: string[] = ["acme-api", "acme-web"]) {
  const directory = mkdtempSync(join(tmpdir(), "ronin-memory-"));
  let clock = 1_790_000_000_000;
  let seq = 0;
  const store = createMemoryStore({ directory, listRepos: () => repos, now: () => ++clock, newId: (prefix) => `${prefix}_${++seq}` });
  return { directory, store, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function isMemoryError(code: string, status: number) {
  return (error: unknown) => error instanceof MemoryError && error.code === code && error.status === status;
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: "m_1", text: "Tests: usar `make test-unit`", kind: "comando", source: "cowork-csv-retry", createdAt: 1, updatedAt: 1, status: "active", uses: 0, ...overrides };
}

const HEADER = "Memoria del repo acme-api (aprendizajes aprobados por el usuario; verifícalos si algo no cuadra):";

test("normalizeMemoryText quita caracteres de control y colapsa espacios; dedupeKey ignora mayúsculas y espacios", () => {
  assert.equal(normalizeMemoryText("  Tests:\tusar\u0007 make\n\n test-unit  "), "Tests: usar make test-unit");
  assert.equal(dedupeKey("TESTS: usar  make test-unit"), dedupeKey("tests:usar make test-unit"));
  assert.notEqual(dedupeKey("usar make"), dedupeKey("usar pnpm"));
});

test("un repo sin archivo arranca habilitado y vacío, sin escribir nada", () => {
  const { directory, store, cleanup } = fixture();
  try {
    assert.deepEqual(store.read("acme-api"), { repo: "acme-api", enabled: true, entries: [], kbSuggestions: [] });
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    cleanup();
  }
});

test("add escribe atómicamente un archivo por repo, sin temporales, y normaliza el texto", () => {
  const { directory, store, cleanup } = fixture();
  try {
    store.add("acme-api", { text: "  Tests:\tusar `make test-unit`\u0007 ", kind: "comando" });
    assert.deepEqual(readdirSync(directory), ["acme-api.json"]);
    const saved = JSON.parse(readFileSync(join(directory, "acme-api.json"), "utf8"));
    assert.equal(saved.repo, "acme-api");
    assert.equal(saved.enabled, true);
    assert.deepEqual(
      saved.entries.map((e: MemoryEntry) => [e.id, e.text, e.kind, e.status, e.uses, e.source]),
      [["m_1", "Tests: usar `make test-unit`", "comando", "active", 0, "manual"]],
    );
  } finally {
    cleanup();
  }
});

test("add de arquitectura nunca queda activa: va directo a kbSuggestions", () => {
  const { store, cleanup } = fixture();
  try {
    const memory = store.add("acme-api", { text: "El importador CSV vive en src/csv", kind: "arquitectura" });
    assert.deepEqual(memory.entries, []);
    assert.deepEqual(memory.kbSuggestions.map((s) => [s.id, s.text, s.source]), [["k_1", "El importador CSV vive en src/csv", "manual"]]);
  } finally {
    cleanup();
  }
});

test("add valida texto (1..200 tras normalizar) y kind del enum con MEMORY_INVALID 400", () => {
  const { store, cleanup } = fixture();
  try {
    for (const input of [{ text: "", kind: "comando" }, { text: " \u0007 ", kind: "comando" }, { text: "x".repeat(201), kind: "comando" }, { text: "ok", kind: "chisme" }, null]) {
      assert.throws(() => store.add("acme-api", input), isMemoryError("MEMORY_INVALID", 400), JSON.stringify(input));
    }
    assert.doesNotThrow(() => store.add("acme-api", { text: "x".repeat(200), kind: "preferencia" }));
  } finally {
    cleanup();
  }
});

test("repo desconocido, inseguro o reservado → REPO_UNKNOWN 404, sin tocar disco", () => {
  const { directory, store, cleanup } = fixture(["acme-api", "state", "../fuera", "a/b"]);
  try {
    for (const repo of ["acme-otro", "state", "../fuera", "a/b"]) {
      assert.equal(store.knows(repo), false, repo);
      assert.throws(() => store.read(repo), isMemoryError("REPO_UNKNOWN", 404), repo);
      assert.throws(() => store.add(repo, { text: "x", kind: "comando" }), isMemoryError("REPO_UNKNOWN", 404), repo);
    }
    assert.equal(isStorableRepo("acme-api"), true);
    assert.equal(isStorableRepo(".."), false);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    cleanup();
  }
});

test("propose deja todo pending y deduplica contra activas, pendientes, descartadas y sugerencias", () => {
  const { store, cleanup } = fixture();
  try {
    store.add("acme-api", { text: "Tests: usar make test-unit", kind: "comando" });
    const [descartada] = store.propose("acme-api", [{ text: "Usa siempre pnpm", kind: "preferencia" }], "cowork-a");
    store.resolve("acme-api", descartada.id, "discard");
    store.add("acme-api", { text: "El importador vive en src/csv", kind: "arquitectura" });
    const added = store.propose("acme-api", [
      { text: "TESTS:  usar make   test-unit", kind: "comando" },
      { text: "usa siempre PNPM", kind: "preferencia" },
      { text: "el importador vive en src/csv", kind: "arquitectura" },
      { text: "Ojo:\u0007 el puerto 5432 lo usa docker", kind: "trampa" },
      { text: "OJO: el puerto 5432 lo usa docker", kind: "trampa" },
      { text: "\u0001\u0002", kind: "trampa" },
    ], "cowork-b");
    assert.deepEqual(added.map((e) => [e.text, e.status, e.source, e.uses]), [["Ojo: el puerto 5432 lo usa docker", "pending", "cowork-b", 0]]);
    assert.equal(store.propose("acme-api", [{ text: "ojo: el puerto 5432 lo usa docker", kind: "trampa" }], "cowork-c").length, 0);
  } finally {
    cleanup();
  }
});

test("transiciones válidas: aprobar, editar pendiente (la aprueba), editar activa y descartar", () => {
  const { store, cleanup } = fixture();
  try {
    const [a, b, c] = store.propose("acme-api", [
      { text: "Tests: usar make test-unit", kind: "comando" },
      { text: "Pytest suelto rompe fixtures", kind: "trampa" },
      { text: "Prefiere commits pequeños", kind: "preferencia" },
    ], "cowork-a");
    store.resolve("acme-api", a.id, "approve");
    store.resolve("acme-api", b.id, "edit", "  Pytest suelto rompe\tlos fixtures ");
    store.resolve("acme-api", c.id, "discard");
    store.resolve("acme-api", a.id, "edit", "Tests: `make test-unit`");
    assert.deepEqual(store.read("acme-api").entries.map((e) => [e.id, e.status, e.text]), [
      [a.id, "active", "Tests: `make test-unit`"],
      [b.id, "active", "Pytest suelto rompe los fixtures"],
      [c.id, "discarded", "Prefiere commits pequeños"],
    ]);
    store.resolve("acme-api", a.id, "discard");
    assert.equal(store.read("acme-api").entries.find((e) => e.id === a.id)?.status, "discarded");
  } finally {
    cleanup();
  }
});

test("transiciones inválidas → MEMORY_INVALID 409; id desconocido → 404; acción o texto inválidos → 400", () => {
  const { store, cleanup } = fixture();
  try {
    const [p] = store.propose("acme-api", [{ text: "Algo pendiente", kind: "trampa" }], "cowork-a");
    store.resolve("acme-api", p.id, "approve");
    assert.throws(() => store.resolve("acme-api", p.id, "approve"), isMemoryError("MEMORY_INVALID", 409));
    store.resolve("acme-api", p.id, "discard");
    assert.throws(() => store.resolve("acme-api", p.id, "discard"), isMemoryError("MEMORY_INVALID", 409));
    assert.throws(() => store.resolve("acme-api", p.id, "edit", "otro"), isMemoryError("MEMORY_INVALID", 409));
    assert.throws(() => store.resolve("acme-api", "m_nope", "approve"), isMemoryError("MEMORY_NOT_FOUND", 404));
    assert.throws(() => store.resolve("acme-api", p.id, "borrar"), isMemoryError("MEMORY_INVALID", 400));
    const [q] = store.propose("acme-api", [{ text: "Otra pendiente", kind: "trampa" }], "cowork-a");
    assert.throws(() => store.resolve("acme-api", q.id, "edit", ""), isMemoryError("MEMORY_INVALID", 400));
    assert.equal(store.read("acme-api").entries.find((e) => e.id === q.id)?.status, "pending");
  } finally {
    cleanup();
  }
});

test("aprobar o editar una pendiente de arquitectura la mueve a kbSuggestions", () => {
  const { store, cleanup } = fixture();
  try {
    const [a, b] = store.propose("acme-api", [
      { text: "El importador vive en src/csv", kind: "arquitectura" },
      { text: "La cola usa Redis", kind: "arquitectura" },
    ], "cowork-a");
    store.resolve("acme-api", a.id, "approve");
    store.resolve("acme-api", b.id, "edit", "La cola de reintentos usa Redis");
    const memory = store.read("acme-api");
    assert.deepEqual(memory.entries, []);
    assert.deepEqual(memory.kbSuggestions.map((s) => [s.text, s.source]), [
      ["El importador vive en src/csv", "cowork-a"],
      ["La cola de reintentos usa Redis", "cowork-a"],
    ]);
  } finally {
    cleanup();
  }
});

test("remove borra entradas y sugerencias; un id desconocido es MEMORY_NOT_FOUND 404", () => {
  const { store, cleanup } = fixture();
  try {
    store.add("acme-api", { text: "Activa", kind: "comando" });
    store.add("acme-api", { text: "Para la KB", kind: "arquitectura" });
    store.remove("acme-api", "m_1");
    store.remove("acme-api", "k_2");
    const memory = store.read("acme-api");
    assert.deepEqual([memory.entries, memory.kbSuggestions], [[], []]);
    assert.throws(() => store.remove("acme-api", "m_1"), isMemoryError("MEMORY_NOT_FOUND", 404));
  } finally {
    cleanup();
  }
});

test("pending lista las pendientes de todos los repos o de uno; locate encuentra el repo de un id", () => {
  const { store, cleanup } = fixture();
  try {
    store.propose("acme-api", [{ text: "Pendiente api", kind: "trampa" }], "cowork-a");
    store.propose("acme-web", [{ text: "Pendiente web", kind: "comando" }], "cowork-b");
    store.add("acme-web", { text: "Activa web", kind: "comando" });
    assert.deepEqual(store.pending(), [
      { id: "m_1", repo: "acme-api", text: "Pendiente api", kind: "trampa", source: "cowork-a" },
      { id: "m_2", repo: "acme-web", text: "Pendiente web", kind: "comando", source: "cowork-b" },
    ]);
    assert.deepEqual(store.pending("acme-web").map((e) => e.id), ["m_2"]);
    assert.throws(() => store.pending("acme-otro"), isMemoryError("REPO_UNKNOWN", 404));
    assert.equal(store.locate("m_3"), "acme-web");
    assert.equal(store.locate("m_nope"), null);
  } finally {
    cleanup();
  }
});

test("setEnabled exige un boolean; markUsed suma uses y dropKbSuggestions borra sólo esos ids", () => {
  const { store, cleanup } = fixture();
  try {
    assert.equal(store.setEnabled("acme-api", false).enabled, false);
    assert.equal(store.read("acme-api").enabled, false);
    assert.throws(() => store.setEnabled("acme-api", "no"), isMemoryError("MEMORY_INVALID", 400));
    store.add("acme-api", { text: "Uno", kind: "comando" });
    store.add("acme-api", { text: "Para la KB", kind: "arquitectura" });
    store.add("acme-api", { text: "Dos", kind: "comando" });
    store.markUsed("acme-api", ["m_1", "m_1", "m_nope"]);
    assert.deepEqual(store.read("acme-api").entries.map((e) => [e.id, e.uses]), [["m_1", 2], ["m_3", 0]]);
    store.dropKbSuggestions("acme-api", ["k_2"]);
    assert.deepEqual(store.read("acme-api").kbSuggestions, []);
  } finally {
    cleanup();
  }
});

test("un archivo corrupto o con entradas inválidas se lee con tolerancia", () => {
  const { directory, store, cleanup } = fixture();
  try {
    writeFileSync(join(directory, "acme-api.json"), JSON.stringify({
      enabled: false,
      entries: [entry(), { id: 3 }, { ...entry({ id: "m_x" }), kind: "otro" }],
      kbSuggestions: [{ id: "k_1", text: "ok", source: "s", createdAt: 1 }, { nada: true }],
    }));
    const memory = store.read("acme-api");
    assert.equal(memory.enabled, false);
    assert.deepEqual(memory.entries.map((e) => e.id), ["m_1"]);
    assert.deepEqual(memory.kbSuggestions.map((s) => s.id), ["k_1"]);
    writeFileSync(join(directory, "acme-api.json"), "{roto");
    assert.deepEqual(store.read("acme-api").entries, []);
  } finally {
    cleanup();
  }
});

test("buildMemoryBlock prioriza uses y luego lo más reciente, e ignora lo que no está activo", () => {
  const block = buildMemoryBlock("acme-api", [
    entry({ id: "m_a", text: "a", uses: 1, updatedAt: 50 }),
    entry({ id: "m_b", text: "b", uses: 3, updatedAt: 10 }),
    entry({ id: "m_c", text: "c", uses: 1, updatedAt: 90 }),
    entry({ id: "m_p", text: "p", status: "pending", uses: 9 }),
    entry({ id: "m_d", text: "d", status: "discarded", uses: 9 }),
  ]);
  assert.equal(block.text, [HEADER, "- [comando] b", "- [comando] c", "- [comando] a"].join("\n"));
  assert.deepEqual(block.included, ["m_b", "m_c", "m_a"]);
  assert.equal(block.omitted, 0);
  assert.equal(block.bytes, Buffer.byteLength(block.text, "utf8"));
});

test("buildMemoryBlock respeta 2 KB en bytes UTF-8 y anota las omitidas", () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry({ id: `m_${i}`, text: `${"ñ".repeat(150)}🧠${i}`, uses: 12 - i }));
  const block = buildMemoryBlock("acme-api", entries);
  assert.ok(block.bytes <= MEMORY_BLOCK_MAX_BYTES, String(block.bytes));
  assert.equal(Buffer.byteLength(block.text, "utf8"), block.bytes);
  assert.ok(block.included.length >= 1 && block.included.length < 12);
  assert.equal(block.omitted, 12 - block.included.length);
  assert.match(block.text, new RegExp(`\\n\\(\\+${block.omitted} entradas omitidas\\)$`));
  assert.deepEqual(block.included, entries.slice(0, block.included.length).map((e) => e.id));
});

test("buildMemoryBlock deja literal un {repo} dentro de una entrada y devuelve vacío sin activas", () => {
  const block = buildMemoryBlock("acme-api", [entry({ text: "No expandas {repo} en los scripts", kind: "trampa" })]);
  assert.equal(block.text, `${HEADER}\n- [trampa] No expandas {repo} en los scripts`);
  assert.deepEqual(buildMemoryBlock("acme-api", [entry({ status: "pending" })]), { text: "", bytes: 0, included: [], omitted: 0 });
});

test("memoryView expone activas y pendientes (no descartadas), sugerencias y la vista previa", () => {
  const view = memoryView({
    repo: "acme-api",
    enabled: true,
    entries: [entry({ id: "m_a" }), entry({ id: "m_p", text: "p", status: "pending" }), entry({ id: "m_d", text: "d", status: "discarded" })],
    kbSuggestions: [],
  }, false);
  assert.deepEqual(view.entries.map((e) => e.id), ["m_a", "m_p"]);
  assert.equal(view.globalEnabled, false);
  assert.equal(view.preview.maxBytes, 2048);
  assert.equal(view.preview.text, `${HEADER}\n- [comando] Tests: usar \`make test-unit\``);
  assert.equal(view.preview.bytes, Buffer.byteLength(view.preview.text, "utf8"));
});
