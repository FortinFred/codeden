import { ISSUE_COMMENTS_HEADING, ISSUE_COMMENTS_MARKER } from "./comments";
import { quote, scalar } from "./front-matter";
import { type IssueFile, type IssueFilePullRequest, IssueFile as IssueFileSchema } from "./issue";
import { trimBlankLines } from "./text";

/**
 * The canonical writer for issue files (`docs/issue-sources.md` §5.2–§5.4). It always emits the
 * same front matter order and quoting, one blank separator, the body, the comments marker and the
 * appendix, so `parse(render(file))` returns the file and rendering the parsed result is stable.
 */

/**
 * Write the canonical issue file (§5.2–§5.4): fixed front matter order and quoting, the body,
 * then the comments appendix and every entry. The result is UTF-8/LF with a trailing newline, so
 * `parse(render(file))` returns `file` and rendering the parsed result is stable.
 *
 * Throws when the file is not a valid `IssueFile`, or when its body contains the comments marker
 * verbatim: the marker belongs to the appendix, and a body holding it would make the file
 * ambiguous (§5.4). Callers validate user text before rendering rather than catching this.
 */
export function renderIssue(input: IssueFile): string {
  const file = IssueFileSchema.parse(input);
  const body = trimBlankLines(file.body.replace(/\r\n?/g, "\n").split("\n")).join("\n");
  if (body.split("\n").includes(ISSUE_COMMENTS_MARKER)) {
    throw new Error(
      `An issue body cannot contain the comments marker \`${ISSUE_COMMENTS_MARKER}\` verbatim`,
    );
  }

  const lines: string[] = [
    "---",
    `number: ${file.number}`,
    `title: ${quote(file.title)}`,
    `state: ${file.state}`,
    `stateReason: ${file.stateReason ?? "null"}`,
    `closedAt: ${file.closedAt === null ? "null" : quote(file.closedAt)}`,
    ...renderLabels(file.labels),
    `author: ${file.author === null ? "null" : scalar(file.author)}`,
    `createdAt: ${file.createdAt === null ? "null" : quote(file.createdAt)}`,
    `updatedAt: ${file.updatedAt === null ? "null" : quote(file.updatedAt)}`,
    ...renderPullRequests(file.pullRequests),
    "---",
    "",
  ];
  if (body !== "") lines.push(...body.split("\n"));
  lines.push("", ISSUE_COMMENTS_MARKER, ISSUE_COMMENTS_HEADING);
  for (const comment of file.comments) {
    lines.push("", `### ${comment.createdAt} · ${comment.author}`, "");
    for (const line of trimBlankLines(comment.body.split("\n"))) {
      lines.push(escapeCommentLine(line));
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderLabels(labels: readonly string[]): string[] {
  if (labels.length === 0) return ["labels: []"];
  return ["labels:", ...labels.map((label) => `  - ${scalar(label)}`)];
}

function renderPullRequests(pullRequests: readonly IssueFilePullRequest[]): string[] {
  if (pullRequests.length === 0) return ["pullRequests: []"];
  if (pullRequests.every((pullRequest) => pullRequest.url === undefined)) {
    return [`pullRequests: [${pullRequests.map((pullRequest) => pullRequest.number).join(", ")}]`];
  }
  return [
    "pullRequests:",
    ...pullRequests.map((pullRequest) =>
      pullRequest.url === undefined
        ? `  - { number: ${pullRequest.number} }`
        : `  - { number: ${pullRequest.number}, url: ${quote(pullRequest.url)} }`,
    ),
  ];
}

/** A comment body line escaped so it can never be read as the next header or the marker (§5.4). */
function escapeCommentLine(line: string): string {
  return line.startsWith("\\") || line.startsWith("#") || line === ISSUE_COMMENTS_MARKER
    ? `\\${line}`
    : line;
}
