import { z } from "zod";
import {
  DEFAULT_ISSUE_FOLDER,
  type IssueFileProblem,
  issueFolderProblem,
  normalizeIssueFolder,
} from "../issue-sources";
import { ISSUE_IGNORED_FILE_NAMES, parseIssueFileName } from "./file-name";
import type { IssueFile } from "./issue";
import { ISSUE_NUMBER_LEDGER_FILE } from "./ledger";
import { parseIssueFile } from "./parse";

/** One file read from the issue folder, repository-relative with forward slashes. */
export const IssueFolderEntry = z.object({
  path: z.string().min(1),
  text: z.string(),
});
export type IssueFolderEntry = z.infer<typeof IssueFolderEntry>;

/** One valid issue file from a folder scan. */
export interface IssueFolderFile {
  /** Repository-relative path, forward slashes. */
  path: string;
  file: IssueFile;
}

/** The result of reading a set of issue-folder files (§5.7): what parsed, what did not. */
export interface IssueFolderScan {
  /** Valid issues, by number then path. Duplicates and malformed files are absent. */
  files: IssueFolderFile[];
  /** Problems in a stable order (path, then the order they were found). */
  problems: IssueFileProblem[];
}

/**
 * Read a set of files from one issue folder (§5.1, §5.7). `path` values are repository-relative;
 * only files directly inside `folder` are read — no subdirectories — and `README.md`, `.gitkeep`
 * and non-`.md` files are ignored. A non-matching `.md` file is a `bad_name` problem, a file that
 * does not parse contributes its own problems, and a number carried by more than one file is a
 * `duplicate` problem for each of them: neither is projected, and the others still are.
 *
 * The `.numbers` ledger and `.gitkeep` are not issue files; the caller reads the ledger with
 * `parseIssueNumberLedger` and allocates with `nextIssueNumber`.
 */
export function scanIssueFolder(input: {
  folder: string;
  files: readonly IssueFolderEntry[];
}): IssueFolderScan {
  const folderProblem = issueFolderProblem(input.folder);
  if (folderProblem) {
    return {
      files: [],
      problems: [
        {
          kind: "bad_folder",
          path: input.folder.trim() || DEFAULT_ISSUE_FOLDER,
          detail: `The issue folder is not usable: ${folderProblem}`,
        },
      ],
    };
  }

  const folder = normalizeIssueFolder(input.folder);
  const problems: IssueFileProblem[] = [];
  const valid: IssueFolderFile[] = [];
  const entries = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path.startsWith(`${folder}/`)) {
      problems.push({
        kind: "bad_folder",
        path,
        detail: `is not inside the issue folder \`${folder}\``,
      });
      continue;
    }
    const name = path.slice(folder.length + 1);
    if (name.includes("/")) {
      problems.push({
        kind: "bad_name",
        path,
        detail: "subdirectories in the issue folder are not read",
      });
      continue;
    }
    if (ISSUE_IGNORED_FILE_NAMES.includes(name) || name === ISSUE_NUMBER_LEDGER_FILE) continue;
    if (!name.endsWith(".md")) continue;
    if (!parseIssueFileName(name)) {
      problems.push({
        kind: "bad_name",
        path,
        detail:
          "the filename must be NNNN-<slug>.md: at least four digits and a lowercase slug of 1–60 characters",
      });
      continue;
    }
    const parsed = parseIssueFile({ path, text: entry.text });
    if (!parsed.ok) {
      problems.push(...parsed.problems);
      continue;
    }
    valid.push({ path, file: parsed.file });
  }

  const byNumber = new Map<number, IssueFolderFile[]>();
  for (const item of valid) {
    const group = byNumber.get(item.file.number);
    if (group) group.push(item);
    else byNumber.set(item.file.number, [item]);
  }
  const duplicates = new Set<IssueFolderFile>();
  for (const [number, group] of byNumber) {
    if (group.length < 2) continue;
    for (const item of group) {
      duplicates.add(item);
      const others = group
        .filter((other) => other !== item)
        .map((other) => `\`${other.path}\``)
        .join(", ");
      problems.push({
        kind: "duplicate",
        path: item.path,
        detail: `issue #${number} is also in ${others}; neither file is read until one is removed`,
      });
    }
  }

  const files = valid
    .filter((item) => !duplicates.has(item))
    .sort((a, b) => a.file.number - b.file.number || (a.path < b.path ? -1 : 1));
  problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, problems };
}
