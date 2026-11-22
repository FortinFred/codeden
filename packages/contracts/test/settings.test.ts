import { describe, expect, it } from "vitest";
import { CustomModel, defaultSettings, ModelRef, Settings, speechExcerpt } from "../src";

describe("Settings.models", () => {
  it("defaults to no favourites or hidden models, so older settings files still parse", () => {
    expect(defaultSettings().models).toEqual({ favorites: [], hidden: {}, custom: {} });
    const older = { providers: { agent: { provider: "codex", model: "default" } } };
    expect(Settings.parse(older).models).toEqual({ favorites: [], hidden: {}, custom: {} });
    // Saved with favourites only, before hidden models existed.
    const withFavorites = { models: { favorites: [{ provider: "claude", model: "opus" }] } };
    expect(Settings.parse(withFavorites).models.hidden).toEqual({});
    // Saved before custom models existed.
    const withHidden = { models: { favorites: [], hidden: { codex: ["gpt-5.5-terra"] } } };
    expect(Settings.parse(withHidden).models.custom).toEqual({});
  });

  it("round-trips custom model ids by provider, with optional labels", () => {
    const custom = {
      claude: [{ id: "claude-opus-6-preview", label: "Opus 6 preview" }, { id: "my-proxy-model" }],
      codex: [],
    };
    const parsed = Settings.parse({ models: { custom } });
    expect(parsed.models.custom).toEqual(custom);
    expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    // Ids and labels are trimmed.
    expect(CustomModel.parse({ id: "  x-1 ", label: " X " })).toEqual({ id: "x-1", label: "X" });
  });

  it("rejects empty, duplicate and malformed custom models", () => {
    expect(CustomModel.safeParse({ id: "   " }).success).toBe(false);
    expect(CustomModel.safeParse({ id: "x", label: "" }).success).toBe(false);
    expect(() =>
      Settings.parse({ models: { custom: { codex: [{ id: "a" }, { id: "a" }] } } }),
    ).toThrow(/unique/);
    expect(() =>
      Settings.parse({ models: { custom: { "Not A Provider": [{ id: "x" }] } } }),
    ).toThrow();
  });

  it("round-trips favourites as provider and model pairs, in order", () => {
    const favorites = [
      { provider: "codex", model: "gpt-6.1-sol" },
      { provider: "claude", model: "opus" },
    ];
    const parsed = Settings.parse({ models: { favorites } });
    expect(parsed.models.favorites).toEqual(favorites);
    expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("round-trips hidden model ids by provider", () => {
    const hidden = { codex: ["gpt-5.5-terra", "gpt-5.6-luna-mini"], claude: [] };
    const parsed = Settings.parse({ models: { hidden } });
    expect(parsed.models.hidden).toEqual(hidden);
    expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects malformed entries", () => {
    expect(ModelRef.safeParse({ provider: "codex", model: "" }).success).toBe(false);
    expect(ModelRef.safeParse({ provider: "Not A Provider", model: "x" }).success).toBe(false);
    expect(() => Settings.parse({ models: { favorites: [{ model: "opus" }] } })).toThrow();
    expect(() => Settings.parse({ models: { hidden: { codex: [""] } } })).toThrow();
    expect(() => Settings.parse({ models: { hidden: { "Not A Provider": ["x"] } } })).toThrow();
  });
});

describe("Settings.voice.readAloud.content", () => {
  it("defaults to a TL;DR, so settings files from before it existed still load", () => {
    const old = Settings.parse({
      voice: { readAloud: { enabled: true, engine: "elevenlabs" } },
      utilityModel: { jobs: { readAloudSummary: false } },
    });
    expect(old.voice.readAloud.content).toBe("summary");
    expect(old.voice.readAloud.engine).toBe("elevenlabs");
    expect(old.utilityModel.jobs.readAloudSummary).toBe(false);
    expect(defaultSettings().voice.readAloud.content).toBe("summary");
    expect(old.voice.readAloud.announceSpeaker).toBe(true);
  });

  it("round-trips both modes and rejects others", () => {
    for (const content of ["summary", "full"] as const) {
      const parsed = Settings.parse({ voice: { readAloud: { content } } });
      expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
      expect(parsed.voice.readAloud.content).toBe(content);
    }
    expect(() => Settings.parse({ voice: { readAloud: { content: "everything" } } })).toThrow();
    const quiet = Settings.parse({ voice: { readAloud: { announceSpeaker: false } } });
    expect(Settings.parse(JSON.parse(JSON.stringify(quiet))).voice.readAloud.announceSpeaker).toBe(
      false,
    );
  });
});

describe("speechExcerpt", () => {
  it("keeps whole leading sentences that fit", () => {
    expect(speechExcerpt("One. Two is here! Three?", 20)).toBe("One. Two is here!");
    expect(speechExcerpt("One. Two. Three.", 100, 2)).toBe("One. Two.");
  });

  it("cuts a single over-long sentence at a word with an ellipsis", () => {
    const out = speechExcerpt(`${"word ".repeat(100)}end.`, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("word...")).toBe(true);
  });
});

describe("Settings.forges", () => {
  it("defaults to no Forgejo connection, so older settings files still parse", () => {
    expect(defaultSettings().forges).toEqual({ forgejo: null });
    expect(Settings.parse({ voice: { readAloud: { enabled: true } } }).forges.forgejo).toBeNull();
  });

  it("round-trips a Forgejo connection without a token", () => {
    const parsed = Settings.parse({
      forges: {
        forgejo: {
          baseUrl: "http://localhost:3000",
          sshHost: "forge.example.com:2222",
          allowInsecureHttp: true,
        },
      },
    });
    expect(parsed.forges.forgejo).toEqual({
      baseUrl: "http://localhost:3000",
      sshHost: "forge.example.com:2222",
      allowInsecureHttp: true,
    });
    expect(Settings.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed.forges.forgejo).not.toHaveProperty("token");
  });

  it("applies the allowInsecureHttp default and rejects a malformed base URL", () => {
    expect(
      Settings.parse({ forges: { forgejo: { baseUrl: "https://forge.example.com" } } }).forges
        .forgejo,
    ).toEqual({ baseUrl: "https://forge.example.com", allowInsecureHttp: false });
    expect(Settings.safeParse({ forges: { forgejo: { baseUrl: "not a url" } } }).success).toBe(
      false,
    );
  });
});

describe("Settings.sessions", () => {
  it("turns PR feedback on by default, so settings files from before it existed still load", () => {
    expect(defaultSettings().sessions).toEqual({ prFeedback: true, autoRetry: true });
    expect(Settings.parse({ worktrees: { cleanup: false } }).sessions.prFeedback).toBe(true);
    // Saved before automatic retries existed.
    expect(Settings.parse({ sessions: { prFeedback: false } }).sessions.autoRetry).toBe(true);
  });

  it("round-trips the switch", () => {
    const off = Settings.parse({ sessions: { prFeedback: false } });
    expect(Settings.parse(JSON.parse(JSON.stringify(off)))).toEqual(off);
    expect(off.sessions.prFeedback).toBe(false);
    expect(Settings.safeParse({ sessions: { prFeedback: "yes" } }).success).toBe(false);
  });
});
