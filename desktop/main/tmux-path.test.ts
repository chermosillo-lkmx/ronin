import assert from "node:assert/strict";
import test from "node:test";
import { resolveTmuxBinary } from "./tmux-path.js";

test("prefiere COWORK_TMUX_BIN sobre candidatos y PATH", () => {
  const binary = resolveTmuxBinary({
    env: { COWORK_TMUX_BIN: "/custom/tmux", PATH: "/opt/homebrew/bin" },
    exists: () => true,
  });

  assert.equal(binary, "/custom/tmux");
});

test("encuentra Homebrew ARM con PATH tipo Finder", () => {
  const binary = resolveTmuxBinary({
    env: { PATH: "/usr/bin:/bin" },
    exists: (path) => path === "/opt/homebrew/bin/tmux",
  });

  assert.equal(binary, "/opt/homebrew/bin/tmux");
});

test("usa el tmux que existe dentro de PATH después de los candidatos de macOS", () => {
  const binary = resolveTmuxBinary({
    env: { PATH: "/usr/bin:/custom/bin" },
    exists: (path) => path === "/custom/bin/tmux",
  });

  assert.equal(binary, "/custom/bin/tmux");
});

test("devuelve undefined cuando no existe ningún binario tmux", () => {
  const binary = resolveTmuxBinary({
    env: { PATH: "/usr/bin:/bin" },
    exists: () => false,
  });

  assert.equal(binary, undefined);
});
