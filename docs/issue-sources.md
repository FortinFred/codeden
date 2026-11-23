# Issue sources: file-backed issues

> Status: **proposed 2026-11-23**. Design only: no source, schema, migration or UI changes are
> included, and no changelog fragment (docs-only). The exact `docs/DESIGN.md` wording is in §13
> and has **not** been applied.

CodeDen has always taken issues and pull requests from the same place: a GitHub repository, and
since [forges.md](forges.md) also a self-hosted Forgejo repository. This proposal separates the
two. A project's issues can come from a folder of Markdown files in the repository, committed
to git, while its pull requests stay on its forge. The motivating case is a fork whose GitHub
issues are disabled: CodeDen still needs a backlog, triage, the PM's issue tools and factory
intake, but the forge has nowhere to put issues.

The file source is not a second tracker implementation. It is parsed into the same
`github_issues` projection and emits the same `issue.*` events, so the issues tab, the PM's
tools, search, notices and factory intake keep working unchanged.

## 1. Decisions at a glance

| # | Question | Decision |
|---|---|---|
| 1 | Where the setting lives | `Project.issues: { source: "forge" \| "folder", folder: ".codeden/issues" }` on every project kind; `source` defaults to `"forge"` |
| 2 | What `kind` still means | The project's repository and **pull request** forge: `github`, `forge` (Forgejo) or `local`. It no longer decides where issues come from |
| 3 | Issue/PR split | Issues follow `issues.source`; pull requests always use `forgeOf(project)`. A `github` project can have folder issues and GitHub PRs; a `local` project can have folder issues and no PRs |
| 4 | Capability model | `isForgeProject` keeps meaning "has a PR forge"; `issueSourceOf(project)` says `forge`, `folder` or `none`. UI and tools read those, never `kind` for issues |
| 5 | File format | One Markdown file per issue in `.codeden/issues/`, YAML front matter, body below, a managed comments appendix; filename `0001-<slug>.md` |
| 6 | Writer | The server is the only writer for CodeDen-initiated changes, on the default branch, one commit per content change (plus a small reservation commit on create); sessions never edit issue files as part of their work |
| 7 | Numbering | A durable reservation ledger, allocate next + 1 through a compare-and-swap commit; numbers are never reused and never renumbered |
| 8 | Seam | A folder sync parses files into `github_issues` and emits `issues.synced` plus the existing `issue.opened`, `issue.labeled`, `issue.updated` and `issue.commented`; `diffIssue` is reused |
| 9 | Read source | The **committed default branch**, read through git (`ls-tree` / `cat-file`), never a working tree or a session worktree |
| 10 | Trust | Files on the default branch are as trusted as the repository's writers: a merged change is a person's approval, so factory intake takes them. `author` is shown, never trusted by itself |
| 11 | Merge close | A merged PR with `Fixes #N` (or `Closes #N`) closes the file on the default branch; a queued, retried write does it, not GitHub |
| 12 | Comments | Append-only entries in the issue file under a fixed marker; single writer plus commit retries, never auto-merged conflict resolution |
| 13 | Secrets | The backlog is as public as the repository; issue files hold no credentials, private customer data or pre-disclosure details, and never evidence images |
| 14 | Migration | Existing projects stay on `forge`. Switching source starts the new source from scratch (rows reset, new baseline); CodeDen does not import forge issues into files |
| 15 | Local projects | A git-backed local project may use folder issues for triage and sessions; it has no PR flow or factory loop |
| 16 | Phasing | Contracts and parser first (first mergeable PR), then read-only sync, writes, merge-close, factory intake, docs |

## 2. Baseline (decided, not re-litigated)

- **Issue source is independent of the PR forge.** A project has `issues.source: "forge" |
  "folder"` (default `"forge"`, meaning its GitHub/Forgejo connection, so existing projects are
  unchanged). Pull requests always use the project's forge (GitHub or Forgejo); a `local` project
  may use `folder` issues and have no PRs.
- **The folder is in the repository**, `.codeden/issues/` by default, overridable per project; it
  is tracked in git so issues are versioned, visible in worktrees and travel with the code. A
  folder outside the repository is out of scope.
- **One file per issue**, Markdown with YAML front matter (`number`, `title`, `state`,
  `stateReason`, `labels`, `author`, `createdAt`, `updatedAt`, linked PRs) and the body below; a
  stable integer number in the filename (`0001-<slug>.md`), allocated by the server as the single
  writer, never by concurrent agents.
- **CodeDen writes the files, not sessions**: create, label, triage/close and comments are server
  writes on the default branch (committed/pushed like the vision file is), and a linked PR
  (`Fixes #N`) closes the issue when it merges. Sessions never edit issue files as part of their
  work.
- **Reuse the existing seam**: parse the folder into the same `github_issues` projection and the
  same `issue.*` events, so the UI tab, PM tools (`list_issues`, `get_issue`, `triage_issue`),
  search and factory intake need no second implementation. No GitHub/Forgejo issue API is called
  when the source is `folder`.
- **Trust**: files on the default branch are as trusted as the repo's writers (a merged change is
  a person's approval); the factory intake takes them, and an untrusted PR cannot add runnable
  issues without being merged. `state_reason` exists in the front matter (unlike Forgejo).

## 3. Today: where issues and PRs are one flow

The coupling is not one field. It runs through contracts, sync, projections, services, tools and
UI. This is the checklist the new seam has to reach.

| Area | Today | What the issue source needs |
|---|---|---|
| Project identity | `Project` is `github`, `forge` or `local`; `forgeOf` and `isForgeProject` describe the forge connection (`packages/contracts/src/entities/project.ts`) | An `issues` setting on all kinds; `kind` stays the repository/PR forge |
| Issue reads | `GithubService.issuesResponse` and `ForgeService.issuesResponse` return rows from `github_issues` | A folder sync writing the same rows; the response says which source it is |
| Issue writes | `createIssue`, `commentOnIssue`, `labelIssue`, `triageIssue` call Octokit or the Forgejo client (`services/github/issues.ts`, `services/forge/issues.ts`) | A folder writer with the same methods; no forge issue call |
| Sync | `GithubSync` polls the issues listing; `ForgejoSync` polls `since` (`services/github/sync.ts`, `services/forge/forgejo/sync.ts`) | A folder scan of the default branch; forge sync stops reading issues for that project |
| Projection | `github_issues` keyed by `(projectId, number)`; events carry full rows (`services/github/projection.ts`, `rows.ts`) | Reused unchanged; one new silent import event |
| Events | `issue.opened`, `issue.labeled`, `issue.updated`, `issue.commented`; a close is `issue.updated` with `changes: ["state"]` | Reused unchanged through `diffIssue` |
| PM tools | `list_issues`, `get_issue`, `triage_issue`, `create_issue` are listed for a GitHub or forge project (`mcp/tools/pm/github.ts`, `inIssueTrackingProject`) | Listed for a folder source too; the same service dispatches |
| Triage | `TriageService` reads the projection and asks GitHub for the author's association | Folder authors are trusted by the default branch; no forge lookup |
| Factory | Intake reads `ctx.github.openIssues` and writes comments/labels through the same port (`services/factory/intake.ts`, `github-port.ts`) | Same reads/writes, dispatched by source; factory still needs a forge for PRs |
| UI | The issues tab reads `/api/projects/:id/github/issues` and shows a forge connection (`apps/web/src/components/github/project-github.tsx`) | A source label, file problems, file paths, and no fake forge connection |
| Notices | `issue.opened` creates an inbox notice with `issue.url` (`services/orchestration/github-notices.ts`) | `url` must be a real URL, a blob link or a `file://` link |

The names `github_issues`, `github_sync_state` and `GithubService` are storage and seam names,
not source claims; `docs/forges.md` §3 already accepts that as naming debt.

## 4. The model

### 4.1 Project shape

Add one object to the shared project base, so every kind has it:

```ts
export const IssueSourceSettings = z.object({
  /** Where this project's issues come from. Default: its forge, as today. */
  source: z.enum(["forge", "folder"]).default("forge"),
  /** Repository-relative folder for `folder`; ignored when source is `forge`. */
  folder: z.string().min(1).default(".codeden/issues"),
});

// in projectBase
issues: IssueSourceSettings.prefault({}),
```

The default matters: an old `project.created` or `project.updated` payload parses as
`{ source: "forge", folder: ".codeden/issues" }`, so no event is rewritten and every existing
project behaves exactly as it does today. `kind`, `github` and `forge` do not move.

`folder` is a repository-relative path. It is rejected when it is absolute, contains `..` after
normalization, or resolves outside `project.path`. A path with a trailing slash is normalized.

### 4.2 What `kind` still means

| Kind | Pull requests | Issue source today | Issue source after this change |
|---|---|---|---|
| `github` | GitHub | GitHub | GitHub, or files in the repository |
| `forge` | Forgejo | Forgejo | Forgejo, or files in the repository |
| `local` | none | none | none, or files in the repository |

`forgeOf(project)` still returns the **PR** forge (`null` for local). `isForgeProject(project)`
still means "this project has a forge" and is what PR, merge, evidence and factory gates use. It
is no longer a statement about issues.

Add two small helpers beside those in `project.ts` (names are illustrative):

```ts
/** Where this project's issues come from; `none` for a local project left on the default. */
export function issueSourceOf(project: Project): "forge" | "folder" | "none";

/** The repository-relative issue folder for a `folder` source; null otherwise. */
export function issueFolderOf(project: Project): string | null;

/** True when this project has issues at all (folder, or a forge connection it can read). */
export function isIssueProject(project: Project): boolean;
```

`issueSourceOf` returns `"none"` when `project.issues.source === "forge"` and `forgeOf(project)`
is null: a local project that has not opted into folder issues, exactly as today.

### 4.3 Capabilities the source implies

Do not branch on the source string in UI or orchestration. The helpers produce these facts:

| Capability | `forge` source | `folder` source |
|---|---|---|
| Read issues | Forge sync (GitHub or Forgejo) | Folder sync of the default branch |
| Write issues | Forge API (phase-gated on Forgejo as today) | Server commit on the default branch |
| Labels | Forge labels; unknown names are reported/dropped by the provider | Free-form strings in front matter; no label catalog |
| Comments | Forge comments | Append-only appendix in the same file |
| `stateReason` | GitHub yes; Forgejo `null` | Yes, in the front matter |
| Issue URL | Forge web URL | Blob URL on the forge, or a `file://` URL for a local project |
| Comments/evidence on the forge | Yes | No forge issue exists; evidence goes on the PR |
| Pull requests | The project's forge | The project's forge (unchanged) |
| Factory loop | Requires a forge | Requires a forge for its PRs; works on `github` and `forge` projects |
| Local project | No issues | Issues, triage and sessions; no PRs or factory |

An `IssueCapabilities` object can sit in contracts, but it must be derived from the project, not
stored independently. The settings remain the single source of truth.

### 4.4 Back-compatibility and switching

- **Old projects.** Default `forge`, same sync, same writes, same UI. No event rewrite.
- **Reads.** `project.created`/`project.updated` from before this change parse with the defaults.
  New events include `issues`; an older server reading them strips the unknown field and treats
  the project as `forge`. That is safe but wrong for a folder project; cross-version downgrades
  are not supported, and the UI can warn when a stored project's source is not what the running
  build understands.
- **Switching starts clean.** When `project.updated` changes `issues.source` or `issues.folder`,
  the append transaction deletes that project's `github_issues` rows and its folder sync state
  (file hashes, baseline), and leaves `github_prs` and PR sync untouched. The folder's own
  `.numbers` ledger is repository data: it is re-read on the next baseline, not deleted. The new
  source then performs its own baseline: `issues.synced` for files, the forge's existing baseline
  for a forge. Old numbers are not reinterpreted: forge issue #42 and file issue #42 are different
  issues and never coexist in the projection. Existing PR bodies are not rewritten, so a switch
  should be made while no open PR links a folder issue; the UI warns when one does. A switch while
  a factory mode is on also starts with a silent baseline, so files that already exist are old
  news, not newly opened work; they need the `codeden-factory` label or a person's decision. The
  UI says this before the switch.
- **No automatic switching.** Detection may change `kind` (a local project gains a GitHub remote,
  a GitHub project is disconnected) and that changes the PR flow, but never `issues.source`. A
  project that gains a forge remote while using folder issues keeps its backlog and gains PRs.
- **Folder needs git.** `source: "folder"` is refused with `400 not_a_repo` for a project whose
  `isGitRepo` is false, and whenever `isGitRepo` becomes false the sync reports `not_a_repo` while
  keeping the last good projection. It never falls back to forge issues on its own.

## 5. The file format

### 5.1 Location and file names

- Default folder: `.codeden/issues/`, relative to the repository root. One configurable folder per
  project; one source per project.
- Issue files match `^(\d{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$`:
  - at least four digits, growing to five after 9999;
  - a lowercase ASCII slug for humans, 1 to 60 characters, never used as identity;
  - the extension is `.md`, lowercase.
- Only files matching that pattern are issues. Other files are ignored; a `.md` file in the folder
  whose name does not match is reported as `bad_name` so a typo is visible. `README.md` and
  `.gitkeep` are explicitly allowed and ignored, so a repository can document the folder.
- No subdirectories are read. No attachments are stored there (see §5.9).
- The folder must not be git-ignored; CodeDen warns if it is.

### 5.2 A complete example

`0001-export-monthly-report-as-csv.md`:

```markdown
---
number: 1
title: "Export the monthly report as CSV"
state: open
stateReason: null
closedAt: null
labels:
  - needs-triage
  - reporting
author: alice
createdAt: "2026-11-23T09:14:00Z"
updatedAt: "2026-11-23T10:02:00Z"
pullRequests: []
---

The dashboard can show the monthly report, but finance needs it as a file for their spreadsheet.

## Acceptance criteria

- A **Download CSV** action on the monthly report page.
- The CSV has one row per day and the same columns as the table.
- No new dependency.

<!-- codeden:comments -->
## Comments

### 2026-11-23T09:40:00Z · @alice

Please include the totals row; the spreadsheet imports it as the last line.

### 2026-11-23T10:02:00Z · codeden

**CodeDen software factory**: classified as a **feature** (from its wording). Next: Analyze →
Implement → Review → Merge.
```

A closed issue differs only in its state fields:

```yaml
state: closed
stateReason: completed
closedAt: "2026-11-24T12:00:00Z"
pullRequests: [57]
```

`stateReason` is one of `completed`, `not_planned`, `duplicate` or `null`; it is meaningful only
while `state` is `closed`. `null` means unknown, never "completed".

### 5.3 Front matter fields

| Field | Required | Type | Rules |
|---|---|---|---|
| `number` | yes | positive integer | Must equal the filename's number. Never changed. A quoted digit string is accepted and normalized; `0` and negatives are malformed |
| `title` | yes | string | 1 to 256 characters; YAML quoting as needed |
| `state` | yes | `open` or `closed` | Missing state is malformed; it is not guessed from `stateReason` |
| `stateReason` | no | `completed`, `not_planned`, `duplicate`, `null` | Default `null`. `open` with a non-null reason is malformed. A closed issue with `null` is readable but reported as `missing_state_reason`, and the factory never treats it as completed |
| `closedAt` | no | RFC 3339 string or `null` | Default `null`; written when CodeDen closes; a hand close without it is approximated from `updatedAt` |
| `labels` | no | string array | Default `[]`; at most 20 labels, each 1 to 100 characters; duplicates removed; order preserved |
| `author` | no | string or `null` | A forge login without `@`, `local` for a person whose login is unknown, `codeden` for CodeDen itself; displayed, never trusted by itself |
| `createdAt` | no | RFC 3339 string | Default the first commit that added the file when that is cheap to read, else the baseline time |
| `updatedAt` | no | RFC 3339 string | Default the file's last commit time; CodeDen writes it on every write |
| `pullRequests` | no | positive integer array | Informational list of forge PR numbers; the forge remains authoritative; default `[]` |

An unknown top-level key is preserved when CodeDen edits the file and reported as an
`unknown_field` warning, not a fatal error, so a field from a future CodeDen or another tool
survives a round trip. A duplicate YAML key, an unknown YAML tag, an anchor/alias or a value of
the wrong type is malformed.

### 5.4 Body and comments

Everything after the closing `---` is the body, up to the comments marker. It is Markdown and is
stored as written (LF line endings); the projection truncates it at 20,000 characters like a
forge issue, while the file may hold up to 65,000. The create request applies the existing title
and body limits.

The body ends with the machine-managed marker:

```markdown
<!-- codeden:comments -->
## Comments

### <date> · <author>
```

- The marker is written once, at the end of the body, before the comments. CodeDen never treats a
  heading in the body as a comment; a body that contains the marker verbatim is malformed, so the
  source remains unambiguous.
- Each comment is an append-only entry:

  ```markdown
  ### 2026-11-23T09:40:00Z · @alice

  Comment text, which may contain any Markdown, including headings and code fences.
  ```

  The header regex is
  `^### (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) · (@[A-Za-z0-9._-]+|local|codeden)$`.
  A body line that would match it is escaped by the writer as `\### …` and unescaped by the
  parser, so no comment can forge the next entry's header.
- Comments are never edited or deleted by CodeDen. A comment's `GithubNewComment.id` is a stable
  53-bit hash of its timestamp, author and body (an integer), not its position, so a hand deletion
  elsewhere does not renumber the others; its `url` is the file URL with `#comment-<ordinal>`,
  where the ordinal is the 1-based position used for anchors.
- `comments: N` in the projection is the number of entries under the marker, not the number of
  `###` headings in the body.
- A comment entry with no body, a bad timestamp or an unknown author form is `bad_comment`; the
  rest of the file still reads, but the issue is reported and the factory skips it until fixed.

Comments are in the file, not only in SQLite, because the tracker is the repository. A second
copy that CodeDen alone can read would make the files a lie, and a comment posted by a person in a
text editor should survive CodeDen. The cost is write amplification: every comment rewrites the
whole file and adds a commit (§12).

### 5.5 Numbering and allocation

The number is identity. It appears in the filename and front matter, in `Fixes #N`, in session
`workKey`s (`issue:N`), in factory items and in inbox ids.

- **The reservation ledger.** The folder holds one metadata file, `.codeden/issues/.numbers`,
  which is not an issue file and is ignored by the scan. It is a tiny JSON document:

  ```json
  { "next": 42 }
  ```

  `next` is the next number to hand out. The ledger is the cross-server allocator, not just a
  cache: creating an issue first **reserves** the number by updating the ledger through the same
  compare-and-swap path as any other write (old blob `sha` on GitHub/Forgejo, old head for a local
  commit), then writes the issue file with that number. Two servers (or two clones) cannot receive
  the same number, because only one can move the ledger from 42 to 43.
- **A reservation is a commit.** The create is therefore two commits: `codeden: reserve issue
  #42`, then `codeden: add issue #42 <title>`. A crash between them leaves a gap, which is
  harmless and permanent. A failed issue write does not return the number: returning it would
  invite reuse.
- **One writer.** UI, PM tools, triage and the factory all go through one `IssueFolderWriter`,
  serialized per project with an async mutex. On one server two requests cannot even reach the
  ledger together; the ledger covers a second server.
- **Deriving the ledger.** If `.numbers` is absent, the writer derives `next = max(max file
  number, max projected row number, 0) + 1` and writes the ledger in the reservation step. On
  every reserve it also takes `max(file number) + 1`, so a hand-added file above the ledger is
  honoured. If the ledger is malformed, reads still work but creates are refused with
  `409 bad_number_ledger` until a person fixes it. A valid ledger below an existing file is
  corrected upward on the next reservation; CodeDen never guesses downward and never reuses a
  number.
- **Never reuse, never renumber.** A deleted file's number stays reserved for ever. Gaps are
  normal. CodeDen never changes an existing issue's number, never renames a file to a different
  number, and never merges two files.
- **Duplicate numbers.** Two files carrying the same number (a hand copy, or a merge that bypassed
  the ledger) are both reported as `duplicate_number`. Neither is projected for reading or intake;
  a previously projected row for that number is kept as the last good row and flagged. A person
  resolves it by deleting one file and, if the work is still wanted, creating a new issue (a new
  number). CodeDen never picks a winner or renumbers.
- **Missing numbers.** A gap is valid and permanent. A file added by hand with a number above the
  ledger's `next` is accepted and raises `next`; one with an unused lower number is accepted but
  CodeDen never allocates it itself. A filename number that differs from `number` is
  `number_mismatch` and malformed.
- **The ledger is ordinary repository data.** It is committed, reviewed and visible like the
  issues. A person can read it; editing it down is corrected upward on the next create (the
  max-file rule wins), and editing it up only creates gaps. It is not a secret and holds no state
  beyond `next`.
- **Path changes.** Moving `.codeden/issues` to another folder resets the source state and starts
  a new baseline; numbers may collide with the old folder and are reported as duplicates rather
  than reinterpreted. The UI warns before a folder change.

### 5.6 States and labels

- `state` and `stateReason` map directly to `GithubIssue.state` and `GithubIssue.stateReason`.
  Closing writes both fields in the same commit, so a close is never observed without its reason.
- Reopening writes `state: open`, `stateReason: null`, `closedAt: null`.
- Labels are free-form strings; there is no label catalog, color, description or creation
  endpoint. The UI derives the list from the files. Reserved labels (`codeden-factory`,
  `codeden-follow-up`, `factory:hold` and the type labels) are matched case-insensitively, as forge
  labels are; CodeDen writes them lower-case.
- Removing a label is a front matter change; there is no separate label-delete API to fail.

### 5.7 Malformed files, duplicates and missing files

A malformed file never blocks the sync of the others and never deletes rows.

| Problem | What happens |
|---|---|
| `bad_name` | The file is ignored and reported. `README.md` and `.gitkeep` are allowed; any other non-matching `.md` is reported once per scan |
| `bad_front_matter` (missing or unterminated fences, invalid YAML, duplicate key, unknown tag) | The file is ignored; a previously synced issue keeps its last good row; the problem is reported |
| `missing_field` / `bad_field` / `number_mismatch` | Same as above; the report names the field and line |
| `duplicate_number` | Neither file is read; the last good row stays; the factory skips the number |
| `bad_comment` | The issue reads, but it is flagged and skipped by the factory until fixed; comments after the bad entry are not trusted |
| `too_large` (file over 1 MiB, front matter over 64 KiB, body over 65,000 characters) | Ignored and reported |
| `unknown_field` | Warning only; the issue syncs and the field is preserved on writes |
| `missing_state_reason` (a closed issue with `stateReason: null`) | Warning only; the issue syncs, but the factory does not treat it as completed and asks a person instead |
| `too_many_files` (over 5,000 issue files or 32 MiB of them) | The scan stops at the cap and reports; issues beyond it are not read. A tracker this large is out of scope |

Problems are operational state (`IssueSourceStatus.problems`), not events; they are rebuilt from
the next scan and shown in the UI. A problem on one file never changes another issue. If a
previously valid file becomes malformed, the projection keeps the last good row so sessions,
links and factory items still resolve; the UI marks it **Needs fixing** and the factory will not
start new work on it.

A **missing folder** is not an empty folder. If the folder existed at a successful baseline and is
now absent (a bad checkout, a deleted folder), the scan reports `folder_missing`, keeps every row
and closes nothing. An **empty folder** that exists is a valid empty tracker; files removed one by
one are handled as deletions (§6.5). A folder that has never existed reads as empty and is created
on the first write.

### 5.8 Encoding, authors and timestamps

- **Encoding:** UTF-8, no BOM, LF line endings. CRLF is accepted on read and normalized on write.
  NUL bytes, invalid UTF-8 and UTF-16 are `bad_encoding`.
- **Authors:** a forge login without `@`, `local` when no login is known, or `codeden` for a
  comment or issue CodeDen writes. In comments the header shows `@login`, `local` or `codeden`.
  A UI comment made by a person on a GitHub/Forgejo project uses the connection's login; on a
  local project it is `local`. An agent's own comment through the PM tools is `codeden`, never
  the agent's provider name, so it cannot impersonate a person.
- **Timestamps:** RFC 3339 in UTC with a `Z` suffix, second precision. `createdAt` never changes.
  `updatedAt` is set by CodeDen on every write and is accepted from a hand edit; when absent, the
  file's last commit time on the default branch is used instead of the filesystem time, which is
  not stable across clones. `closedAt` follows the same rule.
- **YAML dates:** an unquoted ISO timestamp that a YAML parser turns into a date is accepted and
  normalized to a string; the example quotes it to avoid the difference between parsers.

### 5.9 Secrets: the backlog is as public as the repository

An issue file is in git. On a public repository it is readable by anyone, it is cloned by every
fork, and deleting it later does not remove it from history. The same is true of the comments and
the `author` and label fields.

**Never store in an issue file:** access tokens, passwords, private keys, `.env` contents or other
credentials; personal data about customers or users; private URLs with embedded credentials;
pre-disclosure security details; internal hostnames or plans the repository should not reveal;
screenshots or logs with any of the above. Evidence images and test artifacts belong on the pull
request (the orphan evidence branch, or Forgejo attachments), never in `.codeden/issues/`.

This is not only a leakage risk: an issue body is a prompt for an agent, so a secret written there
can reach a transcript, a PR body or a log. CodeDen does not redact issue files, and a
`.gitignore` entry does not help once a file is committed. The create dialog and the docs say so
plainly. A team that needs a private backlog uses a private repository or the forge's own issue
tracker; the folder is not a hiding place.

## 6. Synchronisation

### 6.1 Source of truth: the committed default branch

The folder sync reads the **default branch's committed tree**, not the project checkout's working
tree and not a session worktree.

- For a `github` or `forge` project, the sync fetches `origin` (no tags, no checkout, no pull) with
  a short timeout, with `GIT_TERMINAL_PROMPT=0`, and reads `refs/remotes/origin/<default>`.
- For a local project, it reads `refs/heads/<default>` (or the checked-out branch when no default
  is recorded).
- Files are read with `git ls-tree -r` and `git cat-file blob`, using the blob OID to skip files
  that did not change.
- If the fetch fails, the scan uses the last fetched remote ref and reports `stale: true`; it does
  not fall back to the working tree and it does not treat the missing data as deletions.

Why the committed branch:

- An uncommitted hand edit is not a tracker change until it is committed, so an accidental save
  cannot change the factory's input.
- A session's worktree is on a branch; its edits are ordinary files and become visible only after
  the PR merges.
- A forge API write does not move the local checkout; the next fetch does, and the projection is
  already current from the write event.
- A person on another clone sees exactly what the default branch says, not what someone's
  checkout happens to contain.

The default branch is `project.defaultBranch`, else `origin/HEAD`, else the checked-out branch.
A project with none reports `no_default_branch` and cannot use folder issues until it has one.
An unborn branch reads as empty; the first CodeDen create makes the first commit.

### 6.2 Triggers

Correctness comes from polling; the watcher is only a latency improvement.

- **Poll:** every 60 s idle, every 15 s while a folder issue has an open PR, plus a scan on server
  start and immediately after a source or folder change.
- **Filesystem watcher:** `fs.watch` on the folder in the project checkout (one watch per
  directory; not recursive on Linux), and on the repository's `.git/refs` (local commits, fetches),
  debounced 500 ms. On Windows and macOS recursive watching is used where the platform supports
  it. Watch events only schedule a scan; a missed event costs one poll.
- **Refresh after:** a project refresh, a `git pull` or fetch the user performs, a PR merge
  observed by the forge sync, and the end of any root agent turn in the project (debounced 2 s).
  A session turn can merge nothing by itself, but it can reveal a changed default branch after an
  agent pulled.
- **Manual:** the UI's Refresh button calls the same scan and reports the result.

### 6.3 The scan

1. Fetch (forge projects) and resolve the default branch. On failure, keep the projection, report
   and set `stale`.
2. `ls-tree` the folder. If the folder is missing after a baseline, report `folder_missing` and
   stop. If it is absent and this is the first scan, treat it as empty.
3. Parse each matching file in a stable order (number, then filename). A file whose blob OID and
   path match the previous scan is skipped without parsing.
4. Validate (§5.7). Malformed and duplicate files are collected as problems, not applied.
5. Diff each valid file against the projected row with the shared `diffIssue(prev, next)`.
6. On the first successful scan (or after a source/folder switch), append one silent
   `issues.synced` with every valid issue and set `baselineAt`; do not emit `issue.opened` for
   existing files.
7. Otherwise append the events `diffIssue` produced, in file order, in one transaction with their
   projections.
8. Store per-file blob OIDs, `lastSyncAt`, `baselineAt` and `lastError` in the folder sync state,
   and keep the ledger's `next` at least above every file. Problems are kept there too and
   exposed by the status API.

The scan never calls a forge issue API. A forge project's PR sync keeps running; only its issue
half is turned off when the source is `folder`. PR discovery is independent of the issue source:

- GitHub's incremental issue listing currently doubles as PR discovery; with a folder source the
  sync uses the pulls listing (conditional where possible) and its existing refresh set for open,
  session-linked and unsettled PRs, then the same batched PR fetch as today.
- Forgejo's sync currently finds changed PRs in the combined issue listing; with a folder source
  it pages the pulls listing instead. Open, session-linked and unsettled PRs are refreshed as
  before.

The PR projection, checks, reviews, mergeability and `linkedIssues` are untouched; `linkedIssues`
still comes from the PR body, which is where the folder issue link lives.

### 6.4 Events and projection

`issues.synced` is the folder analogue of `github.synced` and `forge.synced`: a silent first
import, with `{ projectId, issues }` and no PRs. It goes beside `FORGE_EVENT_PAYLOADS` in
contracts and is handled by `isGithubEvent` / `applyGithubProjection`; on replay it writes the same
rows.

After the baseline, the mapping is the existing one, produced by `diffIssue`:

| Folder change | Event | `details` |
|---|---|---|
| A new valid file | `issue.opened` | Full row |
| Labels added | `issue.labeled` | `added` names the new labels |
| Labels removed, title or body changed | `issue.updated` | `changes` names `title`, `body`, `labels`; a timestamp-only change emits nothing |
| `state` or `stateReason` changed | `issue.updated` | `changes` includes `state` and/or `state_reason`; a close is not a new event type |
| Comment count went up | `issue.commented` | The new comments, oldest first, parsed from the appendix |
| Comment count went down (a hand deletion, which CodeDen never does) | `issue.updated` | `changes: ["comments"]` |
| File removed | `issue.updated` | Synthesized close: `state: closed`, `stateReason: not_planned`; reported as `issue_file_removed` |
| File renamed, same number | none | Reported as `file_moved`; the row keeps its number |
| Malformed or duplicate | none | Reported; last good row kept |
| First scan | `issues.synced` | Silent; no notices or automations |

`issue.commented` carries a `GithubNewComment` for each new entry: a stable integer id, `author`,
`body`, the entry timestamp, a file URL with `#comment-<ordinal>`, and `fromCodeden` true when the
author is `codeden` (or the hidden marker is present, kept for parity with forge comments).
Comment bodies are truncated at 20,000 characters in the event.

The projection keys are unchanged: `github_issues` is keyed by `(projectId, number)`. The row's
`url` is built as:

- a forge project: `<forge web base>/<owner>/<repo>/blob/<default>/<folder>/<file>` (Forgejo uses
  `src/branch/<default>/...`);
- a local project: `file://` URL of the file in `project.path`.

For a local project the UI renders that URL as a path and reveals the file instead of opening a
browser. A deleted file keeps its last URL; the UI marks it removed rather than pretending the
link works.

`updatedAt` is the front matter value, else the file's last commit time. `createdAt` is the front
matter value, else the first commit that added the file, else `baselineAt`. `closedAt` is the
front matter value, else the first scan time at which `state: closed` was seen (stored in folder
state).

### 6.5 Edits, deletions and worktrees

- **A session worktree** branches from the fetched default branch, so it sees the issue files as
  they were at that commit. New issues created later are not in an existing worktree, just like
  new code.
- **An agent editing an issue file** is editing an ordinary file in its branch. The change does
  nothing until the PR merges. It appears in the PR's diff and is reviewed like any other file.
  Role prompts tell sessions not to edit issues as part of their work. The factory's existing
  rule that `.codeden/**` is an always-protected area already means a factory PR that changes
  `.codeden/issues/**` is escalated to a person, never auto-merged.
- **A merged edit** is applied by the next scan, producing the events above. That is the intended
  approval path: a merged change is a person's review.
- **A merged deletion** closes the issue in the projection with `stateReason: "not_planned"` and
  keeps the row, so old session, notice and factory links still resolve. The number is never
  reused. If a file with the same number appears again, its front matter wins and may reopen the
  issue; CodeDen reports the reappearance.
- **An unmerged deletion** is invisible.
- **An agent that edits a file in the main checkout without committing** changes nothing until it
  is committed; the UI may show the file as modified in git, not as an issue change.

### 6.6 Two people

Git already handles two people editing. The server's writes use compare-and-swap, so two CodeDen
instances do not overwrite each other; the second re-reads and retries. Two hand edits that touch
the same lines are a normal merge conflict for a person to resolve. CodeDen never force-pushes,
never picks a side and never resolves a conflict in an issue file automatically.

## 7. The issue lifecycle on pull requests

### 7.1 Linking a PR to a folder issue

CodeDen reuses `closingIssueNumbers` (the `Fixes`/`Closes`/`Resolves` parser already used by the
GitHub and Forgejo sync) and adds a machine trailer for folder issues:

```markdown
Fixes #42

<!-- codeden-issue: 42 -->
```

- The trailer is always written for a folder issue. It is what CodeDen reads.
- `Fixes #42` is written too when the forge reports that the repository has no issue tracker
  (`hasIssues === false`), which is the motivating fork. Then it is harmless: there is no forge
  issue #42 to close.
- When the forge still has issues enabled, a bare `Fixes #42` could close an unrelated forge
  issue #42. CodeDen therefore omits the bare keyword for its own PRs and writes a visible line
  with the file path instead:

  ```markdown
  Issue: #42 (file-backed: `.codeden/issues/0042-export-monthly-report-as-csv.md`)
  ```

  A hand-written `Fixes #42` on a folder project is still parsed as a link; the PR view warns that
  the forge may have closed its own #42. The project page recommends turning the forge issue
  tracker off, or accepting the ambiguity knowingly.

This keeps the GitHub/Forgejo parsers working for human PRs while making CodeDen's own link
unambiguous.

### 7.2 Who closes the file, and when

After a PR merges, the forge sync emits `pr.merged`. The folder service, listening to the same
event the factory and notices already use, checks the project's source and each linked issue:

1. If the source is `folder`, the issue exists and is open, and the PR is merged into the default
   branch, write `state: closed`, `stateReason: completed`, `closedAt`, append the PR number to
   `pullRequests`, and set `updatedAt`, in one commit on the default branch.
2. Append the matching `issue.updated` event with the returned row, so the UI and the factory see
   the close at once. The next scan sees the same state and emits nothing.
3. If the write fails (branch protection, a moved head, an offline forge, a read-only token), keep
   a pending close in the folder state and retry on every sync tick with backoff. Report it in the
   inbox (`issue_close_failed`) if it is still failing after the first retries. A merged PR is
   never lost because the issue file could not be written.
4. If the issue is already closed, or the file is gone, or the source changed since the PR was
   opened, do nothing and report the reason. Never reopen a closed issue on merge.

Closing is idempotent: the same `pr.merged` seen twice produces at most one commit and one event.

### 7.3 PR closed without merging

Nothing changes in the issue. The `pullRequests` hint stays as written; the forge is authoritative
for PR state. A revert does not reopen the issue: a person reopens the file or files a new issue,
so the history of the original decision stays honest.

### 7.4 Factory and GitHub's own closing

- The factory reads the issue before a PR exists; nothing about folder issues changes that. It
  creates a PR on the forge, the agent links it, and the merge path above closes the file.
- A `folder` project has no forge issue for GitHub to close. GitHub's `Fixes #N` has nothing to
  act on when issues are disabled; when issues are enabled, §7.1's rule avoids an accidental
  close.
- `mergedPrClosing` (the factory's "which merged PR closed this?") sees the same `linkedIssues`
  projection; for folder issues the PR is a normal forge PR, so the existing settle logic works.
- `stateReason: completed` lets a merged folder issue settle a factory item as `merged`
  (`completed`), while `not_planned` settles it as `rejected`, exactly as GitHub's reason does. A
  closed folder issue with no reason is not evidence that the work is done: it stops the item and
  asks a person, the same fail-closed rule Forgejo needs because it cannot record a reason
  ([forges.md](forges.md) §5.4).

## 8. Writes and flows

### 8.1 One write path

All CodeDen-initiated changes go through one per-project writer:

1. Take the project mutex.
2. Read the current default branch head and the target file's blob.
3. Build the new file from the current content (never from a stale cached copy).
4. Commit it on the default branch with a conventional message:
   - `codeden: reserve issue #42` (create only, before the issue file)
   - `codeden: add issue #42 <title>`
   - `codeden: comment on #42`
   - `codeden: triage #42`
   - `codeden: edit #42`
   - `codeden: close #42 (PR #57)`
5. On a head/blob mismatch, re-read and retry from step 2, at most three times.
6. On success, append the event and update the projection in the same local transaction as the
   event; a later scan is a no-op.

The transport is the project's:

- **GitHub:** the Contents API (`createOrUpdateFileContents`) with the old blob `sha` on update.
  This writes one commit to the default branch without needing a clean checkout.
- **Forgejo:** `putFile` in `services/forge/forgejo/contents.ts`, with the same `sha` behaviour.
- **Local:** if the project checkout is on the default branch, refuse when the target file has
  uncommitted changes, then write it and commit only that path; unrelated staged work is not
  included, and a failing git hook is reported rather than bypassed. If the checkout is on another
  branch or detached, create a temporary detached worktree at the default head, write and commit
  there, move the default branch with a compare-and-swap (`update-ref <ref> <new> <old>`), then
  remove the worktree. A branch is never moved out from under a checkout that has it checked out,
  and the user's index and working tree are not rewritten.

After a forge write, the service asks for a fetch and, only if the project checkout is clean and
on the default branch, fast-forwards it. Otherwise the file appears on the next pull; the UI reads
the projection, not the checkout, so nothing waits for it.

A write is rejected before it starts when the project is not a git repository, the forge is not
connected for a forge-backed PR project's source (not relevant for folder reads), the token is
read-only, or the repository is read-only. The UI disables the action with the reason.

### 8.2 Create

`create_issue` (the PM tool) and the New issue dialog call the same service. It allocates a
number (§5.5), renders the file (title, body, labels, `author` from the connection login or
`local`, `createdAt`/`updatedAt` now, `state: open`), commits, and returns the projected issue.
The file is `NNNN-<slug>.md`; the slug is derived from the title, lower-cased, non-alphanumerics
collapsed to `-`, 1 to 60 characters, and defaults to `issue`. It never changes when the title is
edited.

The UI warns that the issue will be committed to the default branch and is as public as the
repository. A duplicate submit is prevented while the request is in flight; an optional client
request id can make retries idempotent, but the CAS retry itself only re-applies after a conflict
and never allocates two numbers.

### 8.3 Comment

A comment appends one entry to the end of the appendix and commits (message `codeden: comment on
#42`). The writer serializes, so two comments on one server queue. If the file changed under the
write, it re-reads and appends to the new end; it does not merge the other writer's text and does
not rewrite existing entries.

If the retry still fails, the API returns `409 issue_write_conflict` and the UI keeps the draft,
with a Retry action. A comment is never written only to SQLite: the file is the tracker, and a
comment only in CodeDen would disappear from the repository.

### 8.4 Label, triage and close

A triage decision is **one commit**, not three API calls:

- add and remove labels;
- optionally append the triage comment;
- optionally set `state: closed` and `stateReason`: `not_planned` unless the decision is `ready`
  (then `completed`), exactly as the GitHub path does today. The format admits `duplicate`; a hand
  edit or a later change can use it, but folder triage does not diverge from forge triage by
  default;
- set `updatedAt` and `closedAt`.

One commit means a reader never sees labels applied but the comment missing, or a close without
its reason. The events are still emitted per change (`issue.labeled`, `issue.commented`,
`issue.updated`) in the same append, so automations see what they see for a forge issue.

`factory_hold_issue` and `factory_release_issue` are label writes through the same path. Removing
a label that is absent is not an error, as it is for the forge.

### 8.5 Editing

The UI's issue detail can PATCH `title`, `body`, `labels`, `state` and `stateReason`; the number,
`createdAt` and the filename are immutable. The server sets `updatedAt` and commits
(`codeden: edit #42`). An optional `expectedUpdatedAt` (or blob sha) makes a concurrent edit show
"changed since you opened it" instead of overwriting it.

By hand, a person edits the Markdown and commits. The next scan applies it. Rules:

- Keep the number and filename stable; a change to both is a deletion and a new issue.
- Keep the front matter fences; a missing or broken fence is `bad_front_matter`.
- Unknown keys are preserved by CodeDen; labels, state and title behave as in the UI.
- A hand edit is not special-cased: it is the same parse as any other commit.

### 8.6 PM tools and what they do

No new tools. The existing tools keep their names and inputs and dispatch on the source:

| Tool | Folder behaviour |
|---|---|
| `list_issues` | Reads `github_issues`; same filters and limit |
| `get_issue` | Reads the row and the latest comments from the file (up to 20) |
| `create_issue` | Allocates, writes and commits the file |
| `triage_issue` | One commit as in §8.4; returns the file URL as the comment URL |
| `start_session` | Uses the issue ref (`url` is a blob or `file://` URL) exactly as today |
| `attach_evidence` | Targets the PR (folder issues have no forge conversation); with no PR it fails and says evidence needs a pull request |

`inIssueTrackingProject` becomes `inIssueProject`: true for a forge project, and for a folder
source on any git-backed project, including local. At that point `list_issues`, `get_issue`,
`create_issue` and `triage_issue` are listed for a local project with folder issues. PR, merge and
evidence tools stay behind `isForgeProject` / `inGithubProject`.

### 8.7 Failure modes

| Situation | Behaviour |
|---|---|
| Push/commit rejected by branch protection or a moved head | Re-read, retry up to three times, then `409 issue_write_conflict`; nothing is projected; the text stays in the UI |
| The file changed under the write | The CAS/retry reads the new file and re-applies; a hand edit that made it malformed stops the write with `409 issue_malformed` and the path, and CodeDen does not overwrite it |
| Read-only repository or token | `403 repo_read_only` / `forge_forbidden`, with the reason; write actions are disabled in the UI. No local-only fallback pretends the write succeeded |
| Branch protection requires a pull request or a signed commit | The direct commit is refused; report it with the forge's message and keep the draft. Folder writes need a branch where the CodeDen account may commit directly (or a convention that the bot is exempt); CodeDen never weakens protection itself |
| Forge unreachable | Create/comment/edit fail visibly. Merge-close is queued and retried, because the merge already happened |
| No default branch | `409 no_default_branch`; reads are empty and writes are refused until the branch exists |
| Source switched while a write is in flight | The writer re-reads the project; if the source is no longer `folder`, it aborts with `409 issue_source_changed` and projects nothing |
| Two servers allocate the same number | The ledger's CAS fails for one of them; it re-reads and reserves the next number. A duplicate that still reaches the branch through a hand copy or a direct edit is reported and hidden from intake |
| Server restarts mid-write | A forge write is a single commit. A local write is one commit, or none; a reservation may leave a gap. A write that did not land is absent, the next scan sees the truth, and a landed write is idempotent to re-apply |
| Folder is temporarily unreadable | Keep the last good projection, set `stale`, report; never treat it as empty |

## 9. Factory and autonomy

Folder issues enter the existing factory with no second loop:

- **Intake.** `ctx.github.openIssues(project.id)` still reads the projection. The folder sync
  fills it. `takenIn` still takes an issue whose `createdAt` is after `enabledAt` or that has the
  `codeden-factory` label in its front matter. Files present at a silent baseline are old news:
  they are not taken merely because the source was switched on, so label them for the factory or
  let a person admit them.
- **Trust.** Every valid issue in the default branch is trusted, because a merged change is a
  person's approval. `trustedAuthors` is not consulted for folder intake; `author` is displayed and
  never grants anything by itself. An untrusted PR cannot add a runnable issue: the file only
  becomes an issue after the PR merges. This is the repository's own review process standing in
  for the forge's `authorAssociation`.
- **Label equivalent.** `codeden-factory` is a normal front matter label. Type labels and
  `factory:hold` are too; the factory's label writes become file commits, and its hold/release
  tools work unchanged.
- **Priority and overlap.** The item's title, summary and acceptance criteria still come from the
  issue body; overlap estimation and queue ordering are unchanged. Malformed or duplicate files
  are skipped by intake and never spend a model call.
- **Comments.** Classification announcements, specs and factory comments are appended to the file
  by the same writer, with `author: codeden` and the existing hidden marker so automations do not
  treat CodeDen's own comment as a person's. Long factory text is trimmed to the comment limit and
  the truncation is noted.
- **Merge and close.** The PR is still a forge PR, so evidence, checks, review and the merge queue
  are unchanged. A merged PR closes the file (§7.2), and the factory's `closed-issues` logic sees
  `stateReason: completed` and the merged PR exactly as it does for GitHub. A close with
  `stateReason: null` is a person's decision to reopen or explain, never a completed item.
- **Issue text is still data.** Trust decides whether work may start; it does not make the file's
  prose instructions. Factory briefs keep framing issue text and comments as data, as they do
  today, because a maintainer can merge a file whose body contains prompt injection.
- **Trust lookups that read the forge.** For a folder issue, `issueAuthor` answers trusted without
  a call, `commenters` reads the file's appendix, and only PR reviews and PR comments use the
  forge. The factory's "nobody untrusted commented on this" check therefore has no untrusted
  issue comments to find: a comment is in the file only because a merged change put it there.
- **Inbox.** A new file issue produces the ordinary `issue.opened` notice; its link opens the blob
  (or reveals the file for a local project). Malformed files are a source problem, not an inbox
  item per file; the project page and issue tab show them.
- **Local project.** A local project can use folder issues for triage and sessions, but it has no
  PR forge, so entering a factory mode is refused (`400 factory_needs_forge`): there is nothing to
  merge. Its triage and session tools still work. A local project that later gains a GitHub remote
  keeps its files and gains the factory.
- **Forgejo.** A Forgejo project with folder issues uses Forgejo only for PRs, evidence and checks.
  The Forgejo factory capability gates in [forges.md](forges.md) §9 still apply; the issue half is
  already provider-neutral.

## 10. UI

The existing issues tab is kept; it learns where its rows come from.

- **The source label.** At the top of the tab:
  - forge source: `Issues: GitHub` or `Issues: Forgejo`, with the connection state as today;
  - folder source: `Issues: files in .codeden/issues`, with the absolute path on hover, the file
    count, and the last scan time;
  - a local project left on the default: `No issue source`.
- **The list** shows open/closed, labels, author, comment count and linked sessions exactly as it
  does for forge issues. A folder row's external-link action opens the blob on the forge; for a
  local project it reveals the file in the editor or copies its path.
- **Create** opens the same dialog, with the public-backlog warning (§5.9). **Triage** and label
  actions are enabled when the folder is writable and disabled with the reason when the token or
  checkout is read-only.
- **Detail.** A folder issue shows its path, its front matter state and a **View file** action.
  Comments are rendered from the appendix and are read-only in CodeDen; editing happens through
  the issue editor or the file. A missing file is marked **Removed from the source**; the row stays
  for history.
- **Problems.** A banner lists malformed files and duplicate numbers with the path, the field and
  the reason, and a **Copy path** action. It never blocks the list. A **Refresh** action reruns the
  scan. A stale scan says "Showing the last successful scan; the folder could not be read".
- **Pull requests.** The PR half of the panel keeps its forge label. On a local project with folder
  issues the PRs section says "No pull requests: this project has no forge", not "not connected".
- **Factory.** The factory panel and inbox show folder issues as ordinary issues; the source label
  and file links are the only difference.

The issues response gains an `IssueSourceStatus` (source, folder, writable, stale, problems,
lastSyncAt, lastError) and the issue response's forge `connection` becomes nullable; the PR
response keeps its connection shape. Old clients are not a concern because the server serves the
bundled UI.

## 11. Phases

Each phase is one PR unless split as noted, and leaves the product working. Capabilities are off
until their phase lands.

| Phase | Slice | Acceptance criteria |
|---|---|---|
| **0** | Contracts + parser (the first PR) | `Project.issues` and the source helpers; `IssueSourceSettings`, `IssueSourceStatus`, `IssueFileProblem`; a strict front-matter/body/comments parser and renderer; number/ledger/slug helpers; tests for a round trip, ledger derivation, duplicate and missing numbers, malformed files, comments with heading-like lines, CRLF and unknown keys. No runtime, no migration, no UI |
| **1** | Read-only sync + UI/PM reads | Project DB column and folder sync state; `IssueFolderSync` reading the default branch with fetch/fallback/stale handling; `issues.synced`, `diffIssue` reuse and projection; deletion closes; duplicate/malformed reports; `list_issues` and `get_issue` for folder projects; issues tab source label, problems and local-project state. No issue writes (create/triage/comment disabled with a reason) |
| **2a** | Writes: create and comment | Number allocation with CAS retries; create and comment on the default branch through GitHub, Forgejo and local; events/projection; New issue dialog; PM `create_issue`; comment drafts survive a failed write |
| **2b** | Writes: label, triage, close, edit | One-commit triage with labels, comment and reason; label/hold tools; close/reopen; edit title/body/labels; UI triage and edit; read-only refusals; conflict and malformed handling |
| **3** | Merge-close | `Fixes`/`Closes` plus the trailer; PR body rule for forge-issues-enabled repositories; `pr.merged` closes the file once; pending-close retry queue and inbox item; factory settle sees the reason; tests for idempotency, failure and source switch |
| **4** | Factory intake | Folder issues trusted from the default branch; `codeden-factory` and `factory:hold` labels; intake skips malformed/duplicates; scout files issues as files; factory refused for a local project with a clear reason; a Forgejo folder project still uses forge PR gates |
| **5** | Docs and polish | `docs/issue-sources.md` linked from the docs; user guide for authors, comments and migration; DESIGN wording applied by the owner; the `docs/forges.md` note; no changelog fragment for this docs-only PR, one for each user-facing phase |

**The first PR we could merge is phase 0:** contracts plus the parser and its tests, with no
runtime wiring, no migration and no UI. It locks the format, the number rules and the event shape
before anything writes a file. Phase 1 is the first visible result (an existing folder appears in
the issues tab); phase 2a is the first write.

## 12. Risks and open questions

| Risk / question | Recommendation |
|---|---|
| **Numbering races** | One server writer per project plus a committed `.numbers` ledger; reservation is a compare-and-swap, so a second server retries instead of handing out the same number. Never reuse or renumber. A hand copy that bypasses the ledger is reported as a duplicate, not auto-resolved |
| **Comments causing merge conflicts** | Append-only appendix, serialized writes and CAS retries; CodeDen never merges or resolves conflicts in an issue file. Two hand editors resolve a git conflict like any other file. A persistent conflict is a `409` with the draft kept |
| **Issue files in PR diffs** | Treat them as ordinary reviewed files and tell sessions not to edit them. Unmerged edits are invisible; merged edits apply. The factory already escalates changes under `.codeden/**`, so a factory PR that edits issues needs a person |
| **Repo bloat** | Text only, 1 MiB per file, a 5,000-file/32 MiB scan cap, no images or attachments. Comments rewrite the whole file per commit, so a very long comment history is a real cost; a sidecar comment format is a deliberate later option, not part of this design |
| **Public/private backlog** | The folder is as public as the repository and its history. Never store secrets, customer data, private URLs or pre-disclosure details. Sensitive work uses a private repo or the forge tracker; the UI warns and the docs repeat it |
| **Two people editing** | Git semantics plus CAS for CodeDen writes; a hand conflict is a person's to resolve. No force-pushes, no silent overwrite |
| **Migrating an existing GitHub-issues project** | Switching source starts clean: no import, no event rewrite, old rows reset. Export first if the history matters. A one-off `codeden issues export` command is a later, explicit tool, not part of the switch |
| **Folder outside the repository** | Out of scope and recommended to stay that way: it would break worktree visibility, the default-branch trust rule and the "merged change is approval" model. A different source type would need its own trust design |
| **Deleting a file** | Treat a committed deletion as a close (`not_planned`) and keep the row, rather than silently forgetting the issue or reusing its number. A missing folder is an error, not a mass deletion |
| **Forge issues still enabled** | `Fixes #N` could close an unrelated forge issue. Use the hidden trailer and omit the bare keyword for CodeDen's own PRs; warn on hand-written ones; recommend disabling the forge tracker |
| **Local project with folder issues** | Allowed for triage and sessions, refused for factory modes because there is no PR. A local project that gains a forge keeps the files and gains the factory |
| **Default branch versus working tree** | Read the committed default branch only. Uncommitted edits are intentionally invisible; a lost uncommitted edit is a git problem, not a tracker change. The scan reports stale data instead of falling back |
| **Performance** | Blob OIDs skip unchanged files; a fetch per poll is the cost of seeing other people's commits. The 60 s/15 s intervals and the file caps bound it. A huge backlog is out of scope |
| **Synthetic URLs and comment ids** | Blob URL when a forge exists, `file://` for a local project; comment ids are hashed from immutable entry data and anchors use the ordinal. Never fabricate a GitHub issue URL |
| **Author spoofing** | `author` is display metadata, not trust. Trust comes from the default branch. A person can write any login in a file, and it changes nothing security-wise |
| **A merge-close that cannot write** | Keep a pending close, retry each tick with backoff, and raise an inbox item after the first retries. A merged PR is never lost because the issue file was not updated |
| **A closed file with no reason** | CodeDen's closes always write a reason. A hand close without one is a warning and the factory stops the item for a person, never treats `null` as completed. This matches the Forgejo capability gate rather than GitHub's permissive `!stateReason` check |
| **Branch protection on the default branch** | Folder writes are direct commits, so a branch that requires a pull request or a signed commit refuses them. The failure is reported with the forge's own message; CodeDen never bypasses protection. A project that needs protected branches should keep the forge issue source or exempt a bot |
| **The reservation ledger's extra commit** | Two commits on create and a tiny metadata file in the folder. This is the price of safe numbering across clones; it is bounded (one extra commit per issue) and invisible to readers. If it becomes noise, a forge-side reservation is a later optimization |
| **Windows and line endings** | UTF-8/LF canonical, CRLF accepted; commit only the issue path when the default branch is checked out, and use a temporary detached worktree when it is not; paths are repository-relative, not OS-absolute |
| **Issue source and `kind` drift** | A folder source does not follow detection. Losing the forge remote makes a project local but keeps its files; gaining a forge keeps its files and adds PRs. Only a person changes the source |
| **Contract names** | Keep `github_issues`, `GithubService` and `github_*` error codes to avoid a mechanical rename with no user value ([forges.md](forges.md) §3). Add neutral aliases only where a payload is new |

Open questions with a recommended default:

- **Should an issue file be able to reference an attachment?** Recommend no in this design:
  images belong on the PR/forge, and a linked path inside the repository would still be public.
  Add attachments only with a separate, explicit design.
- **Should comments eventually move out of the issue file?** Recommend keeping them there until
  write amplification is measured; if a real project hits it, a per-issue comment sidecar with a
  stable link is the next step.
- **Should CodeDen offer an import from forge issues?** Recommend not automatically. A one-off
  export command that creates files with fresh numbers is safer than pretending the numbers are
  the same.
- **Should `folder` be allowed on a project that is not a git repository?** Recommend no: the
  whole trust and worktree story depends on commits. A plain folder could be a later, separate
  source with a different trust model.

## 13. Proposed `docs/DESIGN.md` wording (not applied)

These are the edits the owner would approve. They are intentionally small: the source is one
setting, and `kind` keeps its meaning.

### 13.1 Status line

Add to the status note at the top of `docs/DESIGN.md`:

> File-backed issues ([issue-sources.md](issue-sources.md)) were proposed on 2026-11-23; the issue
> source of a project is independent of its pull request forge.

### 13.2 §3 locked decisions

**Row “Projects” (old):**

> | Projects | GitHub repos, and opt-in self-hosted Forgejo repos ([forges.md](forges.md)), get the issue/PR flow; Forgejo evidence, the factory and auto-merge are capability-gated. **Local-only folders are supported** without forge features |

**New:**

> | Projects | GitHub repos, and opt-in self-hosted Forgejo repos ([forges.md](forges.md)), get the pull request flow; a project's issues come from its forge or from a folder in the repository ([issue-sources.md](issue-sources.md)), independently. Forgejo evidence, the factory and auto-merge are capability-gated. **Local-only folders are supported** without forge features, and may use folder issues |

**Row “Forges” (old):**

> | Forges | **GitHub and self-hosted Forgejo** (Gitea-compatible REST API v1). GitHub is the default and keeps every feature; a Forgejo project is opt-in, read-only first, with the factory, evidence and vision behind capability gates ([forges.md](forges.md)). No other forge in v1 |

**New:**

> | Forges | **GitHub and self-hosted Forgejo** (Gitea-compatible REST API v1) for pull requests; issues may also come from files in the repository ([issue-sources.md](issue-sources.md)). GitHub is the default and keeps every feature; a Forgejo project is opt-in, read-only first, with the factory, evidence and vision behind capability gates ([forges.md](forges.md)). No other forge in v1 |

### 13.3 §9

Add this bullet after **Forge APIs** and before **Sync**:

> - **Issue sources.** A project's issues come from its forge (`issues.source: "forge"`, the
>   default) or from Markdown files in `.codeden/issues/` in the repository (`issues.source:
>   "folder"`, [issue-sources.md](issue-sources.md)). Pull requests always use the project's
>   forge. The server is the only writer: it commits issue files to the default branch, parses them
>   into the same issue projection and `issue.*` events, and closes one when a linked PR merges. A
>   file on the default branch is trusted like the repository's writers, because a merged change is
>   a person's approval. A `folder` project calls no issue API on its forge.

Replace the **Local-only projects** bullet (old):

> - **Local-only projects** (no supported forge remote) get sessions, worktrees, checkpoints, diffs and automations, but no issue, PR or evidence flow.

New:

> - **Local-only projects** (no supported forge remote) get sessions, worktrees, checkpoints, diffs
>   and automations, and may use file-backed issues ([issue-sources.md](issue-sources.md)), but no
>   pull request or evidence flow.

### 13.4 §10.1

**The software factory paragraph (old):**

> **The software factory.** Issues are created outside CodeDen (by you, teammates, or any tool that files issues on the project's forge). A repository on a supported forge is required: GitHub, or a self-hosted Forgejo instance ([forges.md](forges.md)). GitHub is the default; Forgejo factory support is opt-in and capability-gated.

**New:**

> **The software factory.** Issues are created outside CodeDen (by you, teammates, or any tool that
> files issues), either on the project's forge or, when the project uses file-backed issues, as
> Markdown files in the repository ([issue-sources.md](issue-sources.md)). A repository on a
> supported forge is still required for pull requests: GitHub, or a self-hosted Forgejo instance
> ([forges.md](forges.md)). GitHub is the default; Forgejo factory support is opt-in and
> capability-gated. A local project can use file-backed issues for triage and sessions, but it has
> no factory loop because it has no pull requests.

**Trust paragraph, after the existing trust rule (add):**

> File-backed issues are trusted because they are on the default branch: a merged change is a
> person's approval, so intake takes them without a `trustedAuthors` check. The file's `author` is
> shown but never trusted by itself, and an untrusted pull request cannot add a runnable issue
> without being merged.

### 13.5 `docs/forges.md`

Add this note under the status block at the top:

> **Note (2026-11-23):** the issue source is now decoupled from the forge
> ([issue-sources.md](issue-sources.md)). A project may take its issues from files in the
> repository while its pull requests stay on the forge. This document's issue sync, issue writes
> and issue trust rules apply when the project's issue source is its forge; the forge port, PR
> flow, checks, merge and evidence are unaffected.

### 13.6 What the owner should know

- The named edits are §13.2 (the Projects and Forges rows), §13.3 (the new §9 bullet and the
  local-only bullet) and §13.4 (the factory paragraph and the trust sentence). Without the
  local-only bullet the document would say a local project has no issues while this design gives
  it some.
- The status line is a record, not a decision: the design only becomes locked when the owner
  applies these words.
- The setting is additive and defaults to today's behaviour. No project, event or API response
  changes meaning until someone chooses `folder`.
- The biggest unresolved product question is not technical: a public repository's file backlog is
  public, including its history. Teams that expect a private tracker should stay on the forge or
  use a private repository.

## 14. References

- `packages/contracts/src/entities/project.ts` (`kind`, `forgeOf`, `isForgeProject`).
- `packages/contracts/src/github.ts` (`GithubIssue`, `GithubNewComment`, `GITHUB_EVENT_PAYLOADS`,
  `FORGE_EVENT_PAYLOADS`, the issue HTTP shapes).
- `apps/server/src/services/github/projection.ts`, `sync.ts`, `diff.ts`, `rows.ts`.
- `apps/server/src/services/forge/` (`GithubService`'s forge delegation, Forgejo issue writes and
  `putFile`).
- `apps/server/src/services/factory/intake.ts`, `trust.ts`, `closed-issues.ts`,
  `github-port.ts`, `vision.ts`.
- `apps/server/src/services/automations/triage.ts`.
- `apps/server/src/mcp/tools/pm/github.ts`, `apps/server/src/mcp/tools/github/available.ts`.
- `apps/web/src/components/github/project-github.tsx`.
- [forges.md](forges.md) for the forge port, phases and trust rules.

## 15. What this document does not decide

- The exact TypeScript names of the helpers and the `IssueSourceStatus` fields; the shapes in this
  document are illustrative and will be fixed in phase 0.
- Attachments or images inside issue files; evidence stays on the PR.
- Threading, reactions, assignees, milestones, issue templates and issue forms.
- Multiple issue folders, or reading forge issues and folder issues at the same time. A project
  has one source.
- An import tool from forge issues; it is a deliberate later option.
- Real-time collaborative editing of an issue file; the file and the CAS write are the contract.
- Webhooks for issue-file changes; polling and the watcher are enough for a local checkout.
