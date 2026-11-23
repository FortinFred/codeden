import { z } from "zod";
import type { IssueFileProblem } from "../issue-sources";
import { MAX_ISSUE_BODY_LENGTH, MAX_ISSUE_COMMENTS } from "./limits";
import { trimBlankLines } from "./text";
import { IssueFileTimestamp, normalizeIssueTimestamp } from "./timestamp";

/**
 * The comments appendix of an issue file (`docs/issue-sources.md` §5.4): the fixed marker, the
 * `## Comments` heading, append-only entries, and the escape that keeps an entry from forging the
 * next header or the marker.
 */

/** The line that separates the body from the comments appendix (§5.4). */
export const ISSUE_COMMENTS_MARKER = "<!-- codeden:comments -->";

/** The heading the writer puts below the marker (§5.4). */
export const ISSUE_COMMENTS_HEADING = "## Comments";

/** A comment entry's header: second-precision UTC timestamp, `@login`, `local` or `codeden`. */
export const ISSUE_COMMENT_HEADER_PATTERN =
  /^### (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) · (@[A-Za-z0-9._-]+|local|codeden)$/;

/**
 * A comment's author as the appendix header shows it (§5.8): `@login` for a person, `local` when
 * no login is known, `codeden` for CodeDen itself. The front matter's `author` holds the same
 * account without the `@`.
 */
export const IssueFileCommentAuthor = z
  .string()
  .regex(/^(?:@[A-Za-z0-9._-]+|local|codeden)$/, "must be @login, local or codeden");
export type IssueFileCommentAuthor = z.infer<typeof IssueFileCommentAuthor>;

/**
 * One append-only comment entry (§5.4). `id` is derived from the entry's immutable data — not its
 * position — so a hand deletion elsewhere does not renumber the others; the position is only the
 * `#comment-<ordinal>` anchor.
 */
export const IssueFileComment = z.object({
  /**
   * Stable 53-bit hash of `createdAt`, `author` and `body` (`issueCommentId`); it does not change
   * when other comments are added or removed.
   */
  id: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * The header's author token: `@login`, `local` or `codeden`. Display metadata; trust comes from
   * the default branch, never from this field.
   */
  author: IssueFileCommentAuthor,
  /** Comment Markdown, stored as written; the projection truncates it at 20,000 characters. */
  body: z.string().min(1).max(MAX_ISSUE_BODY_LENGTH),
  /** The entry header's timestamp, second precision UTC. */
  createdAt: IssueFileTimestamp,
});
export type IssueFileComment = z.infer<typeof IssueFileComment>;

/**
 * A comment's stable id: a 53-bit hash of its timestamp, author and body (§5.4). Deterministic
 * across servers and clones, independent of position, and safe as a JavaScript integer.
 */
export function issueCommentId(
  comment: Pick<IssueFileComment, "createdAt" | "author" | "body">,
): number {
  const text = `${comment.createdAt}\u0000${comment.author}\u0000${comment.body}`;
  // cyrb53, folded into 53 bits.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The `url` fragment for a comment's position in the appendix: `#comment-<ordinal>` (§5.4). */
export function issueCommentAnchor(ordinal: number): string {
  return `#comment-${ordinal}`;
}

/** The body and comments appendix, or the problems that make them unreadable (§5.4). */
export function readBodyAndComments(
  lines: readonly string[],
  close: number,
  path: string,
): { body: string; comments: IssueFileComment[] } | { problems: IssueFileProblem[] } {
  const problems: IssueFileProblem[] = [];
  const report = (detail: string) => problems.push({ kind: "malformed", path, detail });
  const rest = lines.slice(close + 1);
  // 1-based line number of rest[0]; adjusted when the separator blank line is dropped.
  let restStart = close + 2;
  if (rest.length > 0 && (rest[0] ?? "").trim() === "") {
    // One blank separator line belongs to the fence, not to the body.
    rest.shift();
    restStart += 1;
  }

  const markerLines = rest.flatMap((line, index) =>
    line === ISSUE_COMMENTS_MARKER ? [index] : [],
  );
  if (markerLines.length > 1) {
    report(`the comments marker \`${ISSUE_COMMENTS_MARKER}\` appears more than once`);
    return { problems };
  }

  const markerIndex = markerLines[0];
  if (markerIndex === undefined) {
    const body = trimBlankLines(rest).join("\n");
    if (body.length > MAX_ISSUE_BODY_LENGTH) {
      report(`the body is longer than ${MAX_ISSUE_BODY_LENGTH} characters`);
      return { problems };
    }
    return { body, comments: [] };
  }

  const body = trimBlankLines(rest.slice(0, markerIndex)).join("\n");
  if (body.length > MAX_ISSUE_BODY_LENGTH) {
    report(`the body is longer than ${MAX_ISSUE_BODY_LENGTH} characters`);
    return { problems };
  }
  const appendix = rest.slice(markerIndex + 1);
  const heading = appendix.findIndex((line) => line.trim() !== "");
  if (heading < 0 || (appendix[heading] ?? "").trim() !== ISSUE_COMMENTS_HEADING) {
    report(`the comments marker must be followed by \`${ISSUE_COMMENTS_HEADING}\``);
    return { problems };
  }

  const commentLine = (index: number) => restStart + markerIndex + 1 + index;
  const comments: IssueFileComment[] = [];
  let entry: { createdAt: string; author: string; body: string[]; line: number } | null = null;
  const flush = () => {
    if (!entry) return;
    const commentBody = trimBlankLines(entry.body).join("\n");
    if (commentBody.trim() === "") {
      report(`line ${entry.line}: comment ${comments.length + 1} has no body`);
    } else {
      const author = entry.author as IssueFileComment["author"];
      const createdAt = entry.createdAt as IssueFileComment["createdAt"];
      comments.push({
        id: issueCommentId({ createdAt, author, body: commentBody }),
        createdAt,
        author,
        body: commentBody,
      });
    }
    entry = null;
  };
  for (let index = heading + 1; index < appendix.length; index += 1) {
    const line = appendix[index] ?? "";
    const lineNumber = commentLine(index);
    const header = ISSUE_COMMENT_HEADER_PATTERN.exec(line);
    if (header) {
      flush();
      const createdAt = normalizeIssueTimestamp(header[1] ?? "");
      if (createdAt === null) {
        report(`line ${lineNumber}: the comment timestamp is not a real date`);
        continue;
      }
      entry = { createdAt, author: header[2] ?? "", body: [], line: lineNumber };
      continue;
    }
    // The writer prefixes one `\` to a comment line that starts with `\`, `#` or the marker.
    const unescaped = line.startsWith("\\") ? line.slice(1) : line;
    if (entry) {
      entry.body.push(unescaped);
      continue;
    }
    if (unescaped.trim() === "") continue;
    report(`line ${lineNumber}: expected a comment header \`### <timestamp> · <@author>\``);
    return { problems };
  }
  flush();

  if (problems.length > 0) return { problems };
  if (comments.length > MAX_ISSUE_COMMENTS) {
    report(`the issue has more than ${MAX_ISSUE_COMMENTS} comments`);
    return { problems };
  }
  return { body, comments };
}
