/**
 * The strict issue-file format (`docs/issue-sources.md` §5): a small, fixed YAML subset for the
 * front matter, the Markdown body, and the append-only comments appendix, with a canonical
 * renderer so `parse(render(file))` returns the same issue and `render(parse(text))` is stable.
 *
 * This module is the public entry: the parsing, rendering, scanning, naming and numbering pieces
 * live in their own files beside it, and every name this format previously exported is
 * re-exported here unchanged.
 *
 * Grammar, deliberately smaller than YAML:
 *
 *   file        := "---" LF frontMatter "---" LF body
 *   frontMatter := (blank | comment | field)*
 *   comment     := "#" ...                       (not written by the renderer)
 *   field       := key ":" (" " scalar)? | key ":" LF listItem+
 *   key         := number | title | state | stateReason | closedAt | labels | author
 *                | createdAt | updatedAt | pullRequests
 *   scalar      := plain | '"' escaped '"' | "'" escaped "'"
 *   plain       := text without a leading YAML indicator, ": " or " #"
 *   listItem    := indent "-" " " (scalar | flowPr)
 *   flowPr      := "{" "number:" INT ("," "url:" scalar)? "}" | INT | scalar(INT)
 *
 * A flow sequence (`[]`, `[57, 58]`, `[a, b]`) is accepted for `labels` and `pullRequests`.
 * Duplicate keys, unknown keys, anchors, aliases, tags, block scalars, nested maps, multi-line
 * strings and multiple documents are malformed. `pullRequests` items are `{ number, url? }`;
 * a bare integer is shorthand for `{ number }`.
 *
 * Body and comments:
 *
 *   body        := every line after the closing fence, minus one separator blank line, up to
 *                  the comments marker (trailing blank lines dropped)
 *   appendix    := MARKER LF "## Comments" LF (entry)*
 *   entry       := "### " TIMESTAMP " · " AUTHOR LF body
 *
 * `MARKER` is `<!-- codeden:comments -->`; a body that contains it is malformed. A comment body
 * line that starts with `\`, `#` or is the marker is written with one extra leading `\`, and the
 * parser removes one leading `\` from every comment body line, so a comment can never forge the
 * next entry's header or the marker.
 */

export {
  ISSUE_COMMENT_HEADER_PATTERN,
  ISSUE_COMMENTS_HEADING,
  ISSUE_COMMENTS_MARKER,
  IssueFileComment,
  IssueFileCommentAuthor,
  issueCommentAnchor,
  issueCommentId,
} from "./comments";
export {
  ISSUE_FILE_NAME_PATTERN,
  ISSUE_IGNORED_FILE_NAMES,
  issueFileName,
  issueSlug,
  parseIssueFileName,
} from "./file-name";
export { ISSUE_FILE_FIELDS } from "./front-matter";
export { IssueFile, IssueFilePullRequest, IssueFileStateReason } from "./issue";
export {
  ISSUE_NUMBER_LEDGER_FILE,
  IssueNumberLedger,
  type IssueNumberLedgerRead,
  nextIssueNumber,
  parseIssueNumberLedger,
  renderIssueNumberLedger,
} from "./ledger";
export {
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_COMMENTS,
  MAX_ISSUE_FILE_BYTES,
  MAX_ISSUE_FRONT_MATTER_BYTES,
  MAX_ISSUE_LABEL_LENGTH,
  MAX_ISSUE_LABELS,
  MAX_ISSUE_SLUG_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
} from "./limits";
export { type IssueFileParseResult, parseIssueFile } from "./parse";
export { renderIssue } from "./render";
export {
  IssueFolderEntry,
  type IssueFolderFile,
  type IssueFolderScan,
  scanIssueFolder,
} from "./scan";
export { IssueFileTimestamp, normalizeIssueTimestamp } from "./timestamp";
