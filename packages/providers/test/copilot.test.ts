import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copilotModelLabel,
  copilotModelsFromIds,
  copilotTooOldMessage,
  detectCopilot,
  fallbackCopilotModels,
  isCopilotSignInError,
  isSupportedCopilotVersion,
  parseCopilotModelChoices,
} from "../src";
import { acpMcpServers, skippedNotice } from "../src/acp/config";
import { COPILOT_AGENT } from "../src/copilot/adapter";
import { copilotFacts } from "../src/copilot/extensions";
import { copilotMcpArgs } from "../src/copilot/mcp-config";

const HELP = `  \`model\`: AI model to use for Copilot CLI, including custom and local models.
    - "claude-sonnet-5.5"
    - "gpt-6.2-sol"
    - "mai-code-1.1-flash"
    - "claude-sonnet-5.5"

  \`contextTier\`: context window tier for tiered-pricing models.`;

describe("Copilot CLI models", () => {
  it("reads the model ids its own help documents", () => {
    expect(parseCopilotModelChoices(HELP)).toEqual([
      "claude-sonnet-5.5",
      "gpt-6.2-sol",
      "mai-code-1.1-flash",
    ]);
    expect(parseCopilotModelChoices("no settings here")).toEqual([]);
    expect(parseCopilotModelChoices("  `model`: nothing listed\n\n  `other`: x")).toEqual([]);
  });

  it("lists Default, Auto, then the documented models", () => {
    const fallback = fallbackCopilotModels();
    expect(fallback[0]).toMatchObject({ id: "default", isDefault: true });
    expect(fallback[1]).toMatchObject({ id: "auto" });
    expect(fallback.map((m) => m.id)).toContain("claude-sonnet-5.5");
    // No model offers efforts: Copilot takes one at launch only.
    expect(fallback.every((m) => m.efforts.length === 0)).toBe(true);

    const listed = copilotModelsFromIds(["claude-sonnet-5.5", "auto", "default"]);
    expect(listed.map((m) => m.id)).toEqual(["default", "auto", "claude-sonnet-5.5"]);
    expect(listed[2]?.label).toBe("Claude Sonnet 5.5");
  });

  it("labels model ids readably", () => {
    expect(copilotModelLabel("gpt-6.2-sol")).toBe("GPT 6.2 Sol");
    expect(copilotModelLabel("mai-code-1.1-flash")).toBe("MAI Code 1.1 Flash");
    expect(copilotModelLabel("grok-4.7")).toBe("Grok 4.7");
  });

  it("leaves stdio MCP servers out for an agent that starts HTTP ones only", () => {
    const { servers, skipped } = acpMcpServers(
      [
        { transport: "http", name: "codeden", url: "http://127.0.0.1:4318/mcp" },
        { transport: "stdio", name: "local", command: "node", args: ["server.js"] },
      ],
      true,
      { stdio: false },
    );
    expect(servers.map((s) => ("type" in s ? s.type : "stdio"))).toEqual(["http"]);
    expect(skipped).toEqual(["local"]);
    expect(skippedNotice("Copilot CLI", skipped, "stdio MCP servers")).toBe(
      "Copilot CLI can't connect to stdio MCP servers, so local is not available in this session.",
    );
  });

  it("hands Copilot an always-loaded MCP config in a private, per-session file", async () => {
    const mcp = await copilotMcpArgs([
      {
        transport: "http",
        name: "coden",
        url: "http://127.0.0.1:5000/mcp",
        headers: { Authorization: "Bearer secret" },
        toolTimeoutSec: 600,
        trusted: true,
      },
    ]);
    expect(mcp).toBeDefined();
    const file = mcp?.args[0]?.replace("--additional-mcp-config=@", "") ?? "";
    expect(file).not.toBe("");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: {
        coden: {
          type: "http",
          url: "http://127.0.0.1:5000/mcp",
          headers: { Authorization: "Bearer secret" },
          tools: ["*"],
          deferTools: "never",
          disableToolCache: true,
          timeout: 600_000,
        },
      },
    });
    await mcp?.cleanup();
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("has no config file to hand over when there is no HTTP server", async () => {
    expect(await copilotMcpArgs([])).toBeUndefined();
    expect(
      await copilotMcpArgs([
        { transport: "stdio", name: "local", command: "node", args: ["server.js"] },
      ]),
    ).toBeUndefined();
  });
});

describe("Copilot CLI's vendor fields", () => {
  it("reads a subagent's agent id off its tool call", () => {
    expect(
      copilotFacts({
        toolCallId: "c1",
        _meta: { "github.com/copilot": { agentId: "agent-7" } },
      }),
    ).toEqual({ agent: "agent-7" });
    expect(copilotFacts({ toolCallId: "c2" })).toBeUndefined();
    expect(copilotFacts({ toolCallId: "c3", _meta: { "github.com/copilot": {} } })).toBeUndefined();
    // Copilot has no vendor requests of its own: its extensions only read tool calls.
    expect(COPILOT_AGENT.extensions?.toolCall).toBe(copilotFacts);
    expect(COPILOT_AGENT.extensions?.clientCapabilities).toBeUndefined();
  });
});

describe("Copilot CLI versions and sign-in", () => {
  it("refuses CLIs older than 1.0.105, which ran tools without asking", () => {
    expect(isSupportedCopilotVersion("1.0.104")).toBe(false);
    expect(isSupportedCopilotVersion("1.0.105")).toBe(true);
    expect(isSupportedCopilotVersion("1.1.0")).toBe(true);
    expect(isSupportedCopilotVersion(null)).toBe(false);
    expect(copilotTooOldMessage("1.0.104")).toBe("Copilot CLI 1.0.104 is too old (needs 1.0.105+)");
  });

  it("tells a refused sign-in from a crash", () => {
    expect(isCopilotSignInError("Not authenticated: run copilot login")).toBe(true);
    expect(isCopilotSignInError("Please sign in to continue")).toBe(true);
    expect(isCopilotSignInError("could not start: ENOENT")).toBe(false);
    expect(isCopilotSignInError(undefined)).toBe(false);
  });
});

describe("Copilot CLI detection", () => {
  const lookup = {
    command: { kind: "native" as const, path: "/bin/copilot" },
    version: "1.0.114",
    broken: [],
  };

  it("is signed in when the CLI opens a session", async () => {
    const status = await detectCopilot({
      lookup,
      probe: async () => ({ acp: true, session: true }),
    });
    expect(status).toMatchObject({
      providerId: "copilot",
      installed: true,
      version: "1.0.114",
      executablePath: "/bin/copilot",
      loggedIn: true,
      authMethod: "copilot",
      supported: true,
      issues: [],
    });
  });

  it("reports a refused session as signed out", async () => {
    const status = await detectCopilot({
      lookup,
      probe: async () => ({ acp: true, session: false, error: "Not authenticated" }),
    });
    expect(status.loggedIn).toBe(false);
    expect(status.issues).toEqual([
      expect.objectContaining({
        code: "not_logged_in",
        fix: { kind: "login", command: "copilot login" },
      }),
    ]);
  });

  it("reports a CLI that cannot start its ACP server", async () => {
    const status = await detectCopilot({
      lookup,
      probe: async () => ({ acp: false, session: false, error: "unknown option --acp" }),
    });
    expect(status.supported).toBe(false);
    expect(status.issues[0]).toMatchObject({ code: "version_unsupported" });
  });

  it("does not run an unsupported CLI at all", async () => {
    let probed = false;
    const status = await detectCopilot({
      lookup: { ...lookup, version: "1.0.90" },
      probe: async () => {
        probed = true;
        return { acp: true, session: true };
      },
    });
    expect(probed).toBe(false);
    expect(status.loggedIn).toBeNull();
    expect(status.issues[0]).toMatchObject({
      code: "version_unsupported",
      minVersion: "1.0.105",
    });
  });
});
