/**
 * The Forgejo API v1 shapes this client reads (`docs/forges.md` §5). They are deliberately
 * narrow and tolerant: only fields CodeDen uses, optional wherever a Forgejo release might omit
 * one, so a schema addition never breaks a sync.
 */

export interface ForgejoUser {
  login: string;
  full_name?: string;
  email?: string;
}

export interface ForgejoLabel {
  id: number;
  name: string;
  color?: string;
  description?: string;
}

export interface ForgejoTeam {
  id?: number;
  name: string;
  organization?: { name?: string } | string;
}

/** One row of `GET /issues`; a row with `pull_request` is a pull request, not an issue. */
export interface ForgejoIssue {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  labels?: ForgejoLabel[];
  user?: ForgejoUser | null;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  /** Present on a pull request's issue row; its shape is not read here. */
  pull_request?: unknown;
}

export interface ForgejoComment {
  id: number;
  body?: string | null;
  html_url?: string;
  user?: ForgejoUser | null;
  created_at?: string;
  updated_at?: string;
}

export interface ForgejoPullRef {
  label?: string;
  ref: string;
  sha: string;
  repo_id?: number;
}

export interface ForgejoPull {
  id?: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft?: boolean;
  html_url: string;
  user?: ForgejoUser | null;
  head: ForgejoPullRef;
  base: ForgejoPullRef;
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  /** Forgejo's only mergeability signal; false is not proof of a conflict on the first read. */
  mergeable?: boolean | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  requested_reviewers?: ForgejoUser[];
  requested_reviewers_teams?: ForgejoTeam[];
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

export interface ForgejoPullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

/** One row of `GET /pulls/{index}/commits`: a git commit with its metadata under `commit`. */
export interface ForgejoPullCommit {
  sha: string;
  commit: { message?: string };
}

export interface ForgejoReview {
  id: number;
  user?: ForgejoUser | null;
  state: string;
  body?: string | null;
  commit_id?: string | null;
  submitted_at?: string | null;
  html_url?: string | null;
  official?: boolean;
  stale?: boolean;
  dismissed?: boolean;
  comments_count?: number;
}

export interface ForgejoCommitStatus {
  id?: number;
  status: string;
  context: string;
  target_url?: string | null;
  description?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ForgejoCombinedStatus {
  state?: string;
  sha?: string;
  total_count?: number;
  statuses?: ForgejoCommitStatus[];
}

export interface ForgejoBranch {
  name: string;
  commit: { id: string };
}

export interface ForgejoCompare {
  total_commits?: number;
  files?: ForgejoPullFile[];
}

export interface ForgejoGitCommit {
  sha: string;
  message?: string;
  tree?: { sha?: string };
  parents?: Array<{ sha: string }>;
}

export interface ForgejoContents {
  name: string;
  path: string;
  sha: string;
  size?: number;
  content?: string | null;
  encoding?: string | null;
  html_url?: string | null;
  download_url?: string | null;
}

export interface ForgejoRepository {
  name?: string;
  full_name?: string;
  default_branch: string;
  has_issues?: boolean;
  has_pull_requests?: boolean;
  has_actions?: boolean;
  external_tracker?: unknown;
  allow_squash_merge?: boolean;
  permissions?: ForgejoPermissionFlags;
  owner?: ForgejoUser;
}

/** The collaborator permission endpoint answers with these booleans. */
export interface ForgejoPermissionFlags {
  admin?: boolean;
  push?: boolean;
  pull?: boolean;
  /** Some Forgejo releases also answer with the resolved role. */
  permission?: string;
}

export interface ForgejoAttachment {
  id?: number;
  name?: string;
  browser_download_url?: string;
  download_url?: string;
  html_url?: string;
}

export interface ForgejoVersion {
  version: string;
}
