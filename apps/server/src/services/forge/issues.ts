import {
  type CreateGithubIssueRequest,
  type GithubIssue,
  GithubIssue as GithubIssueSchema,
  type GithubLabelRequest,
  type TriageIssueRequest,
  type TriageIssueResult,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { diffIssue } from "../github/diff";
import { withCodedenMarker } from "../github/issues";
import type { GithubStore } from "../github/store";
import type { ForgejoClient } from "./forgejo/client";

/**
 * Issue writes on a forge project (`docs/forges.md` §5.4, phase B1): create, comment, label and
 * triage. The Forgejo client does the call; this module projects what the forge answered into the
 * shared issue tables (appending `issue.*` as GitHub does), so the UI and the PM see a write at
 * once instead of at the next poll. Labels go up by name for add/remove (Forgejo silently drops
 * unknown ones) and by ID for a create (resolved from names first, with a name that has no label
 * logged by the client). A label write is followed by a read-back and a report of the names that
 * did not stick; a create answers with the forge's own row.
 *
 * There is no close reason: a triage close leaves `stateReason` null, and nothing in this module
 * treats a closed forge issue as completed.
 */

export interface ForgeIssueDeps {
  /** The shared issue projections (`github_issues`). */
  data: GithubStore;
  /** Domain events: the write's `issue.*` projection and its triggers. */
  events: EventStore;
  /** Where a label the forge did not apply is reported. Never passed a token. */
  log?: (message: string) => void;
}

/** Project an issue the forge just returned (appends `issue.*` when it differs). */
function project(deps: ForgeIssueDeps, projectId: string, raw: GithubIssue): GithubIssue {
  const next = GithubIssueSchema.parse(raw);
  const events = diffIssue(deps.data.issue(projectId, next.number), next);
  if (events.length > 0) deps.events.append(events);
  return deps.data.issue(projectId, next.number) ?? next;
}

/** The requested label names the issue does not carry (names compare case-insensitively). */
function notApplied(requested: string[], issue: GithubIssue): string[] {
  const applied = new Set(issue.labels.map((label) => label.toLowerCase()));
  return requested.filter((name) => !applied.has(name.toLowerCase()));
}

/** Say which requested labels the read-back issue does not have, so a typo is never silent. */
function reportLabels(
  deps: ForgeIssueDeps,
  number: number,
  requested: string[],
  issue: GithubIssue,
): void {
  const missing = notApplied(requested, issue);
  if (missing.length === 0) return;
  deps.log?.(
    `forge: issue #${number} did not get the label${missing.length === 1 ? "" : "s"} ${missing
      .map((name) => `"${name}"`)
      .join(", ")} (Forgejo applies only labels that exist in the repository).`,
  );
}

/** Create an issue; its labels are names, resolved to IDs by the client. */
export async function createIssue(
  deps: ForgeIssueDeps,
  projectId: string,
  client: ForgejoClient,
  req: CreateGithubIssueRequest,
): Promise<GithubIssue> {
  // The client resolves names to IDs and logs a name it cannot find (§5.4); the row it returns
  // is the forge's own read-back, so the labels shown are the ones that applied.
  const issue = await client.createIssue({ title: req.title, body: req.body, labels: req.labels });
  return project(deps, projectId, issue);
}

/** Comment on an issue or a PR conversation, with CodeDen's hidden marker as on GitHub. */
export async function commentOnIssue(
  client: ForgejoClient,
  number: number,
  body: string,
): Promise<{ id: number; url: string }> {
  const comment = await client.comment(number, withCodedenMarker(body));
  const id = Number.parseInt(comment.id, 10);
  // Forgejo comment ids are integers; the shared response shape is numeric.
  return { id: Number.isFinite(id) ? id : 0, url: comment.url };
}

/** Add and remove labels by name, then read the issue back and report what applied. */
export async function labelIssue(
  deps: ForgeIssueDeps,
  projectId: string,
  client: ForgejoClient,
  number: number,
  req: GithubLabelRequest,
): Promise<GithubIssue> {
  const changed = await client.updateLabels(number, { add: req.add, remove: req.remove });
  reportLabels(deps, number, req.add, changed);
  return project(deps, projectId, changed);
}

/**
 * A triage decision (§5.4): labels, an optional comment, and an optional close. Forgejo cannot
 * record why an issue was closed, so the close carries no reason and the result's `issue` has
 * `stateReason: null` — a closed forge issue is never reported as completed.
 */
export async function triageIssue(
  deps: ForgeIssueDeps,
  projectId: string,
  client: ForgejoClient,
  number: number,
  req: TriageIssueRequest,
): Promise<TriageIssueResult> {
  if (req.labels.length > 0 || req.removeLabels.length > 0) {
    await labelIssue(deps, projectId, client, number, {
      add: req.labels,
      remove: req.removeLabels,
    });
  }
  const comment = req.comment ? await commentOnIssue(client, number, req.comment) : null;
  // The reason is a GitHub habit: Forgejo accepts no close reason, and the read-back stays null.
  const closed = req.close
    ? await client.closeIssue(number, req.decision === "ready" ? "completed" : "not_planned")
    : await client.getIssue(number);
  const issue = project(deps, projectId, closed);
  return {
    issue,
    decision: req.decision,
    commentUrl: comment?.url ?? null,
    closed: issue.state === "closed",
  };
}
