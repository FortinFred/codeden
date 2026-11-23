import { z } from "zod";
import { defineTool } from "../../define";
import { inIssueTrackingProject } from "../github/available";
import { issueTrackingProject } from "../shared/helpers";

/** `list_issues` (§8.3): read-only, so it is listed for a forge project too (phase A2). */
export const listIssues = defineTool({
  name: "list_issues",
  description:
    "List this project's issues from its forge (GitHub, or Forgejo for a forge project), open by default, optionally by label.",
  roles: ["pm"],
  scope: "project",
  isAvailable: inIssueTrackingProject,
  input: z.object({
    state: z.enum(["open", "closed", "all"]).optional(),
    labels: z.array(z.string()).optional(),
    limit: z.int().min(1).max(100).optional(),
  }),
  handler: async (query, { services, projectId }) => {
    const issues = await services.orchestration.github.listIssues(
      issueTrackingProject(services, projectId),
      query,
    );
    return { count: issues.length, issues };
  },
});

/** `get_issue` (§8.3): a read, so it is listed for a forge project too (phase A2). */
export const getIssue = defineTool({
  name: "get_issue",
  description: "One issue of this project from its forge, with its body and comments.",
  roles: ["pm"],
  scope: "project",
  isAvailable: inIssueTrackingProject,
  input: z.object({ number: z.int().positive() }),
  handler: async ({ number }, { services, projectId }) =>
    services.orchestration.github.getIssue(issueTrackingProject(services, projectId), number),
});

/**
 * `triage_issue` (§8.3, §10 issue triage): labels, comment, accept or decline. An issue write
 * through the project's forge (phase B1), so it is listed for a forge project too.
 */
export const triageIssue = defineTool({
  name: "triage_issue",
  description:
    "Record a triage decision on an issue in the project's forge: ready, needs_info, unsafe, out_of_scope or duplicate, with labels to add or remove and an optional comment (close: true for out of scope or duplicates). Follow the project's policy. When you can't decide, choose needs_info (ask the author the specific questions in the comment) or unsafe (it needs a human decision); don't wait on the user.",
  roles: ["pm"],
  scope: "project",
  isAvailable: inIssueTrackingProject,
  input: z.object({
    number: z.int().positive(),
    decision: z.enum(["ready", "needs_info", "unsafe", "out_of_scope", "duplicate"]),
    labels: z.array(z.string()).optional(),
    removeLabels: z.array(z.string()).optional(),
    comment: z.string().min(1).max(10_000).optional(),
    close: z.boolean().optional(),
  }),
  handler: async ({ number, ...triage }, { services, projectId }) =>
    services.orchestration.github.triageIssue(
      issueTrackingProject(services, projectId),
      number,
      triage,
    ),
});

/** `create_issue` (§8.3): an issue write through the project's forge (phase B1). */
export const createIssue = defineTool({
  name: "create_issue",
  description:
    "Create an issue in the project's forge (for planned work: include a work key and acceptance criteria in the body).",
  roles: ["pm"],
  scope: "project",
  isAvailable: inIssueTrackingProject,
  input: z.object({
    title: z.string().trim().min(1).max(256),
    body: z.string().max(60_000),
    labels: z.array(z.string()).optional(),
  }),
  handler: async (issue, { services, projectId }) =>
    services.orchestration.github.createIssue(issueTrackingProject(services, projectId), issue),
});
