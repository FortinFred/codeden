import { FactoryLimits, type Project } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { projectToRow, rowToProject } from "../src/db/rows";

const ts = "2026-11-22T10:00:00.000Z";

const base = {
  id: "p1",
  name: "Widgets",
  slug: "widgets",
  path: "/work/widgets",
  isGitRepo: true,
  defaultBranch: "main",
  defaultProvider: null,
  defaultModel: null,
  defaultEffort: null,
  autonomy: null,
  autonomyMode: "assisted" as const,
  visionPath: ".codeden/VISION.md",
  issues: { source: "forge" as const, folder: ".codeden/issues" },
  factoryLimits: FactoryLimits.parse({}),
  killSwitch: false,
  timezone: null,
  agentCiEnv: true,
  execution: { backend: "local" as const },
  pinned: false,
  sortOrder: 0,
  createdAt: ts,
  updatedAt: ts,
  archivedAt: null,
};

const githubRepo = {
  owner: "acme",
  repo: "widgets",
  remoteUrl: "https://github.com/acme/widgets.git",
  defaultBranch: "main",
};
const forgeRepo = {
  provider: "forgejo" as const,
  baseUrl: "https://forge.example.com",
  host: "forge.example.com",
  owner: "acme",
  repo: "widgets",
  remoteUrl: "https://forge.example.com/acme/widgets.git",
  defaultBranch: "main",
};

describe("project rows", () => {
  it("round-trips every project kind and keeps the other kind's column empty", () => {
    const projects: Project[] = [
      { ...base, kind: "local" },
      { ...base, kind: "github", github: githubRepo },
      { ...base, kind: "forge", forge: forgeRepo },
    ];
    for (const project of projects) {
      const row = projectToRow(project);
      expect(rowToProject(row)).toEqual(project);
      if (project.kind !== "github") expect(row.github).toBeNull();
      if (project.kind !== "forge") expect(row.forge).toBeNull();
      if (project.kind === "forge") expect(row.forge).toEqual(forgeRepo);
      if (project.kind === "github") expect(row.github).toEqual(githubRepo);
    }
  });

  it("carries a forge remote warning through the row", () => {
    const project: Project = {
      ...base,
      kind: "forge",
      forge: forgeRepo,
      remoteWarning: { code: "forge_remote_missing", remoteUrl: null, detectedAt: ts },
    };
    expect(rowToProject(projectToRow(project))).toEqual(project);
  });
});
