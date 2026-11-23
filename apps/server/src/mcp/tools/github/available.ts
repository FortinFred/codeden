import type { AppServices } from "../../../services/container";
import type { ToolAvailabilityContext } from "../../define";

/**
 * The GitHub-only tools: evidence and the factory's GitHub notices. Listed only for a GitHub
 * project (§9). Pull requests and issue reads/writes use `inPullRequestProject` /
 * `inIssueTrackingProject`, which serve a forge project too (`docs/forges.md` phase B2).
 * Without a caller context they stay listed.
 */
export function inGithubProject(services: AppServices, caller?: ToolAvailabilityContext): boolean {
  if (!caller) return true;
  if (!caller.projectId) return false;
  try {
    return services.projects.get(caller.projectId).kind === "github";
  } catch {
    return false;
  }
}

/**
 * The pull request tools: listed for a GitHub project and for a forge project, whose PR writes
 * go through the same `GithubService` seam (`docs/forges.md` §9, phase B2). Evidence and merge
 * stay on `inGithubProject` until their phases.
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
 * shared `GithubService` seam (`docs/forges.md` §9). Sits beside `inGithubProject` so adding a
 * forge cannot widen what a PR, merge or evidence tool may offer.
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
