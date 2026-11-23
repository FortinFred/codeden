import type { Project } from "@codeden/contracts";
import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../src/mcp/registry";
import { allTools } from "../src/mcp/tools";
import { commentOnIssueTool } from "../src/mcp/tools/github/comment-on-issue";
import { createIssue, listIssues, triageIssue } from "../src/mcp/tools/pm/github";
import type { AppServices } from "../src/services/container";

/**
 * `docs/forges.md` phases A2 and B1: a forge project gets the issue tools (reads, and the issue
 * writes create/comment/label/triage) through the shared service; PR, merge, evidence and the
 * factory's GitHub notices stay GitHub-only.
 */

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
/** Issue writes, served for a forge project through the shared service (phase B1). */
const ISSUE_WRITES = ["triage_issue", "create_issue", "comment_on_issue", "report_triage"];
/** Pull requests, evidence, review and merge: GitHub only until phase B2. */
const GITHUB_ONLY = ["create_pull_request", "attach_evidence"];

describe("GitHub tools for a forge project", () => {
  it("lists the issue tools for a forge project and no PR or evidence tool", () => {
    const names = [...toolsFor(forge.id, "pm"), ...toolsFor(forge.id, "agent")];
    expect(names).toEqual(expect.arrayContaining([...READS, ...ISSUE_WRITES]));
    for (const name of GITHUB_ONLY) expect(names).not.toContain(name);
  });

  it("keeps every read and write for a GitHub project", () => {
    const names = [...toolsFor(github.id, "pm"), ...toolsFor(github.id, "agent")];
    expect(names).toEqual(expect.arrayContaining([...READS, ...ISSUE_WRITES, ...GITHUB_ONLY]));
  });

  it("lists neither reads nor writes for a local project", () => {
    const names = [...toolsFor(local.id, "pm"), ...toolsFor(local.id, "agent")];
    for (const name of [...READS, ...ISSUE_WRITES, ...GITHUB_ONLY]) {
      expect(names).not.toContain(name);
    }
  });

  it("says the project's forge in the descriptions that cover both", () => {
    const registry = new ToolRegistry(allTools, services());
    const pm = registry.list("pm", { projectId: forge.id, sessionId: null });
    expect(pm.find((t) => t.name === "list_issues")?.description).toContain("its forge");
    expect(pm.find((t) => t.name === "get_issue")?.description).toContain("its forge");
    expect(pm.find((t) => t.name === "triage_issue")?.description).toContain("the project's forge");
    expect(pm.find((t) => t.name === "create_issue")?.description).toContain("the project's forge");
    const agent = registry.list("agent", { projectId: forge.id, sessionId: null });
    expect(agent.find((t) => t.name === "get_pr_status")?.description).toContain("project's forge");
    expect(agent.find((t) => t.name === "comment_on_issue")?.description).toContain(
      "project's forge",
    );
  });

  it("writes a forge project's issues through the shared port", async () => {
    const listPort = vi.fn(async () => []);
    const triagePort = vi.fn(async () => ({ closed: true }));
    const createPort = vi.fn(async () => ({ number: 1 }));
    const commentPort = vi.fn(async () => ({ id: 1, url: "http://forge/issues/1" }));
    const withPort = services({
      orchestration: {
        github: { listIssues: listPort, triageIssue: triagePort, createIssue: createPort },
      },
      github: { commentOnIssue: commentPort },
    });
    const caller = { services: withPort, projectId: forge.id } as never;

    await listIssues.handler({ state: "open" }, caller);
    expect(listPort).toHaveBeenCalledWith(forge, { state: "open" });

    await triageIssue.handler({ number: 1, decision: "ready" }, caller);
    expect(triagePort).toHaveBeenCalledWith(forge, 1, { decision: "ready" });

    await createIssue.handler({ title: "Bug", body: "" }, caller);
    expect(createPort).toHaveBeenCalledWith(forge, { title: "Bug", body: "", labels: undefined });

    await commentOnIssueTool.handler({ number: 1, body: "Hi" }, caller);
    expect(commentPort).toHaveBeenCalledWith(forge.id, 1, "Hi");
  });
});
