import type { ProviderInfo } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { type LauncherDeps, SessionLauncher } from "../src/services/sessions/launcher";
import { sampleSession } from "./helpers";

const PROXY = "http://127.0.0.1:4100/mcp";
const TOKEN = "cdm_session-token";

const capabilities = (toolSkills: boolean): ProviderInfo["capabilities"] => ({
  resume: true,
  steer: false,
  interrupt: true,
  approvals: true,
  userQuestions: false,
  subagents: false,
  rollback: false,
  fork: false,
  images: false,
  planMode: false,
  reasoningEffort: false,
  mcp: true,
  skills: false,
  ...(toolSkills ? { toolSkills: true } : {}),
});

function launcher(opts: { toolSkills: boolean; withoutMcp: readonly string[] }) {
  const provider: ProviderInfo = {
    id: "copilot",
    displayName: "Copilot CLI",
    models: [],
    capabilities: capabilities(opts.toolSkills),
  };
  return new SessionLauncher({
    runner: {
      mcpProxyUrl: () => PROXY,
      providers: () => [provider],
    },
    projects: {
      get: () => {
        throw new Error("gone");
      },
    },
    agentTools: () => ({ withoutMcp: opts.withoutMcp }),
  } as unknown as LauncherDeps);
}

const session = { ...sampleSession, provider: "copilot" };

describe("the skill channel for CodeDen's tools", () => {
  it("drops CodeDen's MCP server and passes the tool endpoint when the provider is chosen", () => {
    const opts = launcher({ toolSkills: true, withoutMcp: ["copilot"] }).sessionOptions(
      session,
      TOKEN,
    );
    expect(opts.mcpServers).toEqual([]);
    expect(opts.codeDenTools).toEqual({ url: PROXY, token: TOKEN });
    expect(opts.systemPrompt).toContain("`codeden-tools` skill");
    expect(opts.systemPrompt).toContain("MCP is off for this provider");
    expect(opts.systemPrompt).not.toContain("CodeDen tools are on the `codeden` MCP server");
  });

  it("keeps the MCP server when the provider is not chosen", () => {
    const opts = launcher({ toolSkills: true, withoutMcp: [] }).sessionOptions(session, TOKEN);
    expect(opts.mcpServers.map((s) => ("name" in s ? s.name : ""))).toEqual(["codeden"]);
    expect(opts.codeDenTools).toBeUndefined();
    expect(opts.systemPrompt).toContain("CodeDen tools are on the `codeden` MCP server");
  });

  it("keeps the MCP server for a provider that cannot load a skill plugin", () => {
    const opts = launcher({ toolSkills: false, withoutMcp: ["copilot"] }).sessionOptions(
      session,
      TOKEN,
    );
    expect(opts.mcpServers.map((s) => ("name" in s ? s.name : ""))).toEqual(["codeden"]);
    expect(opts.codeDenTools).toBeUndefined();
  });

  it("stays on MCP without a token, since there is nothing to hand over", () => {
    const opts = launcher({ toolSkills: true, withoutMcp: ["copilot"] }).sessionOptions(session);
    expect(opts.mcpServers).toEqual([]);
    expect(opts.codeDenTools).toBeUndefined();
  });
});
