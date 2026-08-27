import assert from "node:assert/strict";
import test from "node:test";
import { resolveBinary } from "./tmux-path.js";

test("encuentra ttyd de Homebrew ARM con el PATH real de Finder", () => {
  const binary = resolveBinary({
    binary: "ttyd",
    environmentVariable: "COWORK_TTYD_BIN",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    exists: (path) => path === "/opt/homebrew/bin/ttyd",
  });

  assert.equal(binary, "/opt/homebrew/bin/ttyd");
});

test("prefiere COWORK_TTYD_BIN sobre candidatos y PATH", () => {
  const binary = resolveBinary({
    binary: "ttyd",
    environmentVariable: "COWORK_TTYD_BIN",
    env: { COWORK_TTYD_BIN: "/custom/ttyd", PATH: "/opt/homebrew/bin" },
    exists: () => true,
  });

  assert.equal(binary, "/custom/ttyd");
});
