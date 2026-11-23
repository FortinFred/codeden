import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * File-backed issues (`docs/issue-sources.md`): where a project's issues come from, the folder
 * setting and the operational state a scan reports. The issue file model, its parser, renderer,
 * names and numbering ledger live in `./issue-file`; this module has no Node APIs either.
 */

// ---------------------------------------------------------------- settings

/** Default repository-relative folder for file-backed issues (§5.1). */
export const DEFAULT_ISSUE_FOLDER = ".codeden/issues";

/** Where a project's issues come from (§4.1). Default: its forge, as before this setting existed. */
export const IssueSource = z.enum(["forge", "folder"]);
export type IssueSource = z.infer<typeof IssueSource>;

/**
 * What a project's issues resolve to once its kind and settings are applied (§4.3):
 * `forge` for a GitHub or Forgejo connection, `folder` for files in the repository, and `none`
 * for a local project left on the default source. UI and orchestration read this, never `kind`.
 */
export const IssueSourceKind = z.enum(["forge", "folder", "none"]);
export type IssueSourceKind = z.infer<typeof IssueSourceKind>;

/**
 * Why a repository-relative issue folder is not usable, or null when it is (§4.1). Absolute
 * paths, home paths, drive letters and `..` are refused: the folder must be inside the
 * repository, because commits are what make its issues trusted.
 */
export function issueFolderProblem(folder: string): string | null {
  const value = folder.trim();
  if (!value) return "it is empty";
  if (/^[\\/]/.test(value)) return "it must be repository-relative, not absolute";
  if (/^[A-Za-z]:/.test(value)) return "it must be repository-relative, not a drive path";
  if (/^~([\\/]|$)/.test(value)) return "it must be repository-relative, not a home path";
  if (/\p{Cc}/u.test(value)) return "it must not contain control characters";
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return "it must name a folder inside the repository";
  if (segments.includes("..")) return "it must not contain `..`";
  return null;
}

/**
 * The canonical form of an issue folder: forward slashes, no leading `./`, no doubled or
 * trailing slashes. Callers validate with `issueFolderProblem` first.
 */
export function normalizeIssueFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * The absolute path of the issue folder inside a project, or null when the folder setting is
 * invalid (§4.1). The separator follows `projectPath`, since this is display and filesystem
 * work, not repository-relative data.
 */
export function resolveIssueFolderPath(projectPath: string, folder: string): string | null {
  if (issueFolderProblem(folder)) return null;
  const windows =
    /^[A-Za-z]:[\\/]/.test(projectPath) ||
    (projectPath.includes("\\") && !projectPath.includes("/"));
  const base = projectPath.replace(/[\\/]+$/, "");
  const segments = normalizeIssueFolder(folder).split("/");
  return [base, ...segments].join(windows ? "\\" : "/");
}

/**
 * Where a project's issues come from (§4.1). `folder` is repository-relative and only meaningful
 * when `source` is `folder`; it is ignored (but kept) on a forge source, so switching back and
 * forth does not lose it. The defaults make every `project.created`/`project.updated` payload
 * written before this setting existed parse as `{ source: "forge", folder: ".codeden/issues" }`.
 */
export const IssueSourceSettings = z.object({
  source: IssueSource.default("forge"),
  folder: z
    .string()
    .min(1)
    .default(DEFAULT_ISSUE_FOLDER)
    .superRefine((folder, ctx) => {
      const problem = issueFolderProblem(folder);
      if (problem) {
        ctx.addIssue({ code: "custom", message: `Invalid issue folder: ${problem}` });
      }
    })
    .transform(normalizeIssueFolder),
});
export type IssueSourceSettings = z.infer<typeof IssueSourceSettings>;

// ---------------------------------------------------------------- operational state

/**
 * Which file a folder scan could not use and why (§5.7, §11 phase 1). Problems are rebuilt by
 * every scan and shown in the UI; they are not events. A problem on one file never changes
 * another issue, and a malformed file never deletes a previously synced row.
 */
export const IssueFileProblem = z.object({
  /**
   * `bad_name`: a `.md` file whose name is not `NNNN-<slug>.md` (a typo, a numberless name, a
   * subdirectory entry). `malformed`: the file's front matter, body, comments, encoding or size
   * break the format, including a missing `title`/`state`, an unknown key, a number mismatch or
   * too many comments. `duplicate`: another file carries the same number; neither is read.
   * `missing_number`: the front matter has no `number` (the filename's number is not assumed).
   * `bad_folder`: the folder setting is not a usable repository-relative folder, or a scanned
   * path is not directly inside it.
   */
  kind: z.enum(["bad_name", "malformed", "duplicate", "missing_number", "bad_folder"]),
  /**
   * Repository-relative path with forward slashes: the issue file, or the folder itself for
   * `bad_folder`.
   */
  path: z.string().min(1),
  /** What is wrong, for a person, including the offending field or line where known. */
  detail: z.string().min(1),
});
export type IssueFileProblem = z.infer<typeof IssueFileProblem>;

/**
 * The state of a project's issue source (`GET /api/projects/:id/github/issues`, §10): which
 * source answered, whether files can be written, whether the last scan was stale, the problems
 * that scan reported and when the source's silent baseline last succeeded.
 */
export const IssueSourceStatus = z.object({
  projectId: Id,
  /** What the project's issues resolve to (§4.3); `none`: a local project without folder issues. */
  source: IssueSourceKind,
  /** The repository-relative issue folder for a `folder` source; null for a forge or `none`. */
  folder: z.string().nullable(),
  /** True when CodeDen can write issue files: a `folder` source on a git-backed project. */
  writable: z.boolean(),
  /** The last scan read a previously fetched ref because the forge or fetch failed (§6.1). */
  stale: z.boolean().default(false),
  /** Problems the last scan reported (§5.7); empty when all files are readable. */
  problems: z.array(IssueFileProblem).default([]),
  /** When the source's silent baseline completed; null before the first one (§6.3). */
  baselineAt: Timestamp.nullable().default(null),
  /** When the last scan finished, successfully or not. */
  lastSyncAt: Timestamp.nullable().default(null),
  /** Why the last scan failed, e.g. `not_a_repo` or `folder_missing`; null when it did not. */
  lastError: z.string().nullable().default(null),
});
export type IssueSourceStatus = z.infer<typeof IssueSourceStatus>;
