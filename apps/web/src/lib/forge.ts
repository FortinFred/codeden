import type { ForgeProvider, Project } from "@codeden/contracts";

const NAMES: Record<ForgeProvider, string> = { github: "GitHub", forgejo: "Forgejo" };

/** A forge provider's display name, e.g. `Forgejo`. */
export function providerName(provider: ForgeProvider): string {
  return NAMES[provider];
}

/**
 * The forge a project's issues and pull requests come from: "GitHub" for a GitHub project, the
 * provider's name for a forge project, so the panel and its tab say which one without branching
 * on a provider id.
 */
export function projectForgeName(project: Project): string {
  return providerName(project.kind === "forge" ? project.forge.provider : "github");
}

/**
 * Phase A2 is read-only for a forge (`docs/forges.md` §4.5): no comments, labels, triage, merge,
 * PR creation or evidence until phase B/D. The UI hides those affordances rather than offering
 * buttons that would be refused.
 */
export function isReadOnlyForge(project: Project | null | undefined): boolean {
  return project?.kind === "forge";
}
