import { ProviderInfo } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { getProvider, listProviders, providerInfo } from "../src";

describe("provider registry", () => {
  it("lists the built-in providers with honest capabilities", () => {
    expect(listProviders().map((p) => p.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "cursor",
      "gemini",
      "copilot",
    ]);
    const claude = getProvider("claude");
    const codex = getProvider("codex");
    expect(claude?.capabilities()).toMatchObject({ subagents: true, planMode: true, steer: true });
    expect(codex?.capabilities()).toMatchObject({ subagents: true, planMode: false, steer: true });
    expect(getProvider("opencode")?.capabilities()).toMatchObject({
      subagents: true,
      planMode: false,
      steer: true,
      liveAutonomy: true,
    });
    // Cursor: ACP has no steering, and subagents are not wired up yet.
    expect(getProvider("cursor")?.capabilities()).toMatchObject({
      subagents: false,
      planMode: true,
      steer: false,
      readOnly: true,
      liveAutonomy: true,
    });
    // Gemini CLI: no questions over ACP (it drops its ask_user tool), no steering.
    const gemini = getProvider("gemini");
    expect(gemini?.displayName).toBe("Gemini CLI");
    expect(gemini?.capabilities()).toMatchObject({
      userQuestions: false,
      planMode: true,
      steer: false,
      readOnly: true,
      liveAutonomy: true,
    });
    // Copilot CLI: no questions over ACP either, no steering.
    const copilot = getProvider("copilot");
    expect(copilot?.displayName).toBe("Copilot CLI");
    expect(copilot?.capabilities()).toMatchObject({
      userQuestions: false,
      planMode: true,
      steer: false,
      readOnly: true,
      liveAutonomy: true,
    });
    for (const p of listProviders()) {
      ProviderInfo.parse(providerInfo(p));
      // Cursor, Gemini CLI and Copilot CLI offer no one-shot calls for the utility model.
      if (p.utilityModel) expect(p.utilityModel().providerId).toBe(p.id);
    }
    expect(getProvider("nope")).toBeUndefined();
  });
});
