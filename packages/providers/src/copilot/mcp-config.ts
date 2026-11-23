import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@codeden/contracts";

/** A per-session Copilot MCP config file: the argv that names it, and how to remove it. */
export interface CopilotMcpArgs {
  args: string[];
  cleanup: () => Promise<void>;
}

/** The Copilot MCP config file shape for one HTTP server (the fields ACP cannot carry). */
function serverConfig(server: Extract<McpServerConfig, { transport: "http" }>) {
  return {
    type: "http" as const,
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
    // Copilot's defaults: every tool, and always in the model's tool set even when tool search
    // is on. Without `deferTools` a PM's `start_session` can be held behind tool search.
    tools: ["*"],
    deferTools: "never" as const,
    // The bearer token is per session, so a snapshot from another process is never useful.
    disableToolCache: true,
    ...(server.toolTimeoutSec ? { timeout: server.toolTimeoutSec * 1000 } : {}),
  };
}

/**
 * CodeDen's MCP servers for `copilot --acp` through `--additional-mcp-config`, rather than
 * ACP's `session/new` list. Copilot's ACP session only carries the standard MCP fields, so it
 * cannot be told `deferTools: "never"`: on a model with tool search, CodeDen's tools (and a
 * PM's `start_session`) would be deferred. One Copilot process serves one CodeDen session, so
 * this config file is session-scoped. Undefined when there is no HTTP server to hand over.
 */
export async function copilotMcpArgs(
  servers: readonly McpServerConfig[],
): Promise<CopilotMcpArgs | undefined> {
  const http = servers.filter(
    (server): server is Extract<McpServerConfig, { transport: "http" }> =>
      server.transport === "http",
  );
  if (http.length === 0) return undefined;
  const dir = await mkdtemp(join(tmpdir(), "coden-copilot-mcp-"));
  try {
    const file = join(dir, "mcp.json");
    const mcpServers = Object.fromEntries(
      http.map((server) => [server.name, serverConfig(server)]),
    );
    // 0600 inside the 0700 directory: the headers carry the session's bearer token.
    await writeFile(file, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
    return {
      args: [`--additional-mcp-config=@${file}`],
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
