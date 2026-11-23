import {
  type CreateForgeIssue,
  CreateForgeIssue as CreateForgeIssueSchema,
  type ForgeIssue,
  type ForgeIssueComment,
  type ForgeIssueDetails,
  type ForgeIssueQuery,
  ForgeIssueQuery as ForgeIssueQuerySchema,
} from "@codeden/contracts";
import { ForgeError } from "../../errors";
import {
  type ForgejoContext,
  readComments,
  readIssue,
  readRepoLabels,
  repoPath,
  resolveLabels,
  seg,
} from "./context";
import { toForgeIssue, toForgeIssueComment, toForgeIssueDetails } from "./map";
import type { ForgejoComment, ForgejoIssue, ForgejoLabel } from "./types";

/**
 * Issues, comments and labels (`docs/forges.md` §5.4). Create takes label IDs (resolved from
 * names first); add/remove take names. Forgejo never records a close reason, so a closed issue
 * is not "completed".
 */

/** What the sync asks of the issue listing: a state, an `updated` cursor and a hard cap. */
export interface ForgejoIssueListQuery {
  state: "open" | "closed" | "all";
  /** RFC 3339; Forgejo filters on `updated_at` at or after this instant. */
  since?: string;
  /** `recentupdate` lists the most recently updated first (the incremental sync's order). */
  sort?: "recentupdate";
  /** Maximum rows across pages. */
  limit?: number;
}

/**
 * Raw rows of `GET /issues`, pull request rows included. The sync's baseline and cursor need
 * them to tell a PR's number from an issue's; `listIssues` filters the PR rows out.
 */
export function listIssueRows(
  context: ForgejoContext,
  query: ForgejoIssueListQuery,
): Promise<ForgejoIssue[]> {
  return context.http.paginate<ForgejoIssue>(
    `${repoPath(context)}/issues`,
    { state: query.state, since: query.since, sort: query.sort },
    { limit: query.limit ?? 500 },
  );
}

/** List issues (pull requests are filtered out), across pages, up to the query's limit. */
export async function listIssues(
  context: ForgejoContext,
  query: ForgeIssueQuery = ForgeIssueQuerySchema.parse({}),
): Promise<ForgeIssue[]> {
  const input = ForgeIssueQuerySchema.parse(query);
  const rows = await context.http.paginate<ForgejoIssue>(
    `${repoPath(context)}/issues`,
    {
      state: input.state,
      labels: input.labels.length > 0 ? input.labels.join(",") : undefined,
      sort: input.state === "all" ? "recentupdate" : undefined,
    },
    { limit: input.limit },
  );
  return rows.filter((row) => !row.pull_request).map((row) => toForgeIssue(context.projectId, row));
}

/** One issue by its repository index. */
export async function getIssue(context: ForgejoContext, number: number): Promise<ForgeIssue> {
  return toForgeIssue(context.projectId, await readIssue(context, number));
}

/** An issue with its latest comments (up to 20, oldest first). */
export async function issueDetails(
  context: ForgejoContext,
  number: number,
): Promise<ForgeIssueDetails> {
  const issue = await getIssue(context, number);
  const comments = await readComments(context, number, { limit: 50 });
  return toForgeIssueDetails(issue, comments);
}

/** Comments on an issue or PR conversation, oldest first. */
export async function comments(
  context: ForgejoContext,
  number: number,
  options: { since?: string; limit?: number } = {},
): Promise<ForgeIssueComment[]> {
  const rows = await readComments(context, number, options);
  return rows.map(toForgeIssueComment);
}

/** The repository's labels, for resolving create-issue label names to IDs. */
export function repoLabels(context: ForgejoContext): Promise<ForgejoLabel[]> {
  return readRepoLabels(context);
}

/** Create an issue, resolving label names to IDs first and dropping unknown names. */
export async function createIssue(
  context: ForgejoContext,
  request: CreateForgeIssue,
): Promise<ForgeIssue> {
  const input = CreateForgeIssueSchema.parse(request);
  const labels = input.labels.length > 0 ? await resolveLabels(context, input.labels) : [];
  const { data } = await context.http.request<ForgejoIssue>(`${repoPath(context)}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: input.title, body: input.body, labels }),
  });
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no issue.");
  return toForgeIssue(context.projectId, data);
}

/** Comment on an issue or PR conversation. Returns the new comment's id and URL. */
export async function comment(
  context: ForgejoContext,
  number: number,
  body: string,
): Promise<{ id: string; url: string }> {
  const { data } = await context.http.request<ForgejoComment>(
    `${repoPath(context)}/issues/${number}/comments`,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no comment.");
  return {
    id: String(data.id),
    url:
      data.html_url ??
      `${context.http.base.baseUrl}/${context.owner}/${context.repo}/issues/${number}`,
  };
}

/** Add labels by name; unknown names are ignored by Forgejo, then the issue is read back. */
export async function addLabels(
  context: ForgejoContext,
  number: number,
  labels: string[],
): Promise<ForgeIssue> {
  if (labels.length > 0) {
    await context.http.request(`${repoPath(context)}/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
      as: "none",
    });
  }
  return getIssue(context, number);
}

/** Remove labels by name; a label the issue doesn't have is already absent. */
export async function removeLabels(
  context: ForgejoContext,
  number: number,
  labels: string[],
): Promise<ForgeIssue> {
  for (const label of labels) {
    try {
      await context.http.request(`${repoPath(context)}/issues/${number}/labels/${seg(label)}`, {
        method: "DELETE",
        as: "none",
      });
    } catch (error) {
      if (!(error instanceof ForgeError && error.forgeCode === "forge_not_found")) throw error;
    }
  }
  return getIssue(context, number);
}

/** Replace every label on an issue with `labels`. */
export async function replaceLabels(
  context: ForgejoContext,
  number: number,
  labels: string[],
): Promise<ForgeIssue> {
  await context.http.request(`${repoPath(context)}/issues/${number}/labels`, {
    method: "PUT",
    body: JSON.stringify({ labels }),
    as: "none",
  });
  return getIssue(context, number);
}

/** Add and then remove labels, then read the issue back. */
export async function updateLabels(
  context: ForgejoContext,
  number: number,
  change: { add: string[]; remove: string[] },
): Promise<ForgeIssue> {
  if (change.add.length > 0) await addLabels(context, number, change.add);
  if (change.remove.length > 0) await removeLabels(context, number, change.remove);
  return getIssue(context, number);
}

/** Close an issue; `reason` is accepted for the port but Forgejo cannot record it. */
export async function closeIssue(
  context: ForgejoContext,
  number: number,
  reason: "completed" | "not_planned",
): Promise<ForgeIssue> {
  void reason;
  const { data } = await context.http.request<ForgejoIssue>(
    `${repoPath(context)}/issues/${number}`,
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
  );
  return toForgeIssue(context.projectId, data ?? (await readIssue(context, number)));
}
