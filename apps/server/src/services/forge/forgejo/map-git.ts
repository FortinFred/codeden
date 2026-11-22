import type {
  ForgeChecksSummary,
  ForgeCommit,
  ForgeCompare,
  ForgeFileCommit,
  ForgePermission,
  ForgePrRef,
  ForgeRepoInfo,
} from "@codeden/contracts";
import { GithubChecksSummary } from "@codeden/contracts";
import type {
  ForgejoCombinedStatus,
  ForgejoCommitStatus,
  ForgejoCompare,
  ForgejoContents,
  ForgejoGitCommit,
  ForgejoPermissionFlags,
  ForgejoPull,
  ForgejoRepository,
} from "./types";

/**
 * Checks, comparisons, commits, repository metadata and permission flags
 * (`docs/forges.md` §5.3, §5.5, §5.7, §5.8). Pure, so the precedence and permission rules are
 * tested without an HTTP server.
 */

/**
 * Commit statuses into the checks shape (`docs/forges.md` §5.7). Statuses are deduplicated by
 * context (newest wins). `error`, `failure` and `warning` all make the summary a failure:
 * `warning` is never green, because a non-success state must not gate a merge as passing.
 */
export function toForgeChecksSummary(raw: ForgejoCombinedStatus): ForgeChecksSummary {
  const newest = new Map<string, ForgejoCommitStatus>();
  for (const status of raw.statuses ?? []) {
    const context = status.context || "status";
    const seen = newest.get(context);
    if (!seen || newestFirst(status, seen)) newest.set(context, status);
  }

  const checks: ForgeChecksSummary["checks"] = [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  let worst: "success" | "pending" | "failure" = "success";
  for (const status of newest.values()) {
    const state = statusState(status.status);
    if (state === "failure") failed++;
    else if (state === "pending") pending++;
    else passed++;
    if (state === "failure" || (state === "pending" && worst !== "failure")) worst = state;
    const done = state !== "pending";
    checks.push({
      name: status.context || "status",
      status: done ? "completed" : "pending",
      conclusion: done ? status.status.toLowerCase() : null,
      url: status.target_url ?? null,
    });
  }

  const combined = combinedState(raw.state);
  let state: ForgeChecksSummary["state"];
  if (combined === "failure" || worst === "failure") state = "failure";
  else if (combined === "pending" || worst === "pending") state = "pending";
  else if (checks.length > 0 || combined === "success") state = "success";
  else state = "none";

  return GithubChecksSummary.parse({
    state,
    total: checks.length,
    passed,
    failed,
    pending,
    checks,
  });
}

function newestFirst(a: ForgejoCommitStatus, b: ForgejoCommitStatus): boolean {
  return (
    Date.parse(a.created_at ?? a.updated_at ?? "") >= Date.parse(b.created_at ?? b.updated_at ?? "")
  );
}

function statusState(status: string): "success" | "pending" | "failure" {
  switch (status.toLowerCase()) {
    case "error":
    case "failure":
    case "warning":
      return "failure";
    case "success":
    case "skipped":
      return "success";
    default:
      return "pending";
  }
}

function combinedState(state: string | undefined): "success" | "pending" | "failure" | "none" {
  switch ((state ?? "").toLowerCase()) {
    case "error":
    case "failure":
    case "warning":
      return "failure";
    case "pending":
      return "pending";
    case "success":
    case "skipped":
      return "success";
    default:
      return "none";
  }
}

/** The changed files of a comparison; `complete` is false once Forgejo's 300-file cap is hit. */
export function toForgeCompare(raw: ForgejoCompare): ForgeCompare {
  const listed = raw.files ?? [];
  const files = new Set<string>();
  for (const file of listed) {
    files.add(file.filename);
    if (file.previous_filename) files.add(file.previous_filename);
  }
  return {
    behind: raw.total_commits ?? 0,
    files: [...files],
    complete: listed.length < 300,
  };
}

/** A git commit's tree and parents, enough to prove an exact revert without a Git Data API. */
export function toForgeCommit(raw: ForgejoGitCommit): ForgeCommit {
  return {
    sha: raw.sha,
    message: raw.message ?? "",
    treeSha: raw.tree?.sha ?? raw.sha,
    parents: (raw.parents ?? []).map((parent) => parent.sha),
  };
}

/** Repository metadata and the token's own permission. */
export function toForgeRepoInfo(raw: ForgejoRepository): ForgeRepoInfo {
  return {
    defaultBranch: raw.default_branch,
    hasIssues: raw.has_issues !== false,
    hasPullRequests: raw.has_pull_requests !== false,
    hasActions: raw.has_actions === true,
    externalTracker: Boolean(raw.external_tracker),
    allowSquashMerge: raw.allow_squash_merge !== false,
    permission: permissionFromFlags(raw.permissions),
  };
}

/** The token account's own permission from a repository's `permissions` flags. */
export function permissionFromFlags(flags: ForgejoPermissionFlags | undefined): ForgePermission {
  if (!flags) return "unknown";
  if (flags.admin) return "owner";
  if (flags.push) return "write";
  if (flags.pull) return "read";
  const role = flags.permission?.toLowerCase();
  if (role === "owner" || role === "admin") return "write";
  if (role === "write" || role === "push") return "write";
  if (role === "read" || role === "pull") return "read";
  if (role === "none") return "none";
  return role ? "unknown" : "none";
}

/**
 * A login's permission: the owner's own login is `owner`, and `admin`/`push` are both write
 * access (§5.3). 403 and server errors are `unknown` at the call site, never `none`.
 */
export function permissionForLogin(
  login: string,
  owner: string,
  flags: ForgejoPermissionFlags,
): ForgePermission {
  if (login.toLowerCase() === owner.toLowerCase()) return "owner";
  if (flags.admin || flags.push) return "write";
  if (flags.pull) return "read";
  const role = flags.permission?.toLowerCase();
  if (role === "owner") return "owner";
  if (role === "admin" || role === "write" || role === "push") return "write";
  if (role === "read" || role === "pull") return "read";
  if (role === "none") return "none";
  return "unknown";
}

/** The number and URL a create/update PR call answered with. */
export function toForgePrRef(raw: ForgejoPull): ForgePrRef {
  return { number: raw.number, url: raw.html_url };
}

/** The commit a contents write answered with. */
export function toForgeFileCommit(
  raw: ForgejoContents | undefined,
  commit: { sha?: string } | undefined,
  fallbackPath: string,
): ForgeFileCommit {
  const path = raw?.path ?? fallbackPath;
  const commitSha = commit?.sha ?? "";
  return {
    path,
    sha: raw?.sha ?? commitSha,
    commitSha,
    url: raw?.html_url ?? null,
  };
}
