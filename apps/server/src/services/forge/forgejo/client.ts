import type {
  CreateForgeIssue,
  CreateForgePull,
  ForgeAttachment,
  ForgeCapabilities,
  ForgeChecksSummary,
  ForgeCommit,
  ForgeCompare,
  ForgeFileCommit,
  ForgeIssue,
  ForgeIssueComment,
  ForgeIssueDetails,
  ForgeIssueQuery,
  ForgePermission,
  ForgePr,
  ForgePrDetails,
  ForgePrDiff,
  ForgePrFile,
  ForgePrRef,
  ForgePullQuery,
  ForgePutFile,
  ForgeRepoInfo,
  ForgeReview,
  ForgeUploadedAttachment,
  MergeForgePull,
  SubmitForgeReview,
  UpdateForgePull,
} from "@codeden/contracts";
import { attachFiles, ciAvailable, type ForgejoFile, putFile, readFile } from "./contents";
import type { ForgejoContext } from "./context";
import { branchHead, branchHeadAt, commit, commitStatuses, compare, deleteBranch } from "./git";
import { ForgejoHttp, type ForgejoHttpOptions } from "./http";
import { permission, repoInfo, version, viewerLogin } from "./identity";
import {
  addLabels,
  closeIssue,
  comment,
  comments,
  createIssue,
  type ForgejoIssueListQuery,
  getIssue,
  issueDetails,
  listIssueRows,
  listIssues,
  removeLabels,
  replaceLabels,
  repoLabels,
  updateLabels,
} from "./issues";
import {
  closePull,
  createPull,
  getPull,
  listPulls,
  listReviews,
  mergePull,
  prSnapshot,
  pullCommits,
  pullDiff,
  pullFiles,
  submitReview,
  updateBranch,
  updatePull,
} from "./pulls";
import type { ForgejoIssue, ForgejoLabel } from "./types";

/** What a Forgejo adapter will advertise once it implements the port (`docs/forges.md` §4.1). */
export const FORGEJO_CAPABILITIES = {
  issues: true,
  pullRequests: true,
  labels: true,
  reviews: true,
  permissionLookup: true,
  checkRuns: false,
  mergeState: false,
  draftPrs: false,
  issueStateReason: false,
  updateBranch: "unpinned",
  actions: "statuses-only",
  evidence: "attachments",
  revertApi: false,
  conditionalRequests: false,
} as const satisfies ForgeCapabilities;

export interface ForgejoClientOptions extends ForgejoHttpOptions {
  owner: string;
  repo: string;
  /** The project id used to shape projection rows; the adapter passes the real one. */
  projectId?: string;
  /** Where "dropped unknown label" messages go. Never passed a token. */
  log?: (message: string) => void;
}

/**
 * A client for the Forgejo REST API v1 (`docs/forges.md` §5). It joins the configured web base
 * with `/api/v1`, sends `Authorization: token <token>`, paginates the endpoints capped at 50
 * rows, and maps Forgejo JSON onto the forge contracts. Pull request reads and writes, attachments
 * and the Contents API are wired, and there is no Actions-run internals access.
 *
 * The work is split by concern: identity, issues, pull requests, git reads and contents. This
 * facade keeps one object to hand to an adapter.
 */
export class ForgejoClient {
  readonly http: ForgejoHttp;
  readonly projectId: string;
  /** The repository coordinates, for links that the API response does not carry. */
  readonly owner: string;
  readonly repo: string;
  private readonly context: ForgejoContext;

  constructor(options: ForgejoClientOptions) {
    const http = new ForgejoHttp(options);
    this.http = http;
    this.projectId = options.projectId ?? `${options.owner}/${options.repo}`;
    this.owner = options.owner;
    this.repo = options.repo;
    this.context = {
      http,
      projectId: this.projectId,
      owner: options.owner,
      repo: options.repo,
      log: options.log,
      mergeableReads: new Map(),
      requiredApprovals: new Map(),
    };
  }

  // -------------------------------------------------------------- identity and repository

  /** The instance's version, refusing anything older than Forgejo 15.0. */
  version(): Promise<string> {
    return version(this.context);
  }

  /** The token account's login; null when a specific-repository token cannot read `/user`. */
  viewerLogin(): Promise<string | null> {
    return viewerLogin(this.context);
  }

  /** `viewer` in the endpoint table: the same `GET /user` login as `viewerLogin`. */
  viewer(): Promise<string | null> {
    return viewerLogin(this.context);
  }

  /** Repository metadata, including the token's own permission. */
  repoInfo(): Promise<ForgeRepoInfo> {
    return repoInfo(this.context);
  }

  /** A login's live collaborator permission (404 none, 403/server errors unknown). */
  permission(login: string): Promise<ForgePermission> {
    return permission(this.context, login);
  }

  // -------------------------------------------------------------- issues

  /** List issues (pull requests excluded), across pages. */
  listIssues(query?: ForgeIssueQuery): Promise<ForgeIssue[]> {
    return listIssues(this.context, query);
  }

  /**
   * Raw issue rows (pull request rows included), for the sync's baseline and cursor: a row with
   * `pull_request` is a PR number to refresh, the rest are issues.
   */
  listIssueRows(query: ForgejoIssueListQuery): Promise<ForgejoIssue[]> {
    return listIssueRows(this.context, query);
  }

  /** One issue by its repository index. */
  getIssue(number: number): Promise<ForgeIssue> {
    return getIssue(this.context, number);
  }

  /** An issue with its latest comments (up to 20). */
  issueDetails(number: number): Promise<ForgeIssueDetails> {
    return issueDetails(this.context, number);
  }

  /** Comments on an issue or PR conversation. */
  comments(
    number: number,
    options?: { since?: string; limit?: number },
  ): Promise<ForgeIssueComment[]> {
    return comments(this.context, number, options);
  }

  /** The repository's labels. */
  repoLabels(): Promise<ForgejoLabel[]> {
    return repoLabels(this.context);
  }

  /** Create an issue; labels are resolved from names to IDs. */
  createIssue(request: CreateForgeIssue): Promise<ForgeIssue> {
    return createIssue(this.context, request);
  }

  /** Comment on an issue or PR conversation. */
  comment(number: number, body: string): Promise<{ id: string; url: string }> {
    return comment(this.context, number, body);
  }

  /** Add labels by name, then read the issue back. */
  addLabels(number: number, labels: string[]): Promise<ForgeIssue> {
    return addLabels(this.context, number, labels);
  }

  /** Remove labels by name, then read the issue back. */
  removeLabels(number: number, labels: string[]): Promise<ForgeIssue> {
    return removeLabels(this.context, number, labels);
  }

  /** Replace every label, then read the issue back. */
  replaceLabels(number: number, labels: string[]): Promise<ForgeIssue> {
    return replaceLabels(this.context, number, labels);
  }

  /** Add and remove labels, then read the issue back. */
  updateLabels(number: number, change: { add: string[]; remove: string[] }): Promise<ForgeIssue> {
    return updateLabels(this.context, number, change);
  }

  /** Close an issue (Forgejo cannot record a reason). */
  closeIssue(number: number, reason: "completed" | "not_planned"): Promise<ForgeIssue> {
    return closeIssue(this.context, number, reason);
  }

  // -------------------------------------------------------------- pull requests

  /** List pull requests across pages. */
  listPulls(query?: ForgePullQuery): Promise<ForgePr[]> {
    return listPulls(this.context, query);
  }

  /** A PR's live details, including its files without patches. */
  getPull(number: number): Promise<ForgePrDetails> {
    return getPull(this.context, number);
  }

  /**
   * A PR's fresh projection row: checks, reviews, computed review decision, commits and the
   * settled mergeable state. What the sync refreshes and `/api/prs/:id` reads.
   */
  prSnapshot(number: number): Promise<ForgePr> {
    return prSnapshot(this.context, number);
  }

  /** A PR's changed files, without patches. */
  pullFiles(number: number): Promise<ForgePrFile[]> {
    return pullFiles(this.context, number);
  }

  /** A PR's whole diff split into per-file patches; `headSha` is null if the head moved. */
  pullDiff(number: number, expectedHeadSha?: string): Promise<ForgePrDiff> {
    return pullDiff(this.context, number, expectedHeadSha);
  }

  /** A PR's commits (up to 50). */
  pullCommits(number: number): Promise<Array<{ sha: string; message: string }>> {
    return pullCommits(this.context, number);
  }

  /** Open a PR; a draft request fails closed on Forgejo. */
  createPull(request: CreateForgePull): Promise<ForgePrRef> {
    return createPull(this.context, request);
  }

  /** Update a PR's title, body, state or base. */
  updatePull(number: number, request: UpdateForgePull): Promise<ForgePrRef> {
    return updatePull(this.context, number, request);
  }

  /** Merge a PR, optionally pinned to a head commit. */
  mergePull(
    number: number,
    request: MergeForgePull,
  ): Promise<{ merged: boolean; sha: string | null }> {
    return mergePull(this.context, number, request);
  }

  /** Update a PR branch after checking its head; the new head is the answer. */
  updateBranch(number: number, request: { expectedHeadSha: string }): Promise<string> {
    return updateBranch(this.context, number, request);
  }

  /** Comment on a PR, then close it. */
  closePull(number: number, comment: string): Promise<void> {
    return closePull(this.context, number, comment);
  }

  /** A PR's reviews. */
  listReviews(number: number): Promise<ForgeReview[]> {
    return listReviews(this.context, number);
  }

  /** Submit a review pinned to a head commit. */
  submitReview(number: number, request: SubmitForgeReview): Promise<ForgeReview> {
    return submitReview(this.context, number, request);
  }

  // -------------------------------------------------------------- commits and comparison

  /** A head's commit statuses as a checks summary. */
  commitStatuses(sha: string): Promise<ForgeChecksSummary> {
    return commitStatuses(this.context, sha);
  }

  /** A branch's head commit. */
  branchHead(branch: string): Promise<string> {
    return branchHead(this.context, branch);
  }

  /** Always null: Forgejo has no `until` filter on commits. */
  branchHeadAt(branch: string, at: string): Promise<string | null> {
    return branchHeadAt(branch, at);
  }

  /** Delete a branch, e.g. a stale vision branch before it is reset. */
  deleteBranch(branch: string): Promise<void> {
    return deleteBranch(this.context, branch);
  }

  /** Compare two refs. */
  compare(base: string, head: string): Promise<ForgeCompare> {
    return compare(this.context, base, head);
  }

  /** A commit's tree and parents. */
  commit(sha: string): Promise<ForgeCommit> {
    return commit(this.context, sha);
  }

  // -------------------------------------------------------------- contents and attachments

  /** Read one file through the contents API. */
  readFile(path: string, ref?: string): Promise<ForgejoFile> {
    return readFile(this.context, path, ref);
  }

  /** Create or update one file, optionally on a new branch. */
  putFile(request: ForgePutFile): Promise<ForgeFileCommit> {
    return putFile(this.context, request);
  }

  /** Upload attachments to an issue or PR. */
  attachFiles(number: number, files: ForgeAttachment[]): Promise<ForgeUploadedAttachment[]> {
    return attachFiles(this.context, number, files);
  }

  /** Whether a new head can be expected to get CI; null when unknown. */
  ciAvailable(): Promise<boolean | null> {
    return ciAvailable(this.context);
  }
}

export type { ForgejoFile };
