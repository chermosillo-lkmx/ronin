import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function agentMcpConfig(port: number, token: string) {
  return {
    mcpServers: {
      ronin: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { "x-ronin-capability": token },
      },
    },
  };
}

export function withMcpConfig(startCmd: string, configPath: string): string {
  if (!configPath) return startCmd;
  const quotedPath = configPath.replace(/[\\"$`]/g, "\\$&");
  return `${startCmd} --mcp-config "${quotedPath}"`;
}

/** Best-effort: la configuración MCP nunca debe impedir el lanzamiento de una sesión. */
export function writeAgentMcpConfig(dir: string, port: number, token: string): string | null {
  const path = join(dir, "agent-mcp.json");
  try {
    writeFileSync(path, `${JSON.stringify(agentMcpConfig(port, token), null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  } catch {
    return null;
  }
}
