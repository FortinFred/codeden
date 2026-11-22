import {
  type ForgeChecksSummary,
  type ForgeIssue,
  type ForgeIssueComment,
  type ForgeIssueDetails,
  type ForgePr,
  type ForgePrDetails,
  type ForgePrDiffFile,
  type ForgePrFile,
  type ForgeReview,
  GithubIssue,
  GithubIssueDetails,
  GithubPr,
  GithubPrDetails,
  GithubReview,
  type Mergeable,
  type ReviewDecision,
} from "@codeden/contracts";
import type {
  ForgejoComment,
  ForgejoIssue,
  ForgejoPull,
  ForgejoPullFile,
  ForgejoReview,
} from "./types";

/** The epoch, for a row a forge did not stamp (the schemas need a timestamp). */
const NEVER = "1970-01-01T00:00:00.000Z";

/** A checks summary with nothing on the head: what a list row says before statuses are read. */
export const EMPTY_CHECKS: ForgeChecksSummary = {
  state: "none",
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
  checks: [],
};

/** Map one issue row. Forgejo has no `state_reason`, so it is always null (never completed). */
export function toForgeIssue(projectId: string, raw: ForgejoIssue): ForgeIssue {
  return GithubIssue.parse({
    projectId,
    number: raw.number,
    title: raw.title,
    state: raw.state === "closed" ? "closed" : "open",
    url: raw.html_url,
    labels: (raw.labels ?? []).map((label) => label.name).filter(Boolean),
    author: raw.user?.login ?? null,
    body: raw.body ?? null,
    comments: raw.comments ?? 0,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? raw.created_at ?? NEVER,
    closedAt: raw.closed_at ?? null,
    stateReason: null,
    sessionIds: [],
  });
}

/** Map one issue or PR comment. The raw body is kept; the marker is stripped by the caller. */
export function toForgeIssueComment(raw: ForgejoComment): ForgeIssueComment {
  return {
    id: raw.id,
    author: raw.user?.login ?? null,
    body: raw.body ?? "",
    createdAt: raw.created_at ?? NEVER,
    url: raw.html_url ?? "",
  };
}

/** An issue with its most recent comments (up to 20, oldest first). */
export function toForgeIssueDetails(
  issue: ForgeIssue,
  comments: ForgejoComment[],
): ForgeIssueDetails {
  return GithubIssueDetails.parse({
    ...issue,
    recentComments: comments.slice(-20).map(toForgeIssueComment),
  });
}

/**
 * Issue numbers a PR body closes, from Forgejo's closing keywords. Forgejo closes issues on
 * merge with the same words GitHub does, and has no `closingIssuesReferences` field. Sorted and
 * de-duplicated so the projection is stable.
 */
export function parseClosingIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const found = new Set<number>();
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;
  for (const match of body.matchAll(pattern)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) found.add(number);
  }
  return [...found].sort((a, b) => a - b);
}

/** What a caller already read about a PR's reviews and checks, to fill the projection row. */
export interface PrMappingContext {
  checks?: ForgeChecksSummary;
  reviews?: ForgeReview[];
  reviewDecision?: ReviewDecision;
  mergeable?: Mergeable;
  commits?: Array<{ sha: string; message: string }>;
}

/** Map one pull request row onto the projection shape CodeDen stores. */
export function toForgePr(
  projectId: string,
  raw: ForgejoPull,
  context: PrMappingContext = {},
): ForgePr {
  const state =
    raw.merged || raw.merged_at
      ? "merged"
      : raw.state === "closed"
        ? "closed"
        : raw.draft
          ? "draft"
          : "open";
  return GithubPr.parse({
    id: `${projectId}:${raw.number}`,
    projectId,
    number: raw.number,
    title: raw.title,
    state,
    url: raw.html_url,
    author: raw.user?.login ?? null,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    headSha: raw.head.sha || null,
    checks: context.checks ?? EMPTY_CHECKS,
    reviewDecision: context.reviewDecision ?? "none",
    reviews: context.reviews ?? [],
    mergeable: context.mergeable ?? baseMergeable(raw),
    linkedIssues: parseClosingIssues(raw.body),
    requestedReviewers: requestedReviewers(raw),
    commits: context.commits ?? [],
    sessionId: null,
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? raw.created_at ?? NEVER,
    mergedAt: raw.merged_at ?? null,
    closedAt: raw.closed_at ?? null,
  });
}

/** A PR's live details: the projection plus body, counts and its changed files (no patches). */
export function toForgePrDetails(
  pr: ForgePr,
  raw: ForgejoPull,
  files: ForgejoPullFile[],
): ForgePrDetails {
  return GithubPrDetails.parse({
    ...pr,
    body: raw.body ?? "",
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changed_files ?? files.length,
    // Forgejo has no `mergeable_state`; the merge call is the final authority.
    mergeState: "unknown",
    files: files.map(toForgePrFile),
  });
}

/** One changed file, without a patch (Forgejo's file listing sends none). */
export function toForgePrFile(raw: ForgejoPullFile): ForgePrFile {
  return {
    path: raw.filename,
    ...(raw.previous_filename ? { previousPath: raw.previous_filename } : {}),
    status: raw.status,
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
  };
}

/** What the previous read of the same PR said, so `mergeable: false` can settle. */
export interface PreviousMergeable {
  headSha: string;
  mergeable: boolean | null;
}

/**
 * Forgejo's boolean `mergeable`: `true` is mergeable; `false` is unknown on the first read, and
 * conflicting only when a second read of the same head is still false on a non-draft PR (§5.5).
 */
export function toMergeable(raw: ForgejoPull, previous?: PreviousMergeable): Mergeable {
  if (raw.merged || raw.merged_at) return "mergeable";
  if (raw.draft) return "unknown";
  if (raw.mergeable === true) return "mergeable";
  if (raw.mergeable === false && previous) {
    if (previous.headSha === raw.head.sha && previous.mergeable === false) return "conflicting";
  }
  return "unknown";
}

function baseMergeable(raw: ForgejoPull): Mergeable {
  return raw.mergeable === true && !raw.draft ? "mergeable" : "unknown";
}

function requestedReviewers(raw: ForgejoPull): string[] {
  const users = (raw.requested_reviewers ?? []).map((user) => user.login);
  // Forgejo has no combined slug; build `org/team` from the team's organization when it says.
  const teams = (raw.requested_reviewers_teams ?? []).map((team) => {
    const organization =
      typeof team.organization === "string" ? team.organization : team.organization?.name;
    return organization ? `${organization}/${team.name}` : team.name;
  });
  return [...new Set([...users, ...teams].filter(Boolean))].sort();
}

/** Map a review; `official` and `stale` are Forgejo's trust signals (§5.6). */
export function toForgeReview(raw: ForgejoReview): ForgeReview {
  return GithubReview.parse({
    id: String(raw.id),
    author: raw.user?.login ?? null,
    state: raw.dismissed ? "dismissed" : reviewState(raw.state),
    body: raw.body ?? "",
    submittedAt: raw.submitted_at ?? null,
    url: raw.html_url ?? null,
    ...(raw.official === undefined ? {} : { official: raw.official }),
    ...(raw.stale === undefined ? {} : { stale: raw.stale }),
  });
}

function reviewState(state: string): ForgeReview["state"] {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "REQUEST_CHANGES":
      return "changes_requested";
    case "COMMENT":
      return "commented";
    case "PENDING":
    case "REQUEST_REVIEW":
      return "pending";
    case "DISMISSED":
      return "dismissed";
    default:
      // An unknown state must never read as an approval.
      return "commented";
  }
}

// The git, checks and permission mappers live in `map-git.ts`; re-exported here so callers that
// know one mapping module do not have to know how it is split.
export {
  permissionForLogin,
  permissionFromFlags,
  toForgeChecksSummary,
  toForgeCommit,
  toForgeCompare,
  toForgeFileCommit,
  toForgePrRef,
  toForgeRepoInfo,
} from "./map-git";

/** One per-file patch from a whole-PR diff. */
export type { ForgePrDiffFile };
