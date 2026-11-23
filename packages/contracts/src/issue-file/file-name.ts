import { MAX_ISSUE_SLUG_LENGTH } from "./limits";

/**
 * Issue file names (`docs/issue-sources.md` §5.1): one file per issue, `NNNN-<slug>.md`, with a
 * lowercase ASCII slug that a person reads. The number is identity; the slug never is.
 */

/** `NNNN-<slug>.md`: at least four digits, a lowercase ASCII slug, lowercase `.md` (§5.1). */
export const ISSUE_FILE_NAME_PATTERN = /^(\d{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Files a repository may keep in the issue folder without them being issues (§5.1). */
export const ISSUE_IGNORED_FILE_NAMES: readonly string[] = ["README.md", ".gitkeep"];

/**
 * The number and slug of an issue file name, or null when the name is not one. A name that
 * matches the pattern but whose slug is over 60 characters is not an issue file: the limit is
 * what a person reads, not identity.
 */
export function parseIssueFileName(name: string): { number: number; slug: string } | null {
  const match = ISSUE_FILE_NAME_PATTERN.exec(name);
  if (!match) return null;
  const slug = match[2] ?? "";
  if (slug.length > MAX_ISSUE_SLUG_LENGTH) return null;
  const number = Number(match[1] ?? "");
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { number, slug };
}

/** The canonical filename for a number and title: `0042-export-as-csv.md` (§5.1, §8.2). */
export function issueFileName(number: number, title: string): string {
  return `${String(number).padStart(4, "0")}-${issueSlug(title)}.md`;
}

/**
 * A title as a filename slug (§8.2): lower-case ASCII letters and digits, other runs collapsed
 * to `-`, trimmed to 1–60 characters, `issue` when nothing survives. It never changes after the
 * file is created, even when the title does.
 */
export function issueSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ISSUE_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "issue";
}
