import type { AppServices } from "../../../services/container";
import type { ToolAvailabilityContext } from "../../define";

/**
 * The pull request tools (including `attach_evidence` and `create_pull_request`): listed for a
 * GitHub project and for a forge project, whose PR writes and evidence go through the same
 * `GithubService` seam (`docs/forges.md` §9, phases B2 and D).
 */
export function inPullRequestProject(
  services: AppServices,
  caller?: ToolAvailabilityContext,
): boolean {
  if (!caller) return true;
  if (!caller.projectId) return false;
  try {
    const kind = services.projects.get(caller.projectId).kind;
    return kind === "github" || kind === "forge";
  } catch {
    return false;
  }
}

/**
 * The issue-tracking tools (reads, and in phase B1 the issue writes: create, comment, label,
 * triage): listed for a GitHub project and for a forge project, whose issues flow through the
 * shared `GithubService` seam (`docs/forges.md` §9). It is separate from the PR tools so adding
 * a forge cannot widen what an issue tool may offer.
 */
export function inIssueTrackingProject(
  services: AppServices,
  caller?: ToolAvailabilityContext,
): boolean {
  if (!caller) return true;
  if (!caller.projectId) return false;
  try {
    const kind = services.projects.get(caller.projectId).kind;
    return kind === "github" || kind === "forge";
  } catch {
    return false;
  }
}
