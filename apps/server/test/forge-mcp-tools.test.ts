import type { Project } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { allTools } from "../src/mcp/tools";
import { listIssues, triageIssue } from "../src/mcp/tools/pm/github";
import type { AppServices } from "../src/services/container";

/** `docs/forges.md` phase A2: a forge project gets the read tools, never a write. */

const project = (id: string, name: string, kind: Project["kind"]): Project =>
  ({ id, name, kind, autonomyMode: "assisted" }) as unknown as Project;

const forge = project("p-forge", "widgets", "forge");
const github = project("p-gh", "github-widgets", "github");
const local = project("p-local", "notes", "local");
const projects = new Map([forge, github, local].map((p) => [p.id, p]));

/** The minimal services the availability checks read. */
function services(extra: Record<string, unknown> = {}): AppServices {
  return {
    projects: {
      get: (id: string) => {
        const found = projects.get(id);
        if (!found) throw new Error(`No project ${id}`);
        return found;
      },
    },
    images: { availableNow: () => false },
    ...extra,
  } as unknown as AppServices;
}

const toolsFor = (id: string, role: "pm" | "agent"): string[] =>
  new ToolRegistry(allTools, services())
    .forRole(role, { projectId: id, sessionId: null })
    .map((tool) => tool.name);

const READS = ["list_issues", "get_issue", "get_pr_status"];
const WRITES = [
  "triage_issue",
  "create_issue",
  "comment_on_issue",
  "create_pull_request",
  "attach_evidence",
  "report_triage",
];

describe("GitHub tools for a forge project", () => {
  it("lists the read tools and none of the writes", () => {
    const names = [...toolsFor(forge.id, "pm"), ...toolsFor(forge.id, "agent")];
    expect(names).toEqual(expect.arrayContaining(READS));
    for (const name of WRITES) expect(names).not.toContain(name);
  });

  it("keeps every read and write for a GitHub project", () => {
    const names = [...toolsFor(github.id, "pm"), ...toolsFor(github.id, "agent")];
    expect(names).toEqual(expect.arrayContaining([...READS, ...WRITES]));
  });

  it("lists neither reads nor writes for a local project", () => {
    const names = [...toolsFor(local.id, "pm"), ...toolsFor(local.id, "agent")];
    for (const name of [...READS, ...WRITES]) expect(names).not.toContain(name);
  });

  it("says the project's forge in the read descriptions", () => {
    const registry = new ToolRegistry(allTools, services());
    const pm = registry.list("pm", { projectId: forge.id, sessionId: null });
    expect(pm.find((t) => t.name === "list_issues")?.description).toContain("its forge");
    expect(pm.find((t) => t.name === "get_issue")?.description).toContain("its forge");
    const agent = registry.list("agent", { projectId: forge.id, sessionId: null });
    expect(agent.find((t) => t.name === "get_pr_status")?.description).toContain("project's forge");
  });

  it("reads a forge project's issues through the shared port, and refuses a GitHub write", async () => {
    const listPort = vi.fn(async () => []);
    const withPort = services({ orchestration: { github: { listIssues: listPort } } });
    await listIssues.handler({ state: "open" }, {
      services: withPort,
      projectId: forge.id,
    } as never);
    expect(listPort).toHaveBeenCalledWith(forge, { state: "open" });

    await expect(
      triageIssue.handler({ number: 1, decision: "ready" }, {
        services: withPort,
        projectId: forge.id,
      } as never),
    ).rejects.toThrow("that GitHub action is not available yet");
  });
});
