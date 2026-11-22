# Forges: self-hosted Forgejo as a work source

> Status: **proposed 2026-11-22**. Design only: no source, schema or UI changes are included.
> Once approved this is part of the design (`docs/DESIGN.md` §3, §9, §10.1); the exact wording is
> proposed in §11 and is not applied in this pull request.

CodeDen is GitHub-only by a locked decision (§3, §9, §10.1). This document designs a second
forge: a self-hosted **Forgejo** instance, reached through its Gitea-compatible REST API v1, so a
project whose `origin` is a local Forgejo repository gets issues and pull requests as
first-class work sources. The same PM triage, issue → session → pull request, review, merge,
evidence and factory workflows should work there.

GitHub stays supported and stays the default. This is an additive design, not a replacement.
The parts of CodeDen that depend on GitHub's GraphQL API, `gh`, check runs, `author_association`
and Git Data write API are named below, with a concrete substitute or a deliberate degradation.

## 1. Decisions at a glance

| # | Question | Decision | Why, in one line |
|---|---|---|---|
| 1 | Where the forge seam goes | A `Forge` port in `apps/server` with `GitHub` and `Forgejo` adapters; `ForgeRepo` in contracts | The factory already has a port (`FactoryGithub`); this widens it instead of adding a second special case |
| 2 | Project shape | Add `kind: "forge"` with `forge: ForgeRepo { provider, baseUrl, host, owner, repo, remoteUrl, defaultBranch }`; keep `kind: "github"` as it is | No existing project or event changes meaning; shared code maps GitHub through `forgeOf(project)` |
| 3 | GitHub | Untouched in phase 1; it becomes one adapter of the same port later | A second forge must not destabilise the locked GitHub flow |
| 4 | Detection | A remote connects to Forgejo only when it matches a configured connection (exact web origin, or an explicitly configured SSH host) | Guessing a forge from a hostname would connect a project to the wrong server |
| 5 | Auth | A token the user pastes into Settings, kept in the OS keychain as `forgejo.token`; no `gh`, no environment variable, no `tea` | Forgejo has no `gh`; the token must never be in the project, events, logs or agent environment |
| 6 | Trust | `GET /user` for the account CodeDen uses; live collaborator permission (`push`/`admin`) for authors and commenters; the review's `official` flag as a fallback | These are Forgejo's equivalents of `viewer`, `authorAssociation`, and "a review that counts" |
| 7 | Sync | Polling with an `updated` cursor; no conditional requests or GraphQL batching | Forgejo's API listings expose neither conditional requests nor GraphQL; a self-hosted instance makes the extra requests cheap |
| 8 | CI | Read commit statuses, never Actions internals; Actions is one possible producer | Forgejo Actions posts statuses, and so can any other CI |
| 9 | Merge | `POST /pulls/{n}/merge` with `Do: "squash"` and `head_commit_id` | Head pinning does exist, so the merge queue keeps its central guarantee |
| 10 | Mergeability | `mergeable` is a boolean; map `true` to mergeable and a settled `false` to conflicting; `mergeState` stays `unknown` | Forgejo has no `mergeable_state`; never infer a merge from `false` |
| 11 | Review decision | Computed from official, non-stale, non-dismissed reviews and branch protection | Forgejo has no `reviewDecision` field |
| 12 | Evidence | Attachments via `POST /issues/{n}/assets`, with a normal branch fallback | There is no Git Data write API, so there is no orphan evidence branch |
| 13 | Vision | One file committed through the Contents API, then a normal pull request | Same reason; the Contents API can create a branch and a commit |
| 14 | Automatic revert | The factory's existing fallback: an agent writes the revert | Forgejo cannot create a tree/commit/ref through its API |
| 15 | Factory | The same loop over a forge-neutral port, behind capability gates | The merge checks, review trust and merge queue must not have a second implementation |
| 16 | Webhooks | Polling in every phase; webhooks are a later, opt-in transport | A local CodeDen has no reachable URL, and the 127.0.0.1 rule stays |
| 17 | Changelog | One fragment per user-facing phase; none for this docs-only change | `changes/README.md` |

## 2. Baseline (decided, not re-litigated)

- **Target forge:** Forgejo, self-hosted, through the Gitea-compatible REST API v1, with token
  authentication. The base URL is user-configured and may be a local or private address, for
  example `http://localhost:3000`.
- **GitHub stays supported.** This adds a second forge rather than replacing GitHub.
- **Design only.** No source changes, no migrations and no UI in this pull request. The design is
  written so each phase below can be a small, independently reviewable pull request.
- **`docs/DESIGN.md` is not edited here.** The exact wording changes that would make this
  design part of the locked design are listed in §11 for the owner to approve.

Out of scope for this design: GitLab, Bitbucket, GitHub Enterprise Server, Gitea instances that
are not Forgejo (the API is compatible, but they are not a supported target), multiple Forgejo
instances at once, mirror repositories, federation, packages, wikis, and Forgejo's project
boards. The provider field leaves room for them; nothing here promises them.

## 3. Today: where GitHub is assumed

The GitHub flow is not one module. It is a set of contracts, projections, services and UI that
name GitHub directly. The port has to reach all of these places; the table is the checklist.

| Area | Today | What the port needs |
|---|---|---|
| Project identity | `Project` is `{ kind: "github", github }` or `{ kind: "local" }` (`packages/contracts/src/entities/project.ts`) | A third member for Forgejo, and a helper that returns a `ForgeRepo` for both |
| Remote detection | `parseGitHubRemote` accepts only `github.com`; `detectProject` sets `ProjectDetection.github` (`apps/server/src/services/projects/detect.ts`) | A configured-forge matcher next to it; GitHub detection stays |
| Re-detection | `reconcileProject` knows `local → github`, "another GitHub repo", and `github_remote_missing` (`reconcile.ts`) | The same transitions for a forge, including `forge_remote_missing`; never switch forge silently |
| Connection status | `GithubConnection` has `connected`, `source`, `login`, `message` | `provider` and `host`, so the UI and the API say which forge |
| Issue and PR sync | `GithubSync` polls with ETags and batched GraphQL (`services/github/sync.ts`) | A Forgejo sync using `since` and pagination, sharing `diffIssue` / `diffPr` |
| Issue/PR writes | `issues.ts`, `pull-requests.ts`, `evidence.ts` call Octokit | Forge methods with the same behaviour and the same event projection |
| Factory | `FactoryGithub` (`services/factory/github-port.ts`) is the loop's only view of GitHub | `FactoryForge` over the port, with the same methods and capability gates |
| Trust | `authorAssociation`, GraphQL `viewer`, `review-trust.ts`, `comment-trust.ts` | Forgejo permissions and `/user`; fail closed |
| Sync of reviews | `review.submitted` carries the `viewer` read in the same GraphQL request | In Forgejo, read `/user` in the same sync pass and stamp it there |
| Git credentials | The broker scopes the token to `https://github.com` only (`services/git-broker.ts`) | A scope for the configured forge origin, including plain `http://localhost:3000` |
| Agent prompts | Some factory prompts tell reviewers to use `gh pr diff` / `gh pr checks` | Forge-neutral wording: the CodeDen tools, or plain git |
| MCP tools | GitHub tools are listed only for `kind === "github"` (`mcp/tools/github/available.ts`) | Listed for both; write tools gated by phase and capabilities |
| UI | The GitHub panel and `/api/projects/:id/github/*` routes | Reused with a provider label; routes stay for compatibility |
| Evidence | Commit to an orphan `codeden/evidence` branch through the Git Data API | Attachments, or a normal branch through the Contents API |
| Vision | A commit and ref through the Git Data API (`shareVision`) | One file through the Contents API, then a normal pull request |
| Reverts | A tree/commit/ref built through the Git Data API | The existing agent-written revert fallback |
| Re-detection warnings | `github_remote_missing` | `forge_remote_missing`, keeping `ProjectRemoteWarning` back-compatible |
| Checks | Check runs plus commit statuses, GraphQL rollup | Commit statuses only; map to the existing `GithubChecksSummary` shape |
| Issue state reason | `state_reason` (`completed`, `not_planned`, `duplicate`) | No equivalent; `null`, and the factory must not read it as completed |

Projection storage is already per project (`github_issues`, `github_prs`, `github_sync_state` keyed
by `projectId`), so a Forgejo project can use the same tables in phase 1. The `github_` names are a
naming debt, not a data-model blocker; renaming them is a later cleanup with no user value.

## 4. The port

### 4.1 Contracts

The new contract file is `packages/contracts/src/forge.ts`. It defines the coordinates, the
capabilities, the error codes and the type-only `Forge` interface; the entities themselves
(`ForgeIssue`, `ForgePr`, reviews, checks) are the existing shapes with generic aliases, so no
persisted payload changes.

```ts
export const ForgeProvider = z.enum(["github", "forgejo"]);
export type ForgeProvider = z.infer<typeof ForgeProvider>;

export const ForgeRepo = z.object({
  provider: ForgeProvider,
  /**
   * The forge's web base, with no credentials, query or trailing slash. The API base is derived
   * by the adapter (`https://api.github.com` for GitHub, `<baseUrl>/api/v1` for Forgejo).
   * A local or private address is allowed: the user configured it.
   */
  baseUrl: z.url(),
  /** The host a git remote uses, when it differs from the web base (an SSH host or alias). */
  host: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  /** `origin` as detected, credentials removed. */
  remoteUrl: z.string().min(1),
  defaultBranch: z.string().min(1),
});
export type ForgeRepo = z.infer<typeof ForgeRepo>;

/** What this forge can do; UI and orchestration read these instead of the provider id. */
export const ForgeCapabilities = z.object({
  issues: z.boolean(),
  pullRequests: z.boolean(),
  labels: z.boolean(),
  reviews: z.boolean(),
  /** `GET /collaborators/{user}/permission` is usable with this token. */
  permissionLookup: z.boolean(),
  checkRuns: z.boolean(),            // false on Forgejo: statuses only
  mergeState: z.boolean(),           // false on Forgejo: no mergeable_state
  draftPrs: z.boolean(),             // false on Forgejo
  issueStateReason: z.boolean(),     // false on Forgejo
  updateBranch: z.enum(["pinned", "unpinned", "none"]),
  actions: z.enum(["api", "statuses-only", "none"]),
  evidence: z.enum(["branch", "attachments"]),
  revertApi: z.boolean(),            // false on Forgejo
  conditionalRequests: z.boolean(),  // false on Forgejo
});
export type ForgeCapabilities = z.infer<typeof ForgeCapabilities>;
```

The error model is one `ForgeError extends ServiceError` with codes
`forge_not_connected`, `forge_not_found`, `forge_forbidden`, `forge_conflict`,
`forge_validation`, `forge_not_allowed`, `forge_rate_limited` and `forge_unavailable`.
GitHub keeps returning its `github_*` codes in phase 1 (routes and tests depend on them); the
factory's refusal predicate accepts both sets until a later cleanup. A shared `refused(error)`
predicate is what the merge queue uses; no caller inspects a provider message.

Back-compatible aliases live in `packages/contracts/src/github.ts`:

```ts
export type ForgeIssue = GithubIssue;
export type ForgePr = GithubPr;
export type ForgeReview = GithubReview;
export type ForgeChecksSummary = GithubChecksSummary;
export type ForgeConnection = GithubConnection;   // with provider and host added
```

Keeping the aliases means the event payloads (`issue.opened`, `pr.merged`, `review.submitted`, …)
and the projections do not move. A rename of the `Github*` entities is a separate mechanical
change; it would touch every payload and test for no behavioural gain.

`GithubConnection` gains:

```ts
provider: ForgeProvider | null;
host: string | null;
```

and `GithubTokenSource` stays `"gh" | "keychain"`. A Forgejo connection always reports
`"keychain"`. The API response shape stays at the existing `/api/projects/:id/github/*` paths in
phase 1, with the two new fields; a `/forge` alias can be added later.

### 4.2 The `Forge` interface

The port is deliberately close to the calls CodeDen already makes, so the GitHub adapter is a
delegation rather than a rewrite. It is grouped here for readability; the type-only interface
lives in `packages/contracts/src/forge.ts` (so the seam is a contract, not a server detail) and
is re-exported by `apps/server/src/services/forge/port.ts`.

```ts
export interface Forge {
  readonly repo: ForgeRepo;
  readonly capabilities: ForgeCapabilities;

  // Identity and repository
  connection(): Promise<ForgeConnection>;
  repoInfo(): Promise<ForgeRepoInfo>;
  viewerLogin(): Promise<string | null>;
  /** `owner`, `write`, `read`, `none`, or `unknown` when the forge could not say. */
  permission(login: string): Promise<ForgePermission>;

  // Issues
  listIssues(query: ForgeIssueQuery): Promise<ForgeIssue[]>;
  getIssue(number: number): Promise<ForgeIssueDetails>;
  createIssue(req: CreateForgeIssue): Promise<ForgeIssue>;
  comment(number: number, body: string): Promise<{ id: string; url: string }>;
  labels(number: number, change: { add: string[]; remove: string[] }): Promise<ForgeIssue>;
  /** The `reason` is a request; `capabilities.issueStateReason` says whether it is recorded. */
  closeIssue(number: number, reason: "completed" | "not_planned"): Promise<ForgeIssue>;

  // Pull requests
  listPulls(query: ForgePullQuery): Promise<ForgePr[]>;
  getPull(number: number): Promise<ForgePrDetails>;
  pullFiles(number: number): Promise<ForgePrFile[]>;
  pullDiff(number: number): Promise<ForgePrDiff>;
  createPull(req: CreateForgePull): Promise<ForgePrRef>;
  updatePull(number: number, req: UpdateForgePull): Promise<ForgePrRef>;
  mergePull(number: number, req: MergeForgePull): Promise<{ merged: boolean; sha: string | null }>;
  /** `expectedHeadSha` is checked before the call; `capabilities.updateBranch` says how. */
  updateBranch(number: number, req: { expectedHeadSha: string }): Promise<void>;
  closePull(number: number, comment: string): Promise<void>;

  // Reviews
  listReviews(number: number): Promise<ForgeReview[]>;
  submitReview(number: number, req: SubmitForgeReview): Promise<ForgeReview>;

  // Commits and comparison
  commitStatuses(sha: string): Promise<ForgeChecksSummary>;
  branchHead(branch: string): Promise<string>;
  /** The branch's head at `at`; null when the forge cannot tell. */
  branchHeadAt(branch: string, at: string): Promise<string | null>;
  compare(base: string, head: string): Promise<ForgeCompare>;
  /** Parents, tree and message, for the revert tree comparison. */
  commit(sha: string): Promise<ForgeCommit>;

  // Contents and evidence
  putFile(req: ForgePutFile): Promise<ForgeFileCommit>;
  attachFiles(number: number, files: ForgeAttachment[]): Promise<ForgeAttachment[]>;

  /** Whether a new head can be expected to get CI. Null when unknown; never a guess. */
  ciAvailable(): Promise<boolean | null>;
}
```

`ForgeRepoInfo` carries `defaultBranch`, `hasIssues`, `hasPullRequests`, `hasActions`,
`externalTracker`, `allowSquashMerge` and the token account's own `permission`.
`ForgePermission` is `"owner" | "write" | "read" | "none" | "unknown"`. `ForgeCompare` carries
`{ behind, files, complete }`, the same shape the merge queue's fast path reads today.
`ForgePullDetails` extends the projection with body, additions, deletions, changed files,
`mergeState` (always `"unknown"` on Forgejo) and the files with patches.

The request shapes are the existing contracts with generic names: `ForgeIssueQuery`
(`state`, `labels`, `limit`), `CreateForgeIssue` (the current `CreateGithubIssueRequest`),
`CreateForgePull` (`title`, `body`, `head`, `base`, `draft`), `MergeForgePull`
(`method`, `headSha`, `title`, `message`), `SubmitForgeReview` (`event`, `body`, `commitId`),
`ForgeAttachment` (`name`, `bytes`, `caption`) and `ForgePutFile` (`path`, `contents`,
`branch`, `newBranch`, `message`, `sha`).

Two rules keep the port honest:

- **No caller branches on `provider`.** Capability flags say what is possible; the adapter
  throws `forge_not_allowed` for an operation its forge cannot do.
- **Projections are read from the store, not the port.** `listIssues`, `listPrs`, `openIssues`
  and `prRef` keep reading the synced tables, exactly as they do today. The port is for fresh
  reads and writes; the sync owns the projections.

### 4.3 Where it sits

```
apps/server/src/services/forge/
  port.ts              Forge, ForgeRepoInfo, ForgeCompare, ForgeError
  registry.ts          project -> Forge (delegates to GitHub or Forgejo)
  github-adapter.ts    Forge over the existing GithubService (phase C)
  forgejo/
    client.ts          REST client: base URL, auth, pagination, errors, redaction
    adapter.ts         Forge over the client
    sync.ts            baseline and incremental sync, reusing github/diff.ts
    evidence.ts        attachments and the fallback contents path
services/factory/forge-port.ts   FactoryForge over Forge (phase C)
```

Phase 1 keeps `GithubService` as it is and adds the Forgejo adapter beside it. The registry
returns the Forgejo adapter for `kind: "forge"` and a thin GitHub wrapper for `kind: "github"`.
When the factory moves onto `FactoryForge` (phase C), the wrapper starts implementing the same
interface, and `FactoryGithub` becomes an alias. Nothing in phase 1 has to move GitHub code.

The sync is split the same way. `GithubSync` stays; `ForgejoSync` uses the same `diffIssue`,
`diffPr`, `github_issues`, `github_prs` and sync-state tables, and the same scheduler shape
(60 s idle, 15 s while a session's PR is open). A later phase can fold the two loops into one
scheduler; that is not needed for the first shippable slices.

### 4.4 Project shape, migration and back-compatibility

**Recommendation: add `kind: "forge"` with `forge: ForgeRepo` for Forgejo, and keep
`kind: "github"` unchanged.** The port's `ForgeRepo` also describes GitHub
(`provider: "github"`), produced by `forgeOf(project)`, so shared code never branches on the
kind.

Why this shape:

- A new discriminated-union member is backward compatible. Old `project.created` /
  `project.updated` payloads with `kind: "github"` or `kind: "local"` still parse, and the
  reducer keeps the project exactly as written. There is no event rewrite.
- `kind: "github"` plus `provider: "forgejo"` would make the kind lie. Every existing
  `kind === "github"` check would then mean "GitHub or Forgejo", and the one thing the field
  was good for (the locked GitHub flow) would need a second branch everywhere.
- Converting every existing GitHub project to `kind: "forge", provider: "github"` in the same
  change would touch about fifty call sites and every persisted project, for no user-visible
  value. It is a clean follow-up once both adapters implement the port and every call site uses
  `forgeOf`; it is not needed to ship Forgejo.

The shape:

```ts
export const Project = z.discriminatedUnion("kind", [
  z.object({ ...projectBase, kind: z.literal("github"), github: GitHubRepo }),
  z.object({ ...projectBase, kind: z.literal("forge"), forge: ForgeRepo }),
  z.object({ ...projectBase, kind: z.literal("local") }),
]);

/** GitHub and Forgejo as one shape for the port; null for local projects. */
export function forgeOf(project: Project): ForgeRepo | null;

/** True for both forge kinds; what the UI and tools use instead of `kind === "github"`. */
export function isForgeProject(project: Project): boolean;
```

For a GitHub project, `forgeOf` maps `{ owner, repo, remoteUrl, defaultBranch }` to
`{ provider: "github", baseUrl: "https://github.com", host: "github.com", … }`. The GitHub
adapter keeps using `https://api.github.com`. `provider: "github"` is not written for a
`kind: "forge"` project in phase 1; the enum member exists so the later conversion needs no
contract change.

**Migration.** One Drizzle migration adds a nullable `forge` JSON column to `projects`. The
`github` column stays. `projectToRow` / `rowToProject` handle all three kinds; existing rows are
not backfilled. `ProjectDetection` gains `forge: ForgeRepo | null`; `github` stays. A rebuild
from the event log produces the same rows.

**Events.** `github.synced` stays for GitHub. Forgejo emits `forge.synced` with the same payload
(`{ projectId, issues, prs }`); the projector and `services/github/projection.ts` treat the two
identically. `issue.*`, `pr.*` and `review.submitted` are already provider-neutral and are
reused unchanged. `FORGE_EVENT_TYPES` is added next to `GITHUB_EVENT_TYPES`; `GithubEventType`
does not change. `ProjectRemoteWarning.code` becomes
`z.enum(["github_remote_missing", "forge_remote_missing"])`; the JSDoc says which kind each
belongs to.

**The smaller contract and API deltas:**

- `ProjectRefreshOutcome` gains `forge_connected`, `forge_changed` and `forge_remote_missing`.
- `POST /api/projects/:id/disconnect-github` stays for GitHub; a sibling
  `disconnect-forge` handles a forge project, and the UI's button becomes "Disconnect forge".
  Both refuse while the factory is on, as today.
- `services/github/projection.ts` accepts `forge.synced` and the shared `issue.*` / `pr.*`
  events for `kind: "forge"`; it must use `isForgeProject`, not `kind === "github"`.
- The UI reaches coordinates through `forgeOf(project)` instead of `project.github`, so the same
  panel renders `host/owner/repo` for either provider.
- `GithubConnection` is still returned on the existing `/github` routes, with `provider` and
  `host`; no route rename is needed in phase 1.

**No silent downgrade.** A forge project whose `origin` stops matching its connection gets
`forge_remote_missing` and keeps its coordinates, exactly as a GitHub project does today. If the
origin changes to another repository on the same forge, the coordinates follow it. If it changes
to a *different forge* (GitHub ↔ Forgejo), the project keeps its current connection and warns;
switching forges is never automatic because it would orphan the issue/PR lineage.

### 4.5 What stays GitHub-only in phase 1

Phase 1 is read-only. Everything below stays GitHub-only until the named phase:

| Capability | Until | Why |
|---|---|---|
| Comments, labels, triage, closing issues | Phase B | Writes; needs the Forgejo permission and label mapping |
| `create_pull_request`, PR body/link, session PR feedback | Phase B | Writes; needs the branch push and PR mapping |
| The software factory, auto-merge, merge queue, reverts | Phase C | Needs statuses, merge pinning and the trust mapping |
| `attach_evidence`, vision branch | Phase D | Needs attachments/Contents and the rendering decision |
| Docker/remote execution for forge projects | Phase C/D | A container cannot reach `http://localhost:3000` on the host; needs a reachable URL |
| `gh` in agent prompts | Phase B | Forgejo agents use CodeDen tools, never a forge token |
| Draft PRs, `state_reason`, check runs, `mergeable_state`, ETag sync | Never (degraded) | Forgejo has no equivalent; see §5 |

## 5. Forgejo mapping

### 5.1 Verified against

Checked on **2026-11-22** against:

- Forgejo **17.0.2** (latest) and **15.0.12** (LTS) documentation, <https://forgejo.org/docs/>.
- The API v1 OpenAPI v2 schema served by Codeberg, <https://codeberg.org/swagger.v1.json>
  (`17.0.0-121-39320c0+gitea-1.22.0` at the time of writing). Every endpoint and field below was
  read from that schema.
- The Forgejo source on the `forgejo` branch, for behaviour the schema does not spell out:
  `services/actions/commit_status.go` (Actions statuses), `models/issues/pull.go` (`Mergeable`),
  `models/git/protected_branch.go` (`IsUserOfficialReviewer`), `modules/structs/pull_review.go`
  (review states), `modules/structs/commit_status.go` (status precedence),
  `routers/api/v1/repo/issue_label.go` (labels by name), `modules/markup/sanitizer.go`
  (`<details>`, `<summary>`, `<sub>`, `<img>`), and `modules/webhook/type.go` (webhook events).

Forgejo's API base is `/api/v1`. Scopes and routes are stable within a major version; a major
release may break them. The adapter reads `GET /version` on connection and refuses a version
older than 15.0 with a clear message. There is an official Swagger UI at `/api/swagger` and the
raw schema at `/swagger.v1.json` on every instance.

### 5.2 Authentication and token scopes

- **Header:** `Authorization: token <token>` (the docs also accept `Bearer`).
- **Source:** the user creates a token in Forgejo under **Settings → Applications → Generate New
  Token**, or through `POST /users/{name}/tokens`. CodeDen stores it in the OS keychain and never
  asks `gh`, `tea` or the environment for it.
- **Scopes:** `read:repository`, `write:repository`, `read:issue`, `write:issue`, `read:user`.
  The `repository` scope covers pull requests, branches, commits, statuses and contents; `issue`
  covers issues, comments, labels and attachments; `read:user` is needed for `GET /user`.
- **Repository access:** use a dedicated **bot account** with **All (public, private, limited)** access and the scopes above, added as a collaborator on the project's repositories. Its collaborator role, not the token, limits what it can do. Forgejo's **Specific repositories** tokens are *not* a drop-in: they may use only the repository and issue scopes, so they cannot call `GET /user` and CodeDen cannot identify the viewer. With such a token the project still syncs, but intake trust falls back to `trustedAuthors`, reviews to `official`, and permission lookups fail closed; the project page says so.
- **Account:** the bot is the `viewer`, so its own issues, comments and reviews count as CodeDen's own. A person's admin token works but is a much larger blast radius.
- **Errors:** a 401 means the token was rejected ("not connected"). A 403 on `GET /user` (a
  specific-repository token, which has no user scope) means **connected with an unknown viewer**:
  the project page says so and trust falls back, rather than calling the whole connection broken.
  Any other 403 is reported as a scope or permission problem, not as "not found".

### 5.3 Identity, repository and permissions

| CodeDen needs | Forgejo call | Notes |
|---|---|---|
| Connect / test | `GET /version`, `GET /user` | Login and version are shown; the token is not returned. A 403 on `/user` means connected with an unknown viewer, not disconnected |
| Repository metadata | `GET /repos/{owner}/{repo}` | `default_branch`, `has_issues`, `has_pull_requests`, `has_actions`, `external_tracker`, `allow_squash_merge`, `permissions` for the token account |
| The account CodeDen uses | `GET /user` → `login` | Read at the start of each sync pass with the same token; cached by token value |
| A user's write access | `GET /repos/{owner}/{repo}/collaborators/{login}/permission` → `{ admin, pull, push }` | `push` or `admin` means write. 404 means none; 403 or 5xx means **unknown**, never "none" |
| Owner | Compare `login` with `owner` (case-insensitive) | For an organization-owned repo, the permission endpoint is the only source |

The permission endpoint is a repository-admin capability. A token that cannot use it makes
every author and commenter "unknown" unless the login is the viewer or in `trustedAuthors`; that
is the intended fail-closed behaviour, not a bug.

### 5.4 Issues, comments and labels

| CodeDen operation | Forgejo endpoint | Mapping and degradation |
|---|---|---|
| Baseline list (open + recently closed, issues and PRs) | `GET /repos/{owner}/{repo}/issues?state=open` (paginate), and `state=closed&since=<30 days ago>` | Each row with `pull_request` is a PR; the rest are issues. `limit` max 50 (`/settings/api`), so paginate with `Link` / `X-Total-Count` |
| Incremental list | `GET /repos/{owner}/{repo}/issues?state=all&since=<cursor>&sort=recentupdate&page=&limit=50` | `since` is RFC 3339 and inclusive; subtract a minute from the cursor to survive clock skew, then de-duplicate against the projection. No ETag |
| Issue detail | `GET /repos/{owner}/{repo}/issues/{index}` | `html_url`, `state`, `labels[].name`, `user.login`, `body`, `comments`, timestamps |
| Create issue | `POST /repos/{owner}/{repo}/issues` | **`labels` are IDs, not names.** Resolve names with `GET /labels` first; unknown names are dropped and logged. Body and title map directly |
| Comment | `POST /repos/{owner}/{repo}/issues/{index}/comments` | Same endpoint for issues and PR conversations. CodeDen's hidden `<!-- codeden -->` marker is stored in the body and stripped for display, as on GitHub |
| Read comments | `GET /repos/{owner}/{repo}/issues/{index}/comments?since=&page=&limit=50` | `since` for the incremental read; comments have `id`, `user.login`, `body`, `created_at`, `html_url` |
| Add labels | `POST /repos/{owner}/{repo}/issues/{index}/labels` with `{ labels: ["name", …] }` | Names or IDs; **unknown names are silently ignored**. Read the issue back (as today) so the projection says what actually applied |
| Remove labels | `DELETE /repos/{owner}/{repo}/issues/{index}/labels/{identifier}` | `identifier` is a name or ID; a 404 is treated as "already absent", as today |
| Replace labels | `PUT /repos/{owner}/{repo}/issues/{index}/labels` | Not needed by the current flows; available if a later triage mode wants it |
| Close / reopen | `PATCH /repos/{owner}/{repo}/issues/{index}` with `{ state: "closed" }` or `"open"` | **No `state_reason`.** See below |
| Issue author's association | No field on the issue | `permission(login)` from §5.3; unknown is untrusted |
| Linked issues on a PR | No `closingIssuesReferences` | Parse `Fixes #N`, `Closes #N`, `Resolves #N` (and their inflections) from the body. Forgejo closes on merge with the same keywords (`CLOSE_KEYWORDS`), so behaviour matches |

**No `state_reason`.** Forgejo's `Issue` has no `state_reason` field and `EditIssueOption` has no
way to set one (verified in the schema: the string `state_reason` is absent). Triage can close an
issue, but cannot record "not planned" versus "completed". CodeDen therefore:

- projects `stateReason: null` for every Forgejo issue;
- never claims a reason in the UI or in the triage result;
- must **not** treat a closed issue with no reason as completed. `services/factory/closed-issues.ts`
  currently does (`issue.stateReason === "completed" || !issue.stateReason`), which is correct for
  GitHub but wrong here. The Forgejo path uses a capability check: without `issueStateReason`, a
  closed issue stops the item and asks a person, rather than declaring the work done.

### 5.5 Pull requests, files, diffs, merge and update

| CodeDen operation | Forgejo endpoint | Mapping and degradation |
|---|---|---|
| List PRs | `GET /repos/{owner}/{repo}/pulls?state=open&page=&limit=50` | For the baseline and for reconciliation; incremental sync gets changed PR numbers from the issue list above and fetches each PR |
| PR detail | `GET /repos/{owner}/{repo}/pulls/{index}` | `head.sha`, `head.ref`, `base.ref`, `merged`, `merged_at`, `closed_at`, `draft`, `mergeable` (boolean), `merge_base`, `additions`, `deletions`, `changed_files`, `requested_reviewers`, `requested_reviewers_teams`, `user.login`, `html_url` |
| PR files | `GET /repos/{owner}/{repo}/pulls/{index}/files?page=&limit=50` | `filename`, `previous_filename`, `status`, `additions`, `deletions`; **no patch**. Paginate; treat 300+ files as incomplete, as the GitHub path does |
| PR diff | `GET /repos/{owner}/{repo}/pulls/{index}.diff` | `text/plain`. Parse `diff --git`, `new file`, `deleted file`, `rename from/to` and hunks into per-file patches. Binary files have no hunks. Read the head before and after; if it moved, return null and let the next tick read again |
| Create PR | `POST /repos/{owner}/{repo}/pulls` with `{ head, base, title, body }` | Same-repository branches only (all CodeDen sessions). **No `draft` field**: see below |
| Update PR | `PATCH /repos/{owner}/{repo}/pulls/{index}` with `{ title, body, state, base }` | No draft toggle either |
| Merge | `POST /repos/{owner}/{repo}/pulls/{index}/merge` with `{ Do: "squash", MergeTitleField, MergeMessageField, head_commit_id }` | **`head_commit_id` pins the merge to the reviewed head**; a moved head is 409 "head out of date". 405 means the style is not allowed or the PR is not mergeable; 409 also covers conflicts. The response has no merge SHA, so read `merge_commit_sha` afterwards if it is needed |
| Mergeability | `PullRequest.mergeable` (boolean) | `true` → `mergeable`; `false` → `unknown` on first read, and `conflicting` only after a second read with the same head still says `false` and the PR is not a draft. `Mergeable()` is false for a conflict, a conflict check in progress, a check error, or a work-in-progress title. There is **no `mergeable_state`**: `PrMergeState` is always `unknown` |
| Update branch | `POST /repos/{owner}/{repo}/pulls/{index}/update?style=merge` | **No `expected_head_sha`.** Read the head first and refuse if it is not the expected one; after the call, re-read and treat the new head as a new head for the approval and `diffKey` rules. `style=merge` merges the base into the head, like GitHub's update-branch; `style=rebase` exists but is not used |
| Close PR | `PATCH /repos/{owner}/{repo}/pulls/{index}` with `{ state: "closed" }`, after a comment | Same as `closePr` today |
| PR commits | `GET /repos/{owner}/{repo}/pulls/{index}/commits?limit=50&files=false&verification=false` | `sha`, `commit.message`; used for the projection's commits |
| Linked issues | Body keywords only | See §5.4 |

**No draft pull requests through the API.** `CreatePullRequestOption` and
`EditPullRequestOption` have no `draft` field, although `PullRequest.draft` exists and
work-in-progress title prefixes (`WIP:`, `[WIP]`) set it. CodeDen's `create_pull_request` accepts
`draft`; for Forgejo it **fails closed** with `400 draft_unsupported` and tells the agent to open
the pull request ready. Silently opening a ready PR when a draft was asked for would be a
capability lie.

**`head_commit_id` is real.** The merge endpoint passes it to `pull_service.Merge`, and a
mismatch returns 409 ("head out of date"). The merge queue's central guarantee (never merge a
head the approval does not cover) therefore survives. The adapter still reads the PR back after
a merge to record the merge commit, because the merge response is empty.

### 5.6 Reviews, decisions and requested reviewers

| CodeDen operation | Forgejo endpoint | Mapping and degradation |
|---|---|---|
| List reviews | `GET /repos/{owner}/{repo}/pulls/{index}/reviews?page=&limit=50` | `id`, `user.login`, `state`, `body`, `submitted_at`, `html_url`, `commit_id`, `official`, `stale`, `dismissed` |
| Submit a review | `POST /repos/{owner}/{repo}/pulls/{index}/reviews` with `{ event, body, commit_id, comments }` | `event`: `APPROVED`, `REQUEST_CHANGES`, `COMMENT`, `PENDING`. `commit_id` pins the review to a head. CodeDen's own review is an agent verdict, not a forge review; this is available for a later "post the verdict as a review" feature |
| Review state | `ReviewStateType`: `APPROVED`, `PENDING`, `COMMENT`, `REQUEST_CHANGES`, `REQUEST_REVIEW`, unknown | Map to the existing `GithubReview.state` (`commented` for `COMMENT`, `dismissed` when the `dismissed` flag is set) |
| `reviewDecision` | **No field** | Compute: official, non-dismissed, non-stale reviews; any official `REQUEST_CHANGES` → `changes_requested`; else count official approvals against `GET /branches/{base}` `required_approvals` → `approved` / `review_required`; no requirement and no reviews → `none` |
| Requested reviewers | `requested_reviewers` (users), `requested_reviewers_teams` (teams) | User logins map directly. There is no `combinedSlug`; use the team name (and organization) for display and for `pr.review_requested` |
| Review comments | `comments_count`, `GET /pulls/{index}/reviews/{id}/comments` | Not projected today; `commenters()` reads them for trust |
| Dismiss a review | `POST /pulls/{index}/reviews/{id}/dismissals` | Exists; CodeDen only reads dismissals today |

**`official` is not the same as write access.** Forgejo sets it when a review counts towards the
branch's required approvals. Without an approvals whitelist, that is exactly "the reviewer has
write access to the code unit" (`IsUserOfficialReviewer`). With a whitelist, it is narrower: a
maintainer outside the whitelist is not official. CodeDen therefore uses live permission first
and `official` as a fallback only when permissions cannot be read (see §6.2). `official` is
stored at submission time and can be stale; the live permission check is what revocation
depends on.

### 5.7 CI: commit statuses and Actions

Forgejo has **commit statuses**, not check runs. There is no Checks API, no annotations, and no
`statusCheckRollup`.

| CodeDen need | Forgejo call | Mapping |
|---|---|---|
| Checks on a head | `GET /repos/{owner}/{repo}/commits/{sha}/status?limit=50` | `state` (`pending`, `success`, `error`, `failure`, `warning`, `skipped`), `statuses[]` with `context`, `status`, `target_url`, `description`, `created_at` |
| Older statuses | `GET /repos/{owner}/{repo}/commits/{sha}/statuses?...` | Use the combined endpoint; page it if `total_count` exceeds the page |
| Combined state | `CombinedStatus.state` | Forgejo's precedence is `error < failure < warning < pending < success < skipped`. Map `error`/`failure` → failure; `warning` → failure (fail closed: a non-success state never gates a merge as green); `pending` → pending; `success`/`skipped` → success; unknown → pending |
| Check identity | `statuses[].context` | The Actions context is `<workflow name> / <job name> (<event>)`, one per job. Deduplicate per context, keep the newest, then compute names and counts |
| Check URL | `target_url` | The job page; CodeDen never fetches logs itself |
| Default-branch CI | `GET /branches/{default}` then the status endpoint for `commit.id` | Same `MainHead` shape |
| "Can CI run?" | `Repository.has_actions` plus workflow files | See below; **null** is a valid answer |

**Forgejo Actions** is the built-in CI. Workflows live in `.forgejo/workflows`; if that directory
is absent, `.gitea/workflows` and then `.github/workflows` are used. Actions is *familiar but not
compatible* with GitHub Actions, and work is executed by an `act_runner` registered with the
instance. The API exposes runs, jobs, logs and re-runs, but **no list-workflows endpoint** and no
non-admin view of whether a runner is online. CodeDen therefore detects "Actions looks
configured" as `has_actions === true` and at least one `.yml`/`.yaml` in one of those directories
(read with `GET /contents`). That is not "a runner is online".

**Other CI.** Any tool can post a commit status with a token:
`POST /repos/{owner}/{repo}/statuses/{sha}` with `{ state, context, description, target_url }`.
Woodpecker, Drone, a script, or a self-hosted runner all surface the same way. This is why the
port reads statuses rather than Actions.

`ciAvailable()` therefore returns:

- `true` when Actions is enabled and a workflow file exists (a status is *expected*, though a
  missing runner can still mean none appears);
- `false` when Actions is disabled, no workflow file exists, **and** the project has never seen a
  commit status (so no external CI has ever reported);
- `null` otherwise (unknown). Null is the normal answer for a Forgejo repository with external
  CI.

`false` is what lets `failures.ts` and `recover.ts` mark an item stuck with "turn off Require CI"
instead of retrying forever. Returning `false` for a repository that might get an external
status would be worse than `null`.

### 5.8 Contents, evidence and the vision branch

Forgejo has **no Git Data write API**: no create-blob, create-tree, create-commit or create-ref
endpoints (only reads under `/git/`). It does have a Contents API that creates a commit per file,
and an attachment API for issues and pull requests.

| CodeDen need | Forgejo call | What CodeDen does |
|---|---|---|
| Evidence images and artifacts | `POST /repos/{owner}/{repo}/issues/{index}/assets` (multipart `attachment`) | Upload each file; the response `Attachment.browser_download_url` is embedded in the `### Evidence from CodeDen` comment. Defaults: 2 GiB per file, 5 files per upload, allowed types include png/jpeg/gif/webp/svg, logs and zips |
| Evidence fallback | `GET`/`PUT`/`POST /repos/{owner}/{repo}/contents/{path}` | A normal `codeden/evidence` branch (not an orphan): one commit per file, or a batch through a brokered git push. Used when attachments are disabled or a file exceeds the instance's limits |
| Evidence merge check | Existing `EVIDENCE_HEADING` comment | The adapter recognizes image links to the configured host (`/attachments/...` or `/raw/branch/...`), and `<summary>Test output</summary>`. Only comments by the viewer count |
| Vision file | `GET /contents/{path}?ref=<branch>`, then `PUT /contents/{path}` with `sha` and `branch`, or `new_branch: "codeden/vision"` | If an open vision PR exists, commit on top of its branch; otherwise delete a stale branch (`DELETE /branches/{branch}`) and create it from the default branch, then `POST /pulls` |
| Revert tree comparison | `GET /repos/{owner}/{repo}/git/commits/{sha}` | `parents[]` and `commit.tree.sha` are enough to prove an exact revert |
| Revert creation | **No equivalent** | Return `null` from `revertMerge`, which the factory already treats as "an agent writes the revert" |

The evidence comment is still a comment: the marker prevents CodeDen from acting on its own
words, and the author check prevents a stranger from claiming evidence. Attachments are served
by Forgejo with the repository's own access control, so private repositories render them for
logged-in users.

### 5.9 No equivalent: the explicit list

| GitHub capability | Forgejo | Kind | CodeDen's behaviour |
|---|---|---|---|
| `state_reason` | Absent from the schema | degrade | `null`; never claim a reason; don't treat closed as completed |
| `author_association` | Absent from issues/comments/reviews | degrade, fail closed | Live permission lookup; `official` for reviews; unknown is untrusted |
| GraphQL `viewer` in the same response | No GraphQL | degrade, fail closed | `GET /user` in the same sync pass, cached by token; null means no own account |
| Conditional requests (ETags) | No ETag/Last-Modified on the listings CodeDen uses (verified with a live request) | degrade | `since` cursor with a one-minute overlap; pagination |
| Check runs, annotations, `statusCheckRollup` | Commit statuses only | degrade | Statuses mapped into the existing check shape |
| `mergeable_state` (`clean`, `behind`, `blocked`, `dirty`, …) | Boolean `mergeable` only | degrade, fail closed | `unknown`; settled `false` is a conflict; the merge call is the final authority |
| `reviewDecision` | Absent | degrade | Computed from official reviews and branch protection |
| `closingIssuesReferences` | Absent | degrade | Parse closing keywords from the PR body |
| Draft PR creation | No `draft` in create/update options | fail closed | `400 draft_unsupported` |
| Git Data write API (tree/commit/ref) | Absent | feature-gate | Contents API for one file; agent-written reverts |
| Orphan evidence branch | Absent | degrade | Attachments (preferred) or a normal branch |
| `actionsAvailable` (enabled + active workflow) | No list-workflows endpoint and no runner visibility | degrade, fail closed | `has_actions` + workflow files; `true` / `false` / `null` as in §5.7 |
| `mainHeadAt` (list commits `until`) | No `until`/`since` on the commits endpoint | degrade | `null`: no automatic inherited-CI restore; a bounded history walk is a later option |
| `expected_head_sha` on update-branch | Only `style` | degrade | Pre-read the head; re-read after; a new head follows the approval rules |
| Per-file patch in the file list | Only the whole `.diff` | degrade | Parse the unified diff; read the head before and after |
| `ahead_by` / `behind_by` in compare | Only `total_commits` (plus commits and files) | degrade | `behind = total_commits` of `head...default`; files are paths only; 300+ files count as incomplete |
| `gh` | Not available | feature-gate | CodeDen's MCP tools; `tea` is optional for people, never for agents |

## 6. Security and trust

### 6.1 The token

- **Where it comes from.** The user pastes it in **Settings → Forges → Forgejo**; CodeDen writes
  it to the OS keychain (`SecretStore`, key `forgejo.token`) and reads it at runtime. There is no
  `gh` equivalent for Forgejo and no fallback to an environment variable: a `FORGEJO_TOKEN` in
  the server's environment would be inherited by child processes and would be hard to audit.
- **Where it never goes.** The project entity, event payloads, runner journals, sync state, logs,
  transcripts, error messages, the UI's state, and agent environments. The one exception is the
  single clone, fetch or push command a sandboxed runner needs, which carries the credential for
  that git process only, as the GitHub broker does today. The settings API returns only
  `connected`, `source: "keychain"`, `login`, `host`, `provider` and a `message`; the token field
  is write-only and can be replaced or removed.
- **One connection in phase 1.** The settings shape is
  `forges.forgejo = { baseUrl, sshHost?, allowInsecureHttp }`, and the token key is fixed. More
  than one Forgejo instance needs a connection id in the secret key; `SecretKey` is currently a
  literal enum, so that is a deliberate later contract change, not something to fake now.
- **Redaction.** The Forgejo client logs nothing by default, never includes the `Authorization`
  header in an error, and scrubs the token from any message it propagates. A 401 invalidates the
  cached token and retries once; a second 401 is `forge_not_connected`.
- **Scopes.** As in §5.2. A token with `write:repository` can push; the same token is used for
  git, so the project's push and API rights agree. A read-only token makes the project read-only:
  the connection reports it, and write tools fail with the forge's 403 rather than pretending.

### 6.2 Who is trusted

GitHub's trust rules are in `factory/trust.ts`, `review-trust.ts`, `comment-trust.ts`,
`automations/triage.ts` and `factory/intake.ts`. They map as follows.

| GitHub signal | Forgejo signal | Used for | If it cannot be read |
|---|---|---|---|
| GraphQL `viewer` (the credential used) | `GET /user` with the same token, read at the start of each sync pass (and again after a 401 refresh); cached by token value | The account CodeDen uses: intake trust, `review.submitted` stamping, "not a stranger" | `viewer = null`. No account is CodeDen's own; intake takes only `trustedAuthors` and skips untrusted fresh issues (`viewer === null` today); reviews rely on write access or `trustedAuthors` |
| `authorAssociation` `OWNER` / `MEMBER` / `COLLABORATOR` | `permission(login)`: `push` or `admin`; the owner's own login is `owner` | Triage trust, commenter trust, review trust | `unknown` is **not** write access. The author/commenter/reviewer is untrusted |
| Review `authorAssociation` | `review.official` **or** live `permission` | Whether a review may steer an agent or the PM | If both are unavailable, the review is untrusted |
| Public repository: anyone may review | Forgejo also lets users without write access comment and review on a public repository; `official` is false for them | The same rule applies: untrusted reviews are input data | — |
| `trustedAuthors` | Unchanged, same field and matching | Extra logins trusted by the project | — |
| Labels never grant trust | Unchanged; Forgejo labels are equally forgeable by issue templates | Intake | — |

Precedence for a review: **live permission write/admin → trusted**; else **`official` → trusted**;
else **viewer or `trustedAuthors` → trusted**; otherwise untrusted. Precedence for an issue author
or commenter: live permission → viewer → `trustedAuthors`; no `official` flag exists for them.
A login is compared case-insensitively, as GitHub logins are.

The factory's "strangers' issues are ignored" rule does **not** use write access today: intake
trusts only `trustedAuthors` plus the viewer. Forgejo keeps that rule unchanged, so a maintainer
who files an issue must still be listed (or let in by a person), exactly as on GitHub. Write
access is used where GitHub uses `authorAssociation`: triage decisions, commenter trust and
review trust.

### 6.3 What must fail closed

- **No viewer:** no account is CodeDen's own; intake takes only `trustedAuthors` and skips
  untrusted fresh issues; a review or comment is trusted only by live write access or
  `trustedAuthors`.
- **Permission unknown** (403, 5xx, timeout): untrusted, not "probably a maintainer".
- **`official` false and no permission:** untrusted review; its body is not forwarded as
  instructions, and the PM notice is marked untrusted.
- **Repository units:** if `has_issues` is false or the repository uses `external_tracker`, the
  issue side is off with a clear reason; CodeDen does not invent issues from PRs. If
  `has_pull_requests` is false, PR tools are off; sessions can still code, but no PR flow. If
  `has_actions` is false and no workflow exists, CI is **not** assumed.
- **Review decision unreadable:** never `approved` from nothing; `changes_requested` only from an
  official review; otherwise `none`/`review_required`.
- **Checks unknown or `none`:** never green. `requireCi` decides between waiting and failing.
- **Merge:** only on `mergeable === "mergeable"`, a covered approval, and a successful
  `head_commit_id` merge. Any 409/405 is a refusal, never a retry that ignores the head.
- **Token or scope problem:** the connection is not connected; no partial sync is projected as
  if it were complete.
- **Base URL not allowed:** an `http://` URL for a public host is refused unless the user
  explicitly allowed insecure HTTP; a URL with credentials, a query or a fragment is refused
  outright.
- **Redirects:** a forge API redirect to another origin is refused, and the token is never sent
  to it.
- **Attachments or contents unknown:** the evidence merge check stays failed; it never passes on
  an unreadable comment.

### 6.4 Git credentials

Today `GitBroker` gives a credential only to a runner that does not share the server's disk
(`isRemoteRunner`), and only for `https://github.com`; the home runner uses the user's own git
setup. For Forgejo:

- **Clone URL.** For a sandboxed runner, clone over the configured web base:
  `<baseUrl>/<owner>/<repo>.git`, not the local `origin` (which may be SSH or a host alias the
  sandbox cannot resolve). This is the analogue of `githubCloneUrl`.
- **Scope.** `GitCredential.scope` changes from `^https://…` to `^https?://…`, and its host part
  must accept an IPv6 literal as well as a name (a forge on `[::1]:3000` is still loopback). The
  broker produces the exact origin of the configured base URL, including the port:
  `http://localhost:3000`, `https://forge.example.com:8443`. Git's credential helper is keyed by
  `credential.<scope>.helper`, so git asks for it only for that scheme, host and port.
- **Credential.** Username is the token account's login (`GET /user`, cached), password is the
  token. Do not use an `oauth2` username unless Forgejo documents it; the login is the safe
  choice.
- **Path check.** Before handing over a credential, the broker compares the remote's path with
  the project's `/<owner>/<repo>` (allowing `.git` and a trailing slash). This is stricter than
  today's host-only check and applies to both forges.
- **Plain HTTP.** `http://localhost:3000` is a normal self-hosted setup and is allowed for
  loopback and private addresses with a visible warning ("the token travels unencrypted on this
  network"). A public host must use HTTPS; `allowInsecureHttp` is an explicit opt-in, not a
  default.
- **Rewritten remotes.** `credential.helper=` clears every configured helper first, and the
  inline helper answers only for the scope. An agent that rewrites `origin` or a `pushurl` to
  another host, or uses `url.<base>.insteadOf`, gets no credential for that host. A rewrite to a
  *different repository on the same forge* would still match the scope; the path check and a
  specific-repository token are the mitigations. For pushes, CodeDen should push to the exact
  brokered URL rather than to whatever `origin` currently says; that is the hardening to add with
  the write path.
- **Local runner.** Keep today's rule: no brokered credential on the home runner. The user's git
  already works for the repository they cloned. Brokering there would put the token in a
  short-lived git process's environment on the same machine as the agent, which the remote-runner
  design deliberately avoids.
- **Sandbox reachability.** A container's `localhost` is not the host's Forgejo. A forge project
  on a sandboxed runner needs a base URL the sandbox can reach (a LAN name, or a Docker
  `host-gateway` entry, which is a later backend change). A failed clone says so; it does not
  fall back to the server's filesystem.

### 6.5 Network policy: two trust classes

`apps/server/src/network/public-fetch.ts` refuses loopback, private, link-local and special
addresses for fetches whose URL is **attacker-controlled**: automation import links, remote
images, and anything else a link in content can steer. That guard stays exactly as it is.

A Forgejo base URL is different: the user typed it, configured it, and authenticated it with
their own token. Refusing `http://localhost:3000` would make self-hosting impossible. So the
Forgejo client is **not** built on `publicFetch`; it uses a small fetch wrapper that:

- talks only to the configured base URL (no URL from issue text, comments or a redirect body);
- validates the URL once (scheme, no credentials, no query/fragment, allowed host class);
- refuses a cross-origin redirect, or drops the request rather than forwarding the token;
- caps response size and time, and maps timeouts to `forge_unavailable`.

Configuring a forge must not relax the guard anywhere else. A test should assert that
`isPublicAddress("127.0.0.1")` and `publicFetch("http://localhost:3000/…")` still fail with a
forge connection configured. The same applies to the UI's remote-image endpoint: it still refuses
private addresses, so a private Forgejo evidence image is shown on the forge page, not fetched by
CodeDen's server (see §8.2).

## 7. Detection and re-detection

`detectProject` stays the only place that reads `origin`. It gains an optional list of configured
forge connections and returns `forge: ForgeRepo | null` next to `github`:

- **Web remote.** `http(s)://<host>:<port>/<owner>/<repo>[.git]` matches a connection when the
  scheme, host and port equal the connection's `baseUrl` origin **exactly**, and the path is
  `/<owner>/<repo>` (or a subpath of a Forgejo served under a prefix). Credentials in the URL are
  redacted before anything is stored.
- **SSH remote.** `ssh://git@<host>:<port>/<owner>/<repo>` or `git@<host>:<owner>/<repo>` matches
  only when the connection has an explicit `sshHost` (and optional port). An SSH alias is not
  proof of a Forgejo instance.
- **No match.** The project stays `local`. The UI may say "This looks like a Forgejo remote; add
  the connection to connect", but nothing connects automatically.
- **Multiple matches.** Do not guess: leave it local and ask the user to choose the connection.

`reconcileProject` gets the forge transitions:

| From | Detected | Result |
|---|---|---|
| local | a configured forge remote | `kind: "forge"`, coordinates, `defaultBranch` |
| forge | the same repo (https ↔ ssh, a rename) | update `remoteUrl`/owner/repo, keep the connection |
| forge | another repo on the same forge | update coordinates, outcome `forge_changed` |
| forge | no matching remote | `forge_remote_missing` warning; never downgrade |
| forge | a GitHub remote | keep the forge project, warn; switching forges is a user action |
| github | a Forgejo remote | keep the GitHub project, `github_remote_missing`; same reason |

`ProjectRemoteWarning.remoteUrl` remains credential-redacted. The warning message names the
configured host and the current `origin` so the fix is obvious.

## 8. Sync design

### 8.1 Polling

Forgejo's API listings have no ETags, and there is no GraphQL. The sync is a straightforward poll:

- **Baseline:** open issues and PRs (paginated, capped at the same 500 items as GitHub's
  baseline), plus items closed and updated in the last 30 days, as one silent `forge.synced`
  event. The existing GitHub sync's baseline is the model.
- **Incremental:** `GET /issues?state=all&since=<cursor>&sort=recentupdate&limit=50`, paginate all
  pages. Items with `pull_request` are PR numbers to refresh; the rest are issues. Cursor =
  maximum `updated_at`, minus 60 s, so a slow clock or an inclusive `since` does not lose an
  update. The projection de-duplicates.
- **PR freshness:** always refresh open PRs whose checks are pending or whose mergeable state is
  unknown, every open PR linked to a session, and all open PRs every fourth tick. This mirrors
  `GithubSync`'s refresh set.
- **Comments:** only for new `issue.commented` events, at most 10 new comments, 20 000 characters
  each, as today. Forgejo's `since` on the comments endpoint helps.
- **Statuses and reviews:** read with the PR refresh; new reviews become `review.submitted` with
  the pass's `viewer`; status transitions become `pr.checks_passed` / `pr.checks_failed`.
- **Intervals:** 60 s idle, 15 s while a session has an open PR, 5 s scheduler tick, as today.
  Back off on errors (up to 15 minutes); honour 429/`retry-after` if the instance sends it.
- **No ETag means no 304:** every poll is a full request. A self-hosted instance makes this cheap;
  Codeberg's public rate limit is not the target. The adapter still caps pages and body sizes.

### 8.2 Rendering evidence in Markdown

- Use **absolute** URLs. A relative `/attachments/...` in a comment resolves against the comment
  page, which is not the same as the repository for every view; absolute URLs avoid the guess.
- Attachments return `browser_download_url`; embed `![alt](url)`. Forgejo's sanitizer allows
  `img`, `details`, `summary` and `sub`, so the existing evidence comment shape works: the
  heading, image links, captions, `<details><summary>Test output</summary>` and the footer.
- The fallback branch link is `<baseUrl>/<owner>/<repo>/raw/branch/codeden/evidence/<path>`, which
  Forgejo serves inline for a repository the viewer can read.
- CodeDen's own Markdown renderer fetches remote images through `publicFetch`, which refuses
  `localhost` and private addresses. Do **not** widen that guard for a configured forge. Evidence
  images render on the forge page; in the CodeDen UI they show as a link. If in-app previews are
  later required, add a narrowly scoped, user-initiated grant that accepts only URLs under the
  configured base URL and fetches through the forge API with the token, never arbitrary content
  URLs.

## 9. Phasing

Each phase is independently shippable. Phases 0 and A have no factory impact; B adds writes; C
moves the factory; D finishes evidence, vision and docs. A phase can be cut without leaving a
half-written capability visible: capabilities default to off until the phase that implements
them lands.

| Phase | Slice | User-visible result | Acceptance criteria |
|---|---|---|---|
| **0** | Contracts + read-only client (the first PR) | None (foundation) | `ForgeRepo`, `ForgeProvider`, `ForgeCapabilities`, `ForgeError`; a Forgejo REST client for `/version`, `/user`, repo, issues, comments, PRs, files, `.diff`, statuses and compare; a fake HTTP server test; token never in a message; typecheck, lint, test green |
| **A1** | Connection + detection | Settings → Forges → Forgejo says "Connected as `<login>`"; a matching project shows "Forgejo repository" | Token in keychain; `/version`/`/user` test; exact-origin/SSH-host matching; `kind: "forge"` + DB column; `forge_remote_missing`; GitHub/local untouched; old events parse |
| **A2** | Read-only sync + UI/PM reads | The project page lists Forgejo issues and PRs with labels, state, checks and reviews; the PM can read them | Baseline and incremental sync; PR files/diff/status; `forge.synced`; no POST/PATCH/DELETE to Forgejo (asserted in the fake); closed items; comments; token redaction |
| **B1** | Issue writes | Triage on Forgejo: comment, label, close; create issue | Labels resolve by name; unknown labels reported; close works and `stateReason` stays null; untrusted authors ignored; write errors map to `forge_*` |
| **B2** | PR writes + feedback | An agent opens a PR from a Forgejo project; `Fixes #N`; the session gets PR feedback | Push through the broker; PR create/update; only trusted review/check notices (permission or `official`); an untrusted review's body is never forwarded; draft request refused; issue URL comes from the forge, never a hard-coded GitHub URL |
| **C1** | Checks + merge queue | The factory can merge a Forgejo PR | Statuses → `ChecksState`; `mergeable` settling; `head_commit_id` merge; 409/405 refusals; update-branch pre/post head; `mainSince` via compare |
| **C2** | Trust + reviews + intake | The factory runs end to end on a Forgejo repo | Viewer, permission, `official` precedence; untrusted reviews/comments held; branch protection; `ciAvailable` semantics; `mainHeadAt` null is handled |
| **C3** | Reverts + hardening | A red default branch gets a revert PR | Agent-written revert; `revertMatches` by tree; no Git Data API assumption; merge queue order |
| **D1** | Evidence | `attach_evidence` posts an inline image comment that the factory accepts | Attachments; absolute URLs; `<details>`; comment author = viewer; fallback branch; private-repo rendering |
| **D2** | Vision + docs | The vision editor opens/updates a `codeden/vision` PR; a Forgejo user guide exists | Contents API create/update; stale branch reset; PR; `docs/forgejo.md`; DESIGN wording approved |
| **D3** | Changelog + polish | Release notes mention Forgejo | `changes/<issue>-forgejo-*.md` per user-facing phase; docs-only changes none |

**The first PR we could merge** is phase 0: contracts and the read-only Forgejo client, with no
runtime wiring, no migration and no UI. It locks the seam and the error model, and its tests run
against a fake HTTP server. It is deliberately invisible to users. Phase A1 is the first PR with
a visible result.

Acceptance for the factory (C2) should include a real Forgejo instance with an `act_runner`, plus
a scripted adapter test for the cases a real instance makes slow: a moved head before merge, a
405 from branch protection, a permission 403, a stale `official` review, and a status warning.

## 10. Risks and open questions

| Risk / question | Recommendation |
|---|---|
| **CI: Actions/act_runner versus other CI** | Read commit statuses only. Treat Actions as one producer; detect it with `has_actions` + workflow files; `ciAvailable` is `true`/`false`/`null` as in §5.7. Never assume green from `none`; let `requireCi` decide. Document how to register `act_runner`. A repository with no CI should turn Require CI off; the stuck message says so |
| **Markdown and relative images for evidence** | Absolute attachment URLs; `<details>`/`<summary>`; no relative paths. CodeDen's UI keeps the public-only image guard; private evidence renders on the forge. Add a scoped forge image grant only if users ask for in-app previews |
| **`tea` versus server tools** | Server tools only. `tea` is optional for people; it stores its own token, and agents must never hold a forge token. Keep prompts forge-neutral (`get_pr_status`, plain git) |
| **Polling versus webhooks** | Polling in every phase. Webhooks are an opt-in later transport: only when the forge can reach the server's loopback (same host, or a deliberately exposed listener), with HMAC (`X-Forgejo-Signature`), a secret in the keychain, replay protection, and a new decision about network exposure. Until then a local app cannot receive them |
| **`mergeable` is a boolean** | `true` → mergeable; `false` → unknown on the first read, conflicting only after a settle read with the same head and a non-draft PR; never merge on `false`. A false positive costs a rebase turn, never a wrong merge |
| **No `state_reason`** | `null`; capability-gate the factory's "closed means completed" logic. A closed Forgejo issue stops the item and asks a person instead of declaring success |
| **No `mainHeadAt`** | Return `null`; skip the inherited-CI automatic restore. The item stays failed and a person or the PM can retry after main is green. A bounded commit-history walk is a later option if users hit it |
| **No Git Data write API** | Agent-written reverts (existing fallback); Contents API for vision and fallback evidence; never fake a tree/commit |
| **No ETags / GraphQL** | `since` + overlap + pagination; keep GitHub's ETag/GraphQL path. Rate limits are instance-specific; back off |
| **Permission lookup may 403** | Fail closed; show "trust checks are limited" on the project page; recommend a bot with repository admin or `trustedAuthors`. `official` covers reviews when permission is unreadable |
| **Specific-repository tokens cannot call `/user`** | Use a bot account with All access and the scopes in §5.2. If a specific-repository token is used, the viewer is unknown: intake takes only `trustedAuthors`, reviews trust only `official`/write access, and the project says why |
| **Remote runners cannot reach `localhost`** | Fail with "the forge is not reachable from this runner"; use a LAN name or a later `host-gateway` entry. Do not fall back to the server's disk |
| **API drift across Forgejo majors** | Probe `/version`; require 15.0+; test against 15 LTS and 17; capability flags absorb additive changes; a major-change note in the user guide |
| **Draft PRs** | Refuse `draft: true` with `draft_unsupported`; do not silently open a ready PR |
| **Multiple Forgejo instances** | One connection in phase 1. Later: connection ids and dynamic secret keys; do not overload `baseUrl` |
| **Stale `official`** | Prefer live permission; use `official` only when live permission is unavailable; revocation therefore follows the permission lookup |
| **Branch protection hides the reason for 405** | Surface the forge's message; do not translate it into a factory check failure with a guessed cause; retry only where the loop already retries |
| **Token on plain HTTP** | Allowed for loopback/private with a warning; refused for public hosts unless explicitly allowed; prefer HTTPS and a scoped bot token |
| **Labels by ID vs name** | Resolve create-issue labels to IDs; add/remove by name; read back after a change; report what applied |
| **HTML markers in comments** | Forgejo stores the raw body; rendering strips HTML comments. Test the `<!-- codeden -->` marker and do not rely on it for display |
| **Docker backend in phase 1** | Keep it GitHub-only until the forge is reachable from a container; the existing refusal message names the reason |

## 11. Proposed wording for `docs/DESIGN.md` (not applied)

These are the exact edits the owner would approve. Nothing below is changed in this pull request.

### 11.1 §3 locked decisions

**Row “Projects” (old):**

> | Projects | GitHub repos get the full issue/PR/evidence flow. **Local-only folders are supported** without the GitHub features |

**New:**

> | Projects | GitHub repos, and opt-in self-hosted Forgejo repos ([forges.md](forges.md)), get the issue/PR flow; Forgejo evidence, the factory and auto-merge are capability-gated. **Local-only folders are supported** without forge features |

**Row “Forges” (old):**

> | Forges | GitHub only in v1 |

**New:**

> | Forges | **GitHub and self-hosted Forgejo** (Gitea-compatible REST API v1). GitHub is the default and keeps every feature; a Forgejo project is opt-in, read-only first, with the factory, evidence and vision behind capability gates ([forges.md](forges.md)). No other forge in v1 |

### 11.2 §1

**Old:**

> Every piece of work stays visible and traceable in GitHub.

**New:**

> Every piece of work stays visible and traceable in the project's forge (GitHub, or a self-hosted Forgejo instance).

### 11.3 §9 heading and bullets

**Heading (old):**

> ## 9. Git and GitHub

**New:**

> ## 9. Git and forges (GitHub and Forgejo)

**Bullet “GitHub API” (old):**

> - **GitHub API.** Octokit on the server, authenticated with the token from `gh auth token` (read at runtime, not stored). Agents use `gh` inside their worktrees.

**New:**

> - **Forge APIs.** One `Forge` port on the server ([forges.md](forges.md)), with two adapters: GitHub through Octokit, authenticated with the token from `gh auth token` (read at runtime, not stored), and self-hosted Forgejo through its REST API v1, authenticated with a token the user stores in the OS keychain (`forgejo.token`). Agents use `gh` in GitHub projects; in Forgejo projects they use CodeDen's forge tools, never a forge token.

**Bullet “Sync” (old):**

> - **Sync.** Issues, PRs, checks and reviews are polled with conditional requests (ETags) and batched GraphQL. A local app can't receive webhooks; webhook support arrives with remote runners.

**New:**

> - **Sync.** Issues, PRs, checks and reviews are polled. GitHub uses conditional requests (ETags) and batched GraphQL; Forgejo's listings support neither, so it polls with an `updated` cursor and pagination. A local app can't receive webhooks; webhook support arrives with remote runners.

**Bullet “Evidence” (first sentence, old):**

> - **Evidence.** Screenshots and test artifacts are committed to a dedicated orphan branch (`codeden/evidence`) and linked from PR and issue comments, so GitHub renders them inline.

**New first sentence:**

> - **Evidence.** On GitHub, screenshots and test artifacts are committed to a dedicated orphan branch (`codeden/evidence`) and linked from PR and issue comments, so GitHub renders them inline. On Forgejo they are uploaded as issue/PR attachments (or committed to a normal `codeden/evidence` branch when attachments are unavailable), because Forgejo has no Git Data write API.

**Bullet “Local-only projects” (old):**

> - **Local-only projects** (no GitHub remote) get sessions, worktrees, checkpoints, diffs and automations, but no issue, PR or evidence flow.

**New:**

> - **Local-only projects** (no supported forge remote) get sessions, worktrees, checkpoints, diffs and automations, but no issue, PR or evidence flow.

**Bullet “Re-detection” (last sentence, old):**

> A folder that gains a GitHub remote becomes a GitHub project; one that loses it is never downgraded on its own: it gets a warning, and the user restores the remote or disconnects GitHub.

**New:**

> A folder that gains a supported forge remote becomes a forge project; one that loses it is never downgraded on its own: it gets a warning, and the user restores the remote or disconnects the forge. A remote is matched to Forgejo only against a configured connection, never by guessing a hostname.

**Bullet “PR feedback for user sessions” (trust sentence, old):**

> On a public repository anyone can review, so only a trusted review is passed on: its author has write access (GitHub's `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`), is the account CodeDen read the review with (GraphQL `viewer`, asked in the same request and carried on the `review.submitted` event, so a credential refresh to another account never leaves the old one trusted), or is one of the project's trusted authors.

**New:**

> On a public repository anyone can review, so only a trusted review is passed on: its author has write access (GitHub's `authorAssociation` is `OWNER`, `MEMBER` or `COLLABORATOR`; on Forgejo, the collaborator permission is `push` or `admin`, or the review is `official`), is the account CodeDen read the review with (GitHub's GraphQL `viewer`, asked in the same request; on Forgejo, `GET /user` read with the same token in the same pass; carried on the `review.submitted` event, so a credential refresh to another account never leaves the old one trusted), or is one of the project's trusted authors.

### 11.4 §10.1

**Old:**

> **The software factory.** Issues are created outside CodeDen (by you, teammates, or any tool that files GitHub issues). A GitHub repository is required; GitHub is the only forge in v1.

**New:**

> **The software factory.** Issues are created outside CodeDen (by you, teammates, or any tool that files issues on the project's forge). A repository on a supported forge is required: GitHub, or a self-hosted Forgejo instance ([forges.md](forges.md)). GitHub is the default; Forgejo factory support is opt-in and capability-gated.

**Trust paragraph (old):**

> Only issues by **trusted authors** are taken on: the logins in the project's `trustedAuthors` and the account CodeDen uses on GitHub. On a public repository anyone can open an issue, and an issue is a prompt for an agent, so everyone else's issues are **ignored**.

**New:**

> Only issues by **trusted authors** are taken on: the logins in the project's `trustedAuthors` and the account CodeDen uses on the project's forge. On a public repository anyone can open an issue, and an issue is a prompt for an agent, so everyone else's issues are **ignored**.

### 11.5 What the owner should know

- The three named edits are §11.1 (Forges row), §11.3 (the §9 heading) and §11.4 (the factory
  sentence). §11.1's Projects row, §11.2, the other §9 bullets and the trust paragraph are
  consequential: leaving them unchanged would make the document contradict itself.
- The Design status line at the top of `docs/DESIGN.md` should gain "Forgejo forges were
  proposed on 2026-11-22; [forges.md](forges.md) records the plan" once approved.
- If the owner prefers the full unification of `kind` on `forge` with a `provider`, that is a
  later migration, not a wording change; this design deliberately does not require it.

## 12. Sources

- Forgejo API usage (authentication, pagination, `/settings/api`), <https://forgejo.org/docs/v15.0/user/api/usage/>
- Access token scopes, <https://forgejo.org/docs/v15.0/user/authentication/token-scope/>
- Forgejo Actions user guide, <https://forgejo.org/docs/v15.0/user/actions/overview/>
- Forgejo Actions versus GitHub Actions, <https://forgejo.org/docs/v15.0/user/actions/github-actions/>
- Configuration cheat sheet (attachments, repo units, `CLOSE_KEYWORDS`, `DEFAULT_UPDATE_STYLE`), <https://forgejo.org/docs/v15.0/admin/config-cheat-sheet/>
- Webhooks and the `X-Forgejo-Signature` HMAC, <https://forgejo.org/docs/v15.0/user/repository/webhooks>
- API v1 OpenAPI schema, <https://codeberg.org/swagger.v1.json>
- Source (read on 2026-11-22, `forgejo` branch):
  - `services/actions/commit_status.go` — Actions creates a commit status per job, context
    `<workflow> / <job> (<event>)`, state mapping.
  - `models/issues/pull.go` — `Mergeable()` is false for conflict, checking, error or WIP.
  - `models/git/protected_branch.go` — `IsUserOfficialReviewer`: write access, or the approvals
    whitelist.
  - `modules/structs/pull_review.go` — review state values.
  - `modules/structs/commit_status.go` — status precedence.
  - `routers/api/v1/repo/issue_label.go` — labels by name; unknown names are ignored.
  - `modules/markup/sanitizer.go` — allowed `img`, `details`, `summary`, `sub`.
  - `modules/webhook/type.go` — `pull_request_review_approved` / `_rejected` / `_comment`.

## 13. What this document does not decide

- Whether to convert GitHub projects to `kind: "forge"` and drop the `github` union member
  (recommended later, not now).
- Whether to support more than one Forgejo connection, or more forges (GitLab, Gitea) — the
  provider field and connection id leave room, nothing more.
- Whether a host can expose a webhook listener; that needs the owner's network decision
  (`docs/DESIGN.md` §15.2) and is not required for polling.
- In-app previews of private-forge evidence images; the scoped grant described in §8.2 is a
  follow-up, not part of phase 1.
