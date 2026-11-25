import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  defaultMainHealthRepos,
  defaultMainHealthSettings,
  discoverMainHealthRepos,
  readAllowedRoots,
  readEngine,
  readGateSettings,
  readMainHealthSettings,
  saveAllowedRoots,
  saveEngine,
} from "./settings.js";
import { DEFAULT_ENGINE } from "./engine-config.js";

test("saveAllowedRoots valida absolutas/existentes, resuelve symlinks y elimina duplicados", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-settings-")));
  const target = join(base, "target");
  const link = join(base, "link");
  const settingsFile = join(base, "settings.json");
  try {
    mkdirSync(target);
    symlinkSync(target, link);
    const roots = saveAllowedRoots([target, link, target], settingsFile);
    assert.deepEqual(roots, [realpathSync(target)]);
    assert.deepEqual(readAllowedRoots(settingsFile), [realpathSync(target)]);
    assert.throws(() => saveAllowedRoots(["relative"], settingsFile), /raíz inválida: relative \(debe existir y ser absoluta\)/);
    assert.throws(() => saveAllowedRoots([join(base, "missing")], settingsFile), /raíz inválida:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("engine se conserva en settings y su ausencia devuelve el predeterminado", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-settings-engine-")));
  const settingsFile = join(base, "settings.json");
  try {
    writeFileSync(settingsFile, "{}\n");
    assert.deepEqual(readEngine(settingsFile), DEFAULT_ENGINE);
    saveAllowedRoots([base], settingsFile);
    assert.deepEqual(saveEngine({ tool: "codex", model: "gpt-5.3-codex" }, settingsFile), { tool: "codex", model: "gpt-5.3-codex" });
    assert.deepEqual(readEngine(settingsFile), { tool: "codex", model: "gpt-5.3-codex" });
    assert.deepEqual(readAllowedRoots(settingsFile), [base]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function conSettings(contenido: string | null, fn: (file: string) => void): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cowork-settings-gate-")));
  const file = join(base, "settings.json");
  try {
    if (contenido !== null) writeFileSync(file, contenido);
    fn(file);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("readGateSettings sin gate devuelve los cupos pesado y ligero", () => {
  conSettings(null, (file) => assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 }));
  conSettings("{}", (file) => assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 }));
});

test("readGateSettings respeta maxConcurrentLight válido", () => {
  conSettings(JSON.stringify({ gate: { timeoutMin: 90, maxConcurrent: 4, maxConcurrentLight: 6 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 90, maxConcurrent: 4, maxConcurrentLight: 6 }));
});

test("readGateSettings descarta timeoutMin 1 y maxConcurrent \"3\"", () => {
  conSettings(JSON.stringify({ gate: { timeoutMin: 1, maxConcurrent: "3" } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 }));
  conSettings(JSON.stringify({ gate: { timeoutMin: 241, maxConcurrent: 9 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 }));
  conSettings(JSON.stringify({ gate: { timeoutMin: 10.5, maxConcurrent: 1 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 1, maxConcurrentLight: 4 }));
  conSettings(JSON.stringify({ gate: { maxConcurrentLight: 17 } }), (file) =>
    assert.deepEqual(readGateSettings(file), { timeoutMin: 45, maxConcurrent: 2, maxConcurrentLight: 4 }));
});

test("saveEngine conserva el gate escrito a mano", () => {
  conSettings(JSON.stringify({ gate: { timeoutMin: 90, maxConcurrent: 4 } }), (file) => {
    saveEngine(DEFAULT_ENGINE, file);
    assert.deepEqual(readGateSettings(file), { timeoutMin: 90, maxConcurrent: 4, maxConcurrentLight: 4 });
  });
});

test("discoverMainHealthRepos conserva repos git únicos bajo LIEBRE_ROOT", () => {
  const repos = discoverMainHealthRepos(
    ["api", "missing", "api"],
    "/liebre",
    (path: string) => path === "/liebre/api/.git",
    (path: string) => path,
  );
  assert.deepEqual(repos, ["api"]);
});

test("discoverMainHealthRepos excluye symlinks cuya ruta real sale de LIEBRE_ROOT", () => {
  const realPaths: Record<string, string> = {
    "/liebre": "/real/liebre",
    "/liebre/api": "/real/liebre/api",
    "/liebre/enlace": "/fuera/api",
  };
  const repos = discoverMainHealthRepos(
    ["api", "enlace"],
    "/liebre",
    () => true,
    (path: string) => realPaths[path],
  );
  assert.deepEqual(repos, ["api"]);
});

test("defaultMainHealthRepos devuelve el alcance explícito independiente de checkouts", () => {
  assert.deepEqual(defaultMainHealthRepos(), [
    "ant-liebre-api",
    "ant-ms-cfdis",
    "ant-liebre-data-extraction-contpaqi",
    "ant-ms-permissions",
    "ant-ms-i18n",
  ]);
});

test("readMainHealthSettings devuelve defaults completos del alcance explícito", () => {
  conSettings("{}", (file) => {
    assert.deepEqual(readMainHealthSettings(file), {
      enabled: true,
      intervalMin: 60,
      repos: [
        "ant-liebre-api",
        "ant-ms-cfdis",
        "ant-liebre-data-extraction-contpaqi",
        "ant-ms-permissions",
        "ant-ms-i18n",
      ],
      commentOnPr: false,
      remoteClaim: true,
      autoFix: true,
      leaseMin: 30,
      aliases: {
        "ant-liebre-api": "api",
        "ant-ms-cfdis": "cfdis",
        "ant-liebre-data-extraction-contpaqi": "dex",
        "ant-ms-i18n": "i18n",
        "ant-ms-permissions": "perms",
      },
    });
  });
});

test("readMainHealthSettings sanea valores válidos de mainHealth", () => {
  conSettings(JSON.stringify({ mainHealth: {
    enabled: false,
    intervalMin: 60,
    repos: [" api ", "", 3, "api", "cfdis"],
    commentOnPr: true,
    remoteClaim: false,
    autoFix: false,
    leaseMin: 120,
    aliases: { " repo-remoto ": "api-2", peligro: "../api", vacio: "", numero: 4 },
  } }), (file) => {
    assert.deepEqual(readMainHealthSettings(file, () => ["default"]), {
      enabled: false,
      intervalMin: 60,
      repos: ["api", "cfdis"],
      commentOnPr: true,
      remoteClaim: false,
      autoFix: false,
      leaseMin: 120,
      aliases: { "repo-remoto": "api-2" },
    });
  });
});

test("readMainHealthSettings acepta sólo nombres de repo simples seguros y únicos", () => {
  conSettings(JSON.stringify({ mainHealth: {
    repos: ["api", "../api", "a/b", ".", "..", "dex.repo", "i18n_repo", ".oculto", "api"],
  } }), (file) => {
    assert.deepEqual(readMainHealthSettings(file, () => ["default"]).repos, ["api", "dex.repo", "i18n_repo", ".oculto"]);
  });
});

test("readMainHealthSettings hace caer tipos y enteros inválidos a defaults", () => {
  conSettings(JSON.stringify({ mainHealth: {
    enabled: "false",
    intervalMin: 0,
    repos: "api",
    commentOnPr: 1,
    remoteClaim: "true",
    autoFix: null,
    leaseMin: 1441,
    aliases: [],
  } }), (file) => {
    assert.deepEqual(
      readMainHealthSettings(file, () => ["default"]),
      defaultMainHealthSettings(["default"]),
    );
  });
});

test("saveEngine y saveAllowedRoots conservan mainHealth saneado", () => {
  const mainHealth = {
    enabled: false,
    intervalMin: 20,
    repos: ["api"],
    commentOnPr: true,
    remoteClaim: false,
    autoFix: false,
    leaseMin: 45,
    aliases: { remoto: "api" },
  };
  conSettings(JSON.stringify({ mainHealth }), (file) => {
    saveEngine(DEFAULT_ENGINE, file);
    saveAllowedRoots([dirname(file)], file);
    assert.deepEqual(readMainHealthSettings(file, () => ["default"]), mainHealth);
  });
});
