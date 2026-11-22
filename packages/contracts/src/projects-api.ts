import { z } from "zod";
import { ProjectDetection } from "./api";
import { Project } from "./entities/project";
import { ProjectCheck } from "./project-config";

/**
 * Re-detecting a project's git checkout and GitHub remote (§9). A project's kind is first
 * decided when it is added; these shapes cover checking again later, so a folder that gains a
 * git checkout or a GitHub `origin` after it was added catches up.
 */

/**
 * What a re-detection found:
 * - `unchanged`: nothing new (the message says what is still missing, if anything).
 * - `git_detected`: the folder became a git checkout (`Project.isGitRepo`); its default branch
 *   is recorded so worktrees work. Still no GitHub remote.
 * - `git_missing`: a local project's folder isn't a git repository any more
 *   (`Project.isGitRepo` false): its new sessions run in the project folder.
 * - `github_connected`: a local project gained a GitHub `origin` and is now a `github`
 *   project, or a GitHub project's missing remote is back.
 * - `github_changed`: the GitHub remote moved (another owner or repository, or another URL).
 *   Another repository restarts the issue and PR sync from scratch.
 * - `github_remote_missing`: a GitHub project's folder has no GitHub `origin` any more. The
 *   project keeps its coordinates and carries a `remoteWarning`; nothing is downgraded.
 * - `forge_connected`: a local project gained an `origin` its configured Forgejo connection
 *   matches and is now a `forge` project, or a forge project's missing remote is back.
 * - `forge_changed`: a forge project's remote moved (another repository on the same forge set up
 *   in CodeDen, or another URL); its coordinates follow it.
 * - `forge_remote_missing`: a forge project's folder no longer has a matching `origin`, or it now
 *   points at another forge. The project keeps its coordinates and warns; never downgraded.
 * - `folder_missing`: the project folder is gone or unreadable; nothing was changed.
 */
export const ProjectRefreshOutcome = z.enum([
  "unchanged",
  "git_detected",
  "git_missing",
  "github_connected",
  "github_changed",
  "github_remote_missing",
  "forge_connected",
  "forge_changed",
  "forge_remote_missing",
  "folder_missing",
]);
export type ProjectRefreshOutcome = z.infer<typeof ProjectRefreshOutcome>;

/** `POST /api/projects/:id/refresh` response. */
export const RefreshProjectResponse = z.object({
  /** The project after the check (unchanged unless `changed`). */
  project: Project,
  outcome: ProjectRefreshOutcome,
  /** True when the check updated the project (a `project.updated` event was appended). */
  changed: z.boolean(),
  /** One line for the UI, e.g. "Connected to octo/app" or "Still no GitHub remote on origin". */
  message: z.string(),
  /** What was found in the folder; null when the folder is missing. */
  detected: ProjectDetection.nullable(),
});
export type RefreshProjectResponse = z.infer<typeof RefreshProjectResponse>;

/**
 * `POST /api/projects/:id/disconnect-github` response: the project, now `local`. Allowed only
 * when the folder has no GitHub `origin` (otherwise the next check would connect it again,
 * `409 github_remote_present`) and the project is not in a factory mode (`409 factory_mode`).
 * The synced issues and pull requests stay in the database.
 */
export const DisconnectGithubResponse = z.object({ project: Project });
export type DisconnectGithubResponse = z.infer<typeof DisconnectGithubResponse>;

/**
 * `POST /api/projects/:id/disconnect-forge` response: the project, now `local`. Allowed only
 * for a `forge` project (`409 not_a_forge_project` otherwise) and refused while the project is
 * in a factory mode (`409 factory_mode`, which needs a GitHub project). The project's `forge`
 * coordinates and any `remoteWarning` are cleared; synced issues and pull requests, if any,
 * stay in the database.
 */
export const DisconnectForgeResponse = z.object({ project: Project });
export type DisconnectForgeResponse = z.infer<typeof DisconnectForgeResponse>;

/**
 * `GET /api/projects/:id/checks` response: the project's checks (§9 Project checks) as a new
 * session would freeze them now, read from `.codeden/project.json` in the project's own folder.
 * Empty when the file is missing, invalid or has none, so the UI offers "Keep going until
 * checks pass" only when there is something to run.
 */
export const ProjectChecksResponse = z.object({ checks: z.array(ProjectCheck) });
export type ProjectChecksResponse = z.infer<typeof ProjectChecksResponse>;
