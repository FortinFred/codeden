import { z } from "zod";
import type {
  ForgeChecksSummary,
  ForgeConnection,
  ForgeIssue,
  ForgePr,
  ForgeReview,
  GithubIssueDetails,
  GithubPrDetails,
  GithubPrDiff,
  GithubPrFile,
} from "./github";

/**
 * The forge seam (`docs/forges.md` §4): repository coordinates, capabilities, the request
 * shapes a forge accepts, and the type-only `Forge` interface. GitHub stays a separate project
 * kind until phase A1; these contracts let one port describe both forges without branching on a
 * provider id.
 */

// ---------------------------------------------------------------- coordinates

/** A forge CodeDen can talk to. The enum leaves room for more; v1 supports GitHub and Forgejo. */
export const ForgeProvider = z.enum(["github", "forgejo"]);
export type ForgeProvider = z.infer<typeof ForgeProvider>;

/**
 * Where a project lives on a forge. `baseUrl` is the web base (no credentials, query or trailing
 * slash); the adapter derives its API base from it (`https://api.github.com` for GitHub,
 * `<baseUrl>/api/v1` for Forgejo). A local or private address is allowed because the user
 * configured it.
 */
export const ForgeRepo = z.object({
  provider: ForgeProvider,
  /** The forge's web base, e.g. `https://github.com` or `http://localhost:3000`. */
  baseUrl: z.url(),
  /** The host a git remote uses when it differs from the web base (an SSH host or alias). */
  host: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** `origin` as detected, credentials removed. */
  remoteUrl: z.string().min(1),
  defaultBranch: z.string().min(1),
});
export type ForgeRepo = z.infer<typeof ForgeRepo>;

/** What a forge can do. UI and orchestration read these flags, never the provider id. */
export const ForgeCapabilities = z.object({
  issues: z.boolean(),
  pullRequests: z.boolean(),
  labels: z.boolean(),
  reviews: z.boolean(),
  /** A live collaborator-permission lookup is usable with the token. */
  permissionLookup: z.boolean(),
  /** Check runs; false on Forgejo, which reports commit statuses only. */
  checkRuns: z.boolean(),
  /** A detailed merge state (`clean`, `behind`, `blocked`, …); false on Forgejo. */
  mergeState: z.boolean(),
  /** Creating draft pull requests; false on Forgejo. */
  draftPrs: z.boolean(),
  /** Recording why a closed issue was closed; false on Forgejo. */
  issueStateReason: z.boolean(),
  /** How a PR's branch can be brought up to date: pinned to the reviewed head, or not. */
  updateBranch: z.enum(["pinned", "unpinned", "none"]),
  /** Reading Actions: its API, commit statuses only, or nothing. */
  actions: z.enum(["api", "statuses-only", "none"]),
  /** How evidence is attached: a dedicated branch, or issue/PR attachments. */
  evidence: z.enum(["branch", "attachments"]),
  /** A revert can be created through the API (a tree/commit/ref); false on Forgejo. */
  revertApi: z.boolean(),
  /** Listings answer conditional requests (ETags); false on Forgejo. */
  conditionalRequests: z.boolean(),
});
export type ForgeCapabilities = z.infer<typeof ForgeCapabilities>;

/** What a login may do in a repository. `unknown` is not write access and must fail closed. */
export const ForgePermission = z.enum(["owner", "write", "read", "none", "unknown"]);
export type ForgePermission = z.infer<typeof ForgePermission>;

// ---------------------------------------------------------------- errors

/**
 * The machine-readable codes of `ForgeError` (the class lives in `apps/server`, next to
 * `ServiceError`). Each adapter maps its forge's HTTP statuses onto these; callers use
 * `refused(error)` rather than inspecting a provider message.
 */
export const ForgeErrorCode = z.enum([
  "forge_not_connected",
  "forge_not_found",
  "forge_forbidden",
  "forge_conflict",
  "forge_validation",
  "forge_not_allowed",
  "forge_rate_limited",
  "forge_unavailable",
]);
export type ForgeErrorCode = z.infer<typeof ForgeErrorCode>;

// ---------------------------------------------------------------- issues

/** Which issues to list, and how many at most. Forgejo caps a page at 50; the client paginates. */
export const ForgeIssueQuery = z.object({
  state: z.enum(["open", "closed", "all"]).default("open"),
  /** Label names to require (all of them). */
  labels: z.array(z.string().min(1)).default([]),
  /** Maximum issues to return across pages. */
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ForgeIssueQuery = z.infer<typeof ForgeIssueQuery>;

/** Create an issue. Labels are names; the Forgejo client resolves them to IDs first. */
export const CreateForgeIssue = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65_000).default(""),
  labels: z.array(z.string().min(1)).max(20).default([]),
});
export type CreateForgeIssue = z.infer<typeof CreateForgeIssue>;

// ---------------------------------------------------------------- pull requests

/** Which pull requests to list, and how many at most. */
export const ForgePullQuery = z.object({
  state: z.enum(["open", "closed", "all"]).default("open"),
  /** Maximum pull requests to return across pages. */
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ForgePullQuery = z.infer<typeof ForgePullQuery>;

/**
 * Open a pull request between two branches of the same repository. `draft` is carried so a
 * capability-aware adapter can refuse it explicitly on a forge that has no draft creation.
 */
export const CreateForgePull = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65_000).default(""),
  head: z.string().min(1).max(256),
  base: z.string().min(1).max(256),
  draft: z.boolean().default(false),
});
export type CreateForgePull = z.infer<typeof CreateForgePull>;

/** Edit a pull request's title, body, state or base branch. */
export const UpdateForgePull = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65_000).optional(),
  state: z.enum(["open", "closed"]).optional(),
  base: z.string().min(1).max(256).optional(),
});
export type UpdateForgePull = z.infer<typeof UpdateForgePull>;

/** Merge a pull request, optionally pinned to the head that was reviewed. */
export const MergeForgePull = z.object({
  method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  /** Only merge when the head is still this commit. */
  headSha: z.string().min(1).optional(),
  title: z.string().max(256).optional(),
  message: z.string().max(65_000).optional(),
});
export type MergeForgePull = z.infer<typeof MergeForgePull>;

/** Open or update a pull request; both answer with its number and URL. */
export const ForgePrRef = z.object({
  number: z.int().positive(),
  url: z.url(),
});
export type ForgePrRef = z.infer<typeof ForgePrRef>;

// ---------------------------------------------------------------- reviews

/**
 * Submit a review. The event uses CodeDen's spelling; the adapter maps it to the forge's own
 * review-state values (`APPROVED`, `REQUEST_CHANGES`, `COMMENT`, `PENDING`).
 */
export const SubmitForgeReview = z.object({
  event: z.enum(["approved", "changes_requested", "commented", "pending"]),
  body: z.string().max(65_000).default(""),
  /** Pin the review to the head that was reviewed. */
  commitId: z.string().min(1),
});
export type SubmitForgeReview = z.infer<typeof SubmitForgeReview>;

// ---------------------------------------------------------------- contents and attachments

/** One file to upload as an issue or pull-request attachment. */
export const ForgeAttachment = z.object({
  name: z.string().min(1).max(255),
  /** The file contents, base64-encoded (contracts cross a JSON boundary). */
  bytes: z.string().min(1),
  caption: z.string().max(2_000).optional(),
});
export type ForgeAttachment = z.infer<typeof ForgeAttachment>;

/** An attachment the forge stored: the URL is what an evidence comment embeds. */
export const ForgeUploadedAttachment = z.object({
  name: z.string().min(1),
  url: z.url(),
  caption: z.string().max(2_000).optional(),
});
export type ForgeUploadedAttachment = z.infer<typeof ForgeUploadedAttachment>;

/** Commit one file through a forge's contents API (Forgejo has no Git Data write API). */
export const ForgePutFile = z.object({
  /** Repository-relative path, with forward slashes. */
  path: z.string().min(1),
  /** The file contents, base64-encoded. */
  contents: z.string(),
  /** The branch to commit on. */
  branch: z.string().min(1).max(256),
  /** Create this branch from the default branch instead of committing on `branch`. */
  newBranch: z.string().min(1).max(256).optional(),
  message: z.string().min(1).max(65_000),
  /** The current blob SHA, required to update an existing file. */
  sha: z.string().min(1).optional(),
});
export type ForgePutFile = z.infer<typeof ForgePutFile>;

/** The commit a contents write created. */
export const ForgeFileCommit = z.object({
  path: z.string().min(1),
  /** The file's blob SHA after the write. */
  sha: z.string().min(1),
  /** The commit SHA. */
  commitSha: z.string().min(1),
  /** The forge page for the file, when the response has one. */
  url: z.url().nullable(),
});
export type ForgeFileCommit = z.infer<typeof ForgeFileCommit>;

// ---------------------------------------------------------------- repository and git reads

/** Metadata about a repository, including what its units allow and the token's own permission. */
export const ForgeRepoInfo = z.object({
  defaultBranch: z.string().min(1),
  hasIssues: z.boolean(),
  hasPullRequests: z.boolean(),
  hasActions: z.boolean(),
  /** The repository uses an external issue tracker; the issue side is off. */
  externalTracker: z.boolean(),
  allowSquashMerge: z.boolean(),
  /** What the account the token belongs to may do here. */
  permission: ForgePermission,
});
export type ForgeRepoInfo = z.infer<typeof ForgeRepoInfo>;

/**
 * How far a branch is behind another and what changed. `complete` is false when the forge
 * capped its file list, so a caller never mistakes a partial list for the whole change.
 */
export const ForgeCompare = z.object({
  /** Commits the compared branch has that the other doesn't. */
  behind: z.int().nonnegative(),
  /** Changed paths (the old path of a rename is included too). */
  files: z.array(z.string()),
  complete: z.boolean(),
});
export type ForgeCompare = z.infer<typeof ForgeCompare>;

/** A commit's identity, message, tree and parents, for the revert tree comparison. */
export const ForgeCommit = z.object({
  sha: z.string().min(1),
  message: z.string(),
  treeSha: z.string().min(1),
  /** Parent commit SHAs, in order. */
  parents: z.array(z.string().min(1)),
});
export type ForgeCommit = z.infer<typeof ForgeCommit>;

// ---------------------------------------------------------------- entity aliases

/**
 * Provider-neutral names for the entity details a forge returns. These are aliases of the
 * existing GitHub shapes (`docs/forges.md` §4.1): no persisted payload changes. The five
 * aliases the design names explicitly live in `github.ts`, next to the types they alias.
 */
export type {
  GithubIssueComment as ForgeIssueComment,
  GithubIssueDetails as ForgeIssueDetails,
  GithubPrDetails as ForgePrDetails,
  GithubPrDiff as ForgePrDiff,
  GithubPrDiffFile as ForgePrDiffFile,
  GithubPrFile as ForgePrFile,
} from "./github";

// ---------------------------------------------------------------- the port

/**
 * The forge port (`docs/forges.md` §4.2): one interface both adapters implement. It is
 * deliberately close to the calls CodeDen makes today, so the GitHub adapter can delegate.
 * Callers read `capabilities` instead of the provider id, and an adapter throws
 * `forge_not_allowed` for an operation its forge cannot do.
 */
export interface Forge {
  readonly repo: ForgeRepo;
  readonly capabilities: ForgeCapabilities;

  // Identity and repository
  connection(): Promise<ForgeConnection>;
  repoInfo(): Promise<ForgeRepoInfo>;
  viewerLogin(): Promise<string | null>;
  permission(login: string): Promise<ForgePermission>;

  // Issues
  listIssues(query: ForgeIssueQuery): Promise<ForgeIssue[]>;
  getIssue(number: number): Promise<GithubIssueDetails>;
  createIssue(req: CreateForgeIssue): Promise<ForgeIssue>;
  comment(number: number, body: string): Promise<{ id: string; url: string }>;
  labels(number: number, change: { add: string[]; remove: string[] }): Promise<ForgeIssue>;
  closeIssue(number: number, reason: "completed" | "not_planned"): Promise<ForgeIssue>;

  // Pull requests
  listPulls(query: ForgePullQuery): Promise<ForgePr[]>;
  getPull(number: number): Promise<GithubPrDetails>;
  pullFiles(number: number): Promise<GithubPrFile[]>;
  pullDiff(number: number): Promise<GithubPrDiff>;
  createPull(req: CreateForgePull): Promise<ForgePrRef>;
  updatePull(number: number, req: UpdateForgePull): Promise<ForgePrRef>;
  mergePull(number: number, req: MergeForgePull): Promise<{ merged: boolean; sha: string | null }>;
  updateBranch(number: number, req: { expectedHeadSha: string }): Promise<void>;
  closePull(number: number, comment: string): Promise<void>;

  // Reviews
  listReviews(number: number): Promise<ForgeReview[]>;
  submitReview(number: number, req: SubmitForgeReview): Promise<ForgeReview>;

  // Commits and comparison
  commitStatuses(sha: string): Promise<ForgeChecksSummary>;
  branchHead(branch: string): Promise<string>;
  branchHeadAt(branch: string, at: string): Promise<string | null>;
  compare(base: string, head: string): Promise<ForgeCompare>;
  commit(sha: string): Promise<ForgeCommit>;

  // Contents and evidence
  putFile(req: ForgePutFile): Promise<ForgeFileCommit>;
  attachFiles(number: number, files: ForgeAttachment[]): Promise<ForgeUploadedAttachment[]>;

  /** Whether a new head can be expected to get CI. Null when unknown; never a guess. */
  ciAvailable(): Promise<boolean | null>;
}
