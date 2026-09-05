import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentMcpConfig, withMcpConfig, writeAgentMcpConfig } from "./agent-mcp.js";

test("agentMcpConfig configura el servidor local con capability", () => {
  assert.deepEqual(agentMcpConfig(4312, "capability-secret"), {
    mcpServers: {
      ronin: {
        type: "http",
        url: "http://127.0.0.1:4312/mcp",
        headers: { "x-ronin-capability": "capability-secret" },
      },
    },
  });
});

test("withMcpConfig añade una ruta entrecomillada", () => {
  assert.equal(
    withMcpConfig("claude --permission-mode bypassPermissions", "/tmp/Application Support/agent-mcp.json"),
    "claude --permission-mode bypassPermissions --mcp-config \"/tmp/Application Support/agent-mcp.json\"",
  );
});

test("withMcpConfig conserva el comando cuando no hay configuración", () => {
  assert.equal(withMcpConfig("claude --permission-mode bypassPermissions", ""), "claude --permission-mode bypassPermissions");
});

test("writeAgentMcpConfig escribe JSON privado y devuelve su ruta", () => {
  const dir = mkdtempSync(join(tmpdir(), "ronin-agent-mcp-"));
  try {
    const path = writeAgentMcpConfig(dir, 4312, "capability-secret");
    assert.equal(path, join(dir, "agent-mcp.json"));
    assert.deepEqual(JSON.parse(readFileSync(path!, "utf8")), agentMcpConfig(4312, "capability-secret"));
    assert.equal(statSync(path!).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeAgentMcpConfig devuelve null si no puede escribir", () => {
  const missing = join(tmpdir(), `ronin-agent-mcp-missing-${process.pid}`, "nested");
  assert.doesNotThrow(() => assert.equal(writeAgentMcpConfig(missing, 4312, "capability-secret"), null));
});
