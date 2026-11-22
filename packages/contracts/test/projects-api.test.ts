import { describe, expect, it } from "vitest";
import {
  DisconnectGithubResponse,
  EventEnvelope,
  forgeOf,
  isForgeProject,
  Project,
  ProjectRefreshOutcome,
  RefreshProjectResponse,
} from "../src";
import { sampleProject, ts } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const local = { ...sampleProject, kind: "local" as const, github: undefined };
const forgeRepo = {
  provider: "forgejo" as const,
  baseUrl: "http://localhost:3000",
  host: "localhost:3000",
  owner: "acme",
  repo: "widgets",
  remoteUrl: "http://localhost:3000/acme/widgets.git",
  defaultBranch: "main",
};
const { github: _github, ...forgeBase } = sampleProject as Extract<Project, { kind: "github" }>;
const forgeProject = { ...forgeBase, kind: "forge" as const, forge: forgeRepo };
const detected = {
  isGitRepo: true,
  gitRoot: "C:/Projects/codeden",
  remoteUrl: "https://github.com/acme/codeden.git",
  github: {
    owner: "acme",
    repo: "codeden",
    remoteUrl: "https://github.com/acme/codeden.git",
    defaultBranch: "main",
  },
  forge: null,
  defaultBranch: "main",
  currentBranch: "main",
  packageManager: "pnpm",
  suggestedSetupCommands: ["pnpm install"],
};

describe("project re-detection", () => {
  it("round-trips a project with a remote warning, and one without", () => {
    const warned = roundTrip(Project, {
      ...sampleProject,
      remoteWarning: { code: "github_remote_missing", remoteUrl: null, detectedAt: ts },
    });
    expect(warned.remoteWarning).toEqual({
      code: "github_remote_missing",
      remoteUrl: null,
      detectedAt: ts,
    });
    expect(roundTrip(Project, sampleProject).remoteWarning).toBeUndefined();
    expect(
      Project.safeParse({ ...sampleProject, remoteWarning: { code: "other", detectedAt: ts } })
        .success,
    ).toBe(false);
  });

  it("round-trips a forge project and maps both forge kinds through forgeOf", () => {
    const parsed = roundTrip(Project, forgeProject);
    expect(parsed).toMatchObject({ kind: "forge", forge: forgeRepo });
    expect(isForgeProject(parsed)).toBe(true);
    expect(forgeOf(parsed)).toEqual(forgeRepo);
    expect(isForgeProject(local)).toBe(false);
    expect(forgeOf(local)).toBeNull();
    expect(forgeOf(sampleProject)).toMatchObject({
      provider: "github",
      baseUrl: "https://github.com",
      host: "github.com",
      owner: "acme",
      repo: "codeden",
    });
    expect(
      roundTrip(Project, {
        ...forgeProject,
        remoteWarning: { code: "forge_remote_missing", remoteUrl: null, detectedAt: ts },
      }).remoteWarning?.code,
    ).toBe("forge_remote_missing");
    // A forge project without its coordinates does not parse.
    const { forge: _forge, ...withoutForge } = forgeProject;
    expect(Project.safeParse(withoutForge).success).toBe(false);
  });

  it("parses project events written before remote warnings existed", () => {
    const envelope = roundTrip(EventEnvelope, {
      type: "project.updated",
      sessionId: null,
      payload: { project: sampleProject },
      seq: 1,
      ts,
    });
    expect(envelope.type === "project.updated" && envelope.payload.project.remoteWarning).toBe(
      undefined,
    );
  });

  it("round-trips every refresh outcome", () => {
    for (const outcome of ProjectRefreshOutcome.options) {
      roundTrip(RefreshProjectResponse, {
        project: outcome === "github_connected" ? sampleProject : local,
        outcome,
        changed: outcome !== "unchanged" && outcome !== "folder_missing",
        message: "Connected to acme/codeden",
        detected: outcome === "folder_missing" ? null : detected,
      });
    }
    expect(
      RefreshProjectResponse.safeParse({
        project: local,
        outcome: "upgraded",
        changed: true,
        message: "",
        detected: null,
      }).success,
    ).toBe(false);
    expect(ProjectRefreshOutcome.options).toEqual(
      expect.arrayContaining(["forge_connected", "forge_changed", "forge_remote_missing"]),
    );
  });

  it("round-trips the disconnect response", () => {
    expect(roundTrip(DisconnectGithubResponse, { project: local }).project.kind).toBe("local");
  });
});
