import type { AppServices } from "../../../services/container";
import type { ToolAvailabilityContext } from "../../define";

/**
 * GitHub tools are listed only for callers in a GitHub project (§9: local-only projects get no
 * issue, PR or evidence flow). Writes stay here: a forge project sees none of them until phase B
 * (`docs/forges.md` §4.5). Read tools use `inIssueTrackingProject` instead. Without a caller
 * context they stay listed.
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
 * The read tools: listed for a GitHub project and for a forge project, whose issues and PRs
 * sync read-only in phase A2 (`docs/forges.md` §9). Sits beside `inGithubProject` so adding a
 * forge cannot widen what a write tool may offer.
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
