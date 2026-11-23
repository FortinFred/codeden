import {
  type CreateForgePull,
  type ForgePr,
  type ForgePrDetails,
  type ForgePrDiff,
  type ForgePrFile,
  type ForgePrRef,
  type ForgePullQuery,
  ForgePullQuery as ForgePullQuerySchema,
  type ForgeReview,
  GithubPr,
  type MergeForgePull,
  type SubmitForgeReview,
  type UpdateForgePull,
} from "@codeden/contracts";
import { badRequest, ForgeError } from "../../errors";
import { type ForgejoContext, mapPull, readPull, readPullFiles, repoPath } from "./context";
import { parseUnifiedDiff } from "./diff";
import { commitStatuses, requiredApprovals } from "./git";
import {
  EMPTY_CHECKS,
  reviewDecisionFor,
  toForgePrDetails,
  toForgePrFile,
  toForgeReview,
} from "./map";
import { toForgePrRef } from "./map-git";
import type { ForgejoPull, ForgejoPullCommit, ForgejoReview } from "./types";

/**
 * Pull requests, their files and diff, merge/update calls, and reviews (`docs/forges.md`
 * §5.5–5.6). Draft creation is refused; update-branch checks the head first because Forgejo has
 * no `expected_head_sha`; a merge is pinned with `head_commit_id`.
 */

/** List pull requests across pages, up to the query's limit. */
export async function listPulls(
  context: ForgejoContext,
  query: ForgePullQuery = ForgePullQuerySchema.parse({}),
): Promise<ForgePr[]> {
  const input = ForgePullQuerySchema.parse(query);
  const rows = await context.http.paginate<ForgejoPull>(
    `${repoPath(context)}/pulls`,
    { state: input.state },
    { limit: input.limit },
  );
  return rows.map((row) => mapPull(context, row));
}

/** A PR's live details, including its changed files (without patches). */
export async function getPull(context: ForgejoContext, number: number): Promise<ForgePrDetails> {
  const raw = await readPull(context, number);
  const [pr, files] = await Promise.all([snapshotOf(context, raw), readPullFiles(context, number)]);
  return toForgePrDetails(pr, raw, files);
}

/**
 * One PR as the sync projects it (`docs/forges.md` §8.1): the row, its head's commit statuses,
 * its reviews, the computed review decision and its latest commits. Statuses and reviews are
 * read with the PR, so `pr.checks_*` and `review.submitted` follow from one refresh.
 */
export async function prSnapshot(context: ForgejoContext, number: number): Promise<ForgePr> {
  return snapshotOf(context, await readPull(context, number));
}

async function snapshotOf(context: ForgejoContext, raw: ForgejoPull): Promise<ForgePr> {
  const pr = mapPull(context, raw);
  const [checks, reviews, commits, required] = await Promise.all([
    raw.head.sha
      ? commitStatuses(context, raw.head.sha).catch((error: unknown) => {
          // A head Forgejo does not know has no statuses; anything else must fail the refresh.
          if (error instanceof ForgeError && error.forgeCode === "forge_not_found") {
            return EMPTY_CHECKS;
          }
          throw error;
        })
      : Promise.resolve(EMPTY_CHECKS),
    listReviews(context, raw.number),
    pullCommits(context, raw.number),
    requiredApprovals(context, raw.base.ref),
  ]);
  return GithubPr.parse({
    ...pr,
    checks,
    reviews,
    reviewDecision: reviewDecisionFor(reviews, required),
    commits,
  });
}

/** A PR's changed files across pages (Forgejo's listing carries no patch). */
export async function pullFiles(context: ForgejoContext, number: number): Promise<ForgePrFile[]> {
  return (await readPullFiles(context, number)).map(toForgePrFile);
}

/**
 * A PR's whole diff, split into per-file patches. The head is read before and after; if it
 * moved, the result has `headSha: null` and no files, so the next tick reads it again.
 */
export async function pullDiff(
  context: ForgejoContext,
  number: number,
  expectedHeadSha?: string,
): Promise<ForgePrDiff> {
  const before = await readPull(context, number);
  const empty: ForgePrDiff = { headSha: null, changedFiles: 0, files: [] };
  if (expectedHeadSha && before.head.sha !== expectedHeadSha) return empty;
  const { data } = await context.http.get<string>(
    `${repoPath(context)}/pulls/${number}.diff`,
    undefined,
    { as: "text", accept: "text/plain" },
  );
  const after = await readPull(context, number);
  if (after.head.sha !== before.head.sha) return empty;
  const files = parseUnifiedDiff(data ?? "");
  return { headSha: before.head.sha, changedFiles: files.length, files };
}

/** A PR's commits (up to 50, oldest first), as the projection stores them. */
export async function pullCommits(
  context: ForgejoContext,
  number: number,
): Promise<Array<{ sha: string; message: string }>> {
  const rows = await context.http.paginate<ForgejoPullCommit>(
    `${repoPath(context)}/pulls/${number}/commits`,
    { files: false, verification: false },
    { limit: 50 },
  );
  return rows.map((row) => ({ sha: row.sha, message: row.commit?.message ?? "" }));
}

/** Open a PR; Forgejo has no draft field, so a draft request fails closed. */
export async function createPull(
  context: ForgejoContext,
  request: CreateForgePull,
): Promise<ForgePrRef> {
  if (request.draft) {
    throw badRequest(
      "Forgejo cannot create draft pull requests; open the pull request ready instead.",
      "draft_unsupported",
    );
  }
  const { data } = await context.http.request<ForgejoPull>(`${repoPath(context)}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: request.title,
      body: request.body,
      head: request.head,
      base: request.base,
    }),
  });
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no pull request.");
  return toForgePrRef(data);
}

/** Update a PR's title, body, state or base branch. */
export async function updatePull(
  context: ForgejoContext,
  number: number,
  request: UpdateForgePull,
): Promise<ForgePrRef> {
  const body: Record<string, unknown> = {};
  if (request.title !== undefined) body.title = request.title;
  if (request.body !== undefined) body.body = request.body;
  if (request.state !== undefined) body.state = request.state;
  if (request.base !== undefined) body.base = request.base;
  const { data } = await context.http.request<ForgejoPull>(`${repoPath(context)}/pulls/${number}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no pull request.");
  return toForgePrRef(data);
}

/** Merge a PR, pinned to `headSha` when given; the PR is read back for its merge commit. */
export async function mergePull(
  context: ForgejoContext,
  number: number,
  request: MergeForgePull,
): Promise<{ merged: boolean; sha: string | null }> {
  const body: Record<string, unknown> = { Do: request.method };
  if (request.title !== undefined) body.MergeTitleField = request.title;
  if (request.message !== undefined) body.MergeMessageField = request.message;
  if (request.headSha !== undefined) body.head_commit_id = request.headSha;
  await context.http.request(`${repoPath(context)}/pulls/${number}/merge`, {
    method: "POST",
    body: JSON.stringify(body),
    as: "none",
  });
  const raw = await readPull(context, number);
  return {
    merged: raw.merged === true || Boolean(raw.merged_at),
    sha: raw.merge_commit_sha ?? null,
  };
}

/**
 * Bring a PR up to date with its base and report the new head. Forgejo has no
 * `expected_head_sha`, so the head is checked first and the call is refused when it moved; the
 * branch is updated at once, so reading it back says what the next approval and `diffKey`
 * checks see (§5.5, §6.3).
 */
export async function updateBranch(
  context: ForgejoContext,
  number: number,
  request: { expectedHeadSha: string },
): Promise<string> {
  const raw = await readPull(context, number);
  if (raw.head.sha !== request.expectedHeadSha) {
    throw new ForgeError(
      "forge_conflict",
      "The pull request's head changed; refusing to update it.",
    );
  }
  await context.http.request(`${repoPath(context)}/pulls/${number}/update`, {
    method: "POST",
    query: { style: "merge" },
    as: "none",
  });
  const after = await readPull(context, number);
  return after.head.sha;
}

/** Comment on a PR, then close it. */
export async function closePull(
  context: ForgejoContext,
  number: number,
  comment: string,
): Promise<void> {
  if (comment.trim()) {
    await context.http.request(`${repoPath(context)}/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: comment }),
      as: "none",
    });
  }
  await context.http.request(`${repoPath(context)}/pulls/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
    as: "none",
  });
}

/** A PR's reviews across pages, with Forgejo's `official` and `stale` flags. */
export async function listReviews(context: ForgejoContext, number: number): Promise<ForgeReview[]> {
  const rows = await context.http.paginate<ForgejoReview>(
    `${repoPath(context)}/pulls/${number}/reviews`,
  );
  return rows.map(toForgeReview);
}

/** Submit a review, pinned to a head commit. */
export async function submitReview(
  context: ForgejoContext,
  number: number,
  request: SubmitForgeReview,
): Promise<ForgeReview> {
  const event = {
    approved: "APPROVED",
    changes_requested: "REQUEST_CHANGES",
    commented: "COMMENT",
    pending: "PENDING",
  }[request.event];
  const { data } = await context.http.request<ForgejoReview>(
    `${repoPath(context)}/pulls/${number}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({
        event,
        body: request.body,
        commit_id: request.commitId,
        comments: [],
      }),
    },
  );
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no review.");
  return toForgeReview(data);
}
