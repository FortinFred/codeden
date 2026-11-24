import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderInfo, Role } from "@codeden/contracts";
import { writeCopilotToolPlugin } from "@codeden/providers";
import { describe, expect, it } from "vitest";
import { allTools } from "../src/mcp/tools";
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
    tools: () => ({
      list: (role: Role) =>
        allTools
          .filter((tool) => tool.roles.includes(role))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { type: "object" as const },
          })),
    }),
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
    expect(opts.codeDenTools).toMatchObject({ url: PROXY, token: TOKEN });
    expect(opts.codeDenTools?.tools.map((tool) => tool.name)).toContain("finish");
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

describe("the skill's tool list follows the session's role", () => {
  /** The SKILL.md the Copilot adapter writes for a session of `role`. */
  function skillFor(role: Role): string {
    const opts = launcher({ toolSkills: true, withoutMcp: ["copilot"] }).sessionOptions(
      { ...session, role },
      TOKEN,
    );
    const plugin = writeCopilotToolPlugin({
      sessionId: session.id,
      tools: opts.codeDenTools?.tools ?? [],
    });
    try {
      return readFileSync(join(plugin.dir, "skills", "codeden-tools", "SKILL.md"), "utf8");
    } finally {
      plugin.remove();
    }
  }

  it("an agent gets the agent tools", () => {
    const skill = skillFor("agent");
    for (const tool of ["finish", "report_progress", "create_pull_request", "browser_screenshot"]) {
      expect(skill, tool).toContain(`\`${tool}\``);
    }
    for (const tool of ["start_session", "get_overview"]) {
      expect(skill, tool).not.toContain(`\`${tool}\``);
    }
  });

  it("a PM gets its own tools, not the agent's", () => {
    const skill = skillFor("pm");
    for (const tool of [
      "start_session",
      "message_orchestrator",
      "get_project_status",
      "list_automations",
      "create_issue",
      "factory_hold_issue",
    ]) {
      expect(skill, tool).toContain(`\`${tool}\``);
    }
    for (const tool of ["finish", "create_pull_request", "browser_screenshot", "get_overview"]) {
      expect(skill, tool).not.toContain(`\`${tool}\``);
    }
  });

  it("an orchestrator gets the orchestrator tools, not the PM's or the agent's", () => {
    const skill = skillFor("orchestrator");
    for (const tool of ["get_overview", "list_projects", "message_pm", "schedule_wakeup"]) {
      expect(skill, tool).toContain(`\`${tool}\``);
    }
    for (const tool of ["finish", "start_session", "browser_screenshot"]) {
      expect(skill, tool).not.toContain(`\`${tool}\``);
    }
  });
});
