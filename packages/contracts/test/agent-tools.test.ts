import { describe, expect, it } from "vitest";
import { ProviderCapabilities, SessionOptions, Settings } from "../src";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

// A company policy can disable MCP servers for a provider. The skill channel gives the same
// CodeDen tools to sessions as a local plugin skill and a bridge script instead.
describe("CodeDen's tools as a skill instead of MCP", () => {
  it("lists no provider by default, and keeps the chosen ones across a round-trip", () => {
    expect(Settings.parse({}).agentTools.withoutMcp).toEqual([]);
    const parsed = roundTrip(Settings, { agentTools: { withoutMcp: ["copilot"] } });
    expect(parsed.agentTools.withoutMcp).toEqual(["copilot"]);
    expect(Settings.safeParse({ agentTools: { withoutMcp: [42] } }).success).toBe(false);
  });

  it("marks the capability absent on providers that cannot load a local skill plugin", () => {
    const capabilities = {
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
    };
    expect(ProviderCapabilities.parse(capabilities).toolSkills).toBeUndefined();
    expect(roundTrip(ProviderCapabilities, { ...capabilities, toolSkills: true }).toolSkills).toBe(
      true,
    );
  });

  it("carries the tool endpoint and the session token in the session options", () => {
    const base = { sessionId: "s1", role: "agent", cwd: "/r", autonomy: "auto" };
    expect(SessionOptions.parse(base).codeDenTools).toBeUndefined();
    const tools = { url: "http://127.0.0.1:4100/mcp", token: "cdm_abc" };
    expect(roundTrip(SessionOptions, { ...base, codeDenTools: tools }).codeDenTools).toEqual(tools);
    expect(
      SessionOptions.safeParse({ ...base, codeDenTools: { url: "not a url", token: "t" } }).success,
    ).toBe(false);
  });
});
