import assert from "node:assert/strict";
import test from "node:test";
import { installWindowSecurity } from "./window-security.js";

test("window security blocks untrusted navigation and denies every popup", async () => {
  let navigate: ((event: { preventDefault(): void }, url: string) => void) | undefined;
  let popup: ((details: { url: string }) => { action: "deny" }) | undefined;
  const opened: string[] = [];
  installWindowSecurity({
    on: (_event, listener) => { navigate = listener; },
    setWindowOpenHandler: (listener) => { popup = listener; },
  }, { openExternal: (url) => { opened.push(url); } }, false);

  for (const url of ["javascript:alert(1)", "file:///tmp/x", "app://evil/", "https://example.com/"]) {
    let blocked = false;
    navigate!({ preventDefault: () => { blocked = true; } }, url);
    assert.equal(blocked, true);
  }
  let allowedBlocked = false;
  navigate!({ preventDefault: () => { allowedBlocked = true; } }, "app://ronin/");
  assert.equal(allowedBlocked, false);
  assert.deepEqual(popup!({ url: "https://example.com/" }), { action: "deny" });
  assert.deepEqual(popup!({ url: "file:///tmp/x" }), { action: "deny" });
  await Promise.resolve();
  assert.deepEqual(opened, ["https://example.com/"]);
});
