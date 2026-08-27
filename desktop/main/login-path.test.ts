import assert from "node:assert/strict";
import test from "node:test";
import { mergeLoginPath, resolveLoginPath } from "./login-path.js";

test("mergeLoginPath conserva el PATH original, añade fallback y no duplica en orden", () => {
  const path = mergeLoginPath({
    discoveredPath: "/discovered/bin:/usr/bin",
    currentPath: "/usr/bin:/bin:/usr/sbin:/sbin",
    home: "/Users/ronin",
  });

  assert.equal(path, "/discovered/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/ronin/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin");
});

test("mergeLoginPath con PATH de Finder incluye ~/.local/bin y Homebrew", () => {
  const path = mergeLoginPath({
    currentPath: "/usr/bin:/bin:/usr/sbin:/sbin",
    home: "/Users/ronin",
  });

  assert.equal(path, "/usr/bin:/bin:/usr/sbin:/sbin:/Users/ronin/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin");
});

test("resolveLoginPath usa el fallback y no lanza si el shell falla", async () => {
  const path = await resolveLoginPath({
    env: { PATH: "/usr/bin:/bin" },
    home: "/Users/ronin",
    run: async () => { throw new Error("perfil roto"); },
  });

  assert.equal(path, "/usr/bin:/bin:/Users/ronin/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin");
});

test("resolveLoginPath usa el fallback y no lanza si expira el timeout", async () => {
  const path = await resolveLoginPath({
    env: { PATH: "/usr/bin:/bin" },
    home: "/Users/ronin",
    run: async () => new Promise(() => {}),
    timeoutMs: 5,
  });

  assert.equal(path, "/usr/bin:/bin:/Users/ronin/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin");
});
