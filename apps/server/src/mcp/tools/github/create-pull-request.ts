import { z } from "zod";
import type { AppServices } from "../../../services/container";
import { defineTool, type ToolAvailabilityContext } from "../../define";
import { inPullRequestProject } from "./available";

/** Listed in GitHub and forge projects, except to sessions with read-only permissions (§11.2). */
function available(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  if (!inPullRequestProject(services, caller)) return false;
  if (!caller?.sessionId) return true;
  try {
    return services.sessions.detail(caller.sessionId).session.autonomy !== "read_only";
  } catch {
    return true;
  }
}

/** `create_pull_request` (§8.3, §9): push the session branch and open or update its PR. */
export const createPullRequestTool = defineTool({
  name: "create_pull_request",
  description:
    "Push your branch and open a pull request for your work on the project's forge (or update the title/body of the one already open for your branch). The body gets `Fixes #<issue>` for your session's issue (or `issue`) and a link to this CodeDen session. Commit your changes first, or pass `commitMessage` to commit everything that is uncommitted. Use `draft: true` for work that is not ready for review; a Forgejo project refuses drafts, so open it ready there. Only for GitHub and forge projects.",
  roles: ["agent"],
  scope: "session",
  isAvailable: available,
  alwaysLoad: true,
  input: z.object({
    title: z.string().min(1).max(256).describe("Conventional, imperative title"),
    body: z
      .string()
      .max(60_000)
      .optional()
      .describe("Markdown: what changed, why, and how it was tested"),
    draft: z.boolean().optional(),
    base: z.string().min(1).optional().describe("Target branch; default the session's base branch"),
    issue: z
      .int()
      .positive()
      .optional()
      .describe("Issue the PR resolves; default the session's issue"),
    commitMessage: z
      .string()
      .min(1)
      .max(5_000)
      .optional()
      .describe("Commit uncommitted changes with this message before pushing"),
  }),
  handler: async (input, { services, sessionId, projectId }) => {
    // A factory builder whose spec waits for a person's approval builds nothing yet.
    services.factory.assertMayOpenPr(sessionId);
    const result = await services.github.createPullRequest(sessionId, input);
    const verb = result.created ? "Opened" : "Updated";
    const commit = result.commit ? ` Committed ${result.commit.slice(0, 7)} first.` : "";
    // Evidence is GitHub-only for now (`docs/forges.md` phase D); a forge agent has no such tool.
    const evidence =
      projectKind(services, projectId) === "forge" ? "" : " Attach evidence with attach_evidence.";
    return `${verb} pull request #${result.number} (${result.state}) from ${result.branch} into ${result.base}: ${result.url}.${commit}${evidence}`;
  },
});

/** The caller's project kind, tolerating a missing look-up in a scripted test. */
function projectKind(services: AppServices, projectId: string | null): string | null {
  if (!projectId) return null;
  try {
    return services.projects?.get(projectId)?.kind ?? null;
  } catch {
    return null;
  }
}
