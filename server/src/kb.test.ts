import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KB_CANDIDATES, generateKb, kbSuggestionsBlock, readKbGenerationState, resolveKbDir, scanKb, zipKb } from "./kb.js";
import { createMemoryStore } from "./memory.js";

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

test("generateKb persiste running antes del motor y termina ok con el prompt y cwd correctos", async () => {
  const { root, cleanup } = fixture();
  const stateDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-state-"));
  const states: string[] = [];
  let prompt = "";
  let options: { cwd?: string } | undefined;
  const statePath = (repo: string) => join(stateDirectory, `${repo}.json`);
  try {
    const result = await generateKb("api", {
      resolveCwd: () => ({ cwd: root, real: true }),
      readRepoConfigFull: () => ({ kbPath: "" }),
      readEngine: () => ({ tool: "codex", model: "modelo-prueba" }),
      statePath,
      now: (() => { let now = 100; return () => ++now; })(),
      runClaudeP: async (input, received) => {
        states.push(readKbGenerationState("api", { statePath })!.status);
        prompt = input;
        options = received;
        return "generación terminada";
      },
    });

    assert.deepEqual(states, ["running"]);
    assert.equal(result.status, "ok");
    assert.equal(readKbGenerationState("api", { statePath })?.status, "ok");
    const kbDir = realpathSync(join(root, "knowledge-base"));
    assert.match(prompt, new RegExp(kbDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(options?.cwd, root);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    cleanup();
  }
});

test("generateKb marca failed con la cola de salida y nunca propaga un fallo del motor", async () => {
  const { root, cleanup } = fixture();
  const stateDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-state-"));
  const statePath = (repo: string) => join(stateDirectory, `${repo}.json`);
  try {
    let result: Awaited<ReturnType<typeof generateKb>> | undefined;
    await assert.doesNotReject(async () => {
      result = await generateKb("api", {
        resolveCwd: () => ({ cwd: root, real: true }),
        readRepoConfigFull: () => ({ kbPath: "" }),
        statePath,
        runClaudeP: async () => { throw new Error("falló el motor\ncola de salida relevante"); },
      });
    });
    assert.equal(result?.status, "failed");
    assert.match(result?.output ?? "", /cola de salida relevante/);
    assert.equal(readKbGenerationState("api", { statePath })?.status, "failed");
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    cleanup();
  }
});

const SUGGESTIONS = [{ id: "k_1", text: "El importador CSV vive en src/csv", source: "cowork-csv", createdAt: 1 }];
const SUGGESTIONS_TEXT = "\n\nSugerencias de sesiones recientes: verifícalas contra el código y, si son ciertas, incorpóralas con su cita:\n- El importador CSV vive en src/csv";

function kbDeps(root: string, stateDirectory: string) {
  return {
    resolveCwd: () => ({ cwd: root, real: true }),
    readRepoConfigFull: () => ({ kbPath: "" }),
    statePath: (repo: string) => join(stateDirectory, `${repo}.json`),
  };
}

test("kbSuggestionsBlock arma el texto del spec y queda vacío sin sugerencias", () => {
  assert.equal(kbSuggestionsBlock([]), "");
  assert.equal(kbSuggestionsBlock(SUGGESTIONS), SUGGESTIONS_TEXT);
});

test("generateKb incluye las sugerencias en {kbSuggestions} y las borra sólo si termina ok", async () => {
  const { root, cleanup } = fixture();
  const stateDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-state-"));
  const dropped: Array<[string, string[]]> = [];
  const base = {
    ...kbDeps(root, stateDirectory),
    getPromptTemplate: () => "KB de {repo}.{kbSuggestions}",
    readKbSuggestions: () => SUGGESTIONS,
    dropKbSuggestions: (repo: string, ids: string[]) => { dropped.push([repo, ids]); },
  };
  try {
    let prompt = "";
    const failed = await generateKb("acme-api", { ...base, runClaudeP: async (input) => { prompt = input; throw new Error("falló el motor"); } });
    assert.equal(failed.status, "failed");
    assert.equal(prompt, `KB de acme-api.${SUGGESTIONS_TEXT}`);
    assert.deepEqual(dropped, []);
    const ok = await generateKb("acme-api", { ...base, runClaudeP: async () => "listo" });
    assert.equal(ok.status, "ok");
    assert.deepEqual(dropped, [["acme-api", ["k_1"]]]);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    cleanup();
  }
});

test("generateKb sin sugerencias deja {kbSuggestions} vacío y no borra nada", async () => {
  const { root, cleanup } = fixture();
  const stateDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-state-"));
  let dropCalls = 0;
  let prompt = "";
  try {
    await generateKb("acme-api", {
      ...kbDeps(root, stateDirectory),
      getPromptTemplate: () => "KB de {repo}.{kbSuggestions}",
      readKbSuggestions: () => [],
      dropKbSuggestions: () => { dropCalls++; },
      runClaudeP: async (input) => { prompt = input; return "listo"; },
    });
    assert.equal(prompt, "KB de acme-api.");
    assert.equal(dropCalls, 0);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    cleanup();
  }
});

test("un override de kb sin {kbSuggestions} igual recibe las sugerencias al final", async () => {
  const { root, cleanup } = fixture();
  const stateDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-state-"));
  let prompt = "";
  try {
    await generateKb("acme-api", {
      ...kbDeps(root, stateDirectory),
      getPromptTemplate: () => "KB personalizada de {repo}",
      readKbSuggestions: () => SUGGESTIONS,
      dropKbSuggestions: () => {},
      runClaudeP: async (input) => { prompt = input; return "listo"; },
    });
    assert.equal(prompt, `KB personalizada de acme-api${SUGGESTIONS_TEXT}`);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
    cleanup();
  }
});

test("las sugerencias que llegan durante la generación sobreviven: sólo se borran las usadas", async () => {
  const { root, cleanup } = fixture();
  const stateDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-state-"));
  const memoryDirectory = mkdtempSync(join(tmpdir(), "ronin-kb-memory-"));
  const store = createMemoryStore({ directory: memoryDirectory, listRepos: () => ["acme-api"] });
  try {
    store.add("acme-api", { text: "El importador CSV vive en src/csv", kind: "arquitectura" });
    const result = await generateKb("acme-api", {
      ...kbDeps(root, stateDirectory),
      getPromptTemplate: () => "KB de {repo}.{kbSuggestions}",
      readKbSuggestions: (repo) => store.read(repo).kbSuggestions,
      dropKbSuggestions: (repo, ids) => store.dropKbSuggestions(repo, ids),
      runClaudeP: async () => {
        store.add("acme-api", { text: "La cola de reintentos usa Redis", kind: "arquitectura" });
        return "listo";
      },
    });
    assert.equal(result.status, "ok");
    assert.deepEqual(store.read("acme-api").kbSuggestions.map((s) => s.text), ["La cola de reintentos usa Redis"]);
  } finally {
    rmSync(memoryDirectory, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
    cleanup();
  }
});
