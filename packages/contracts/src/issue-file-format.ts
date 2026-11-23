import { z } from "zod";
import {
  DEFAULT_ISSUE_FOLDER,
  ISSUE_IGNORED_FILE_NAMES,
  ISSUE_NUMBER_LEDGER_FILE,
  type IssueFile,
  type IssueFileComment,
  type IssueFileProblem,
  type IssueFilePullRequest,
  IssueFile as IssueFileSchema,
  issueCommentId,
  issueFolderProblem,
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_COMMENTS,
  MAX_ISSUE_FILE_BYTES,
  MAX_ISSUE_FRONT_MATTER_BYTES,
  MAX_ISSUE_LABEL_LENGTH,
  MAX_ISSUE_LABELS,
  MAX_ISSUE_TITLE_LENGTH,
  normalizeIssueFolder,
  normalizeIssueTimestamp,
  parseIssueFileName,
} from "./issue-sources";

/**
 * The strict issue-file format (`docs/issue-sources.md` §5): a small, fixed YAML subset for the
 * front matter, the Markdown body, and the append-only comments appendix, with a canonical
 * renderer so `parse(render(file))` returns the same issue and `render(parse(text))` is stable.
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

/** The line that separates the body from the comments appendix (§5.4). */
export const ISSUE_COMMENTS_MARKER = "<!-- codeden:comments -->";

/** The heading the writer puts below the marker (§5.4). */
export const ISSUE_COMMENTS_HEADING = "## Comments";

/** A comment entry's header: second-precision UTC timestamp, `@login`, `local` or `codeden`. */
export const ISSUE_COMMENT_HEADER_PATTERN =
  /^### (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) · (@[A-Za-z0-9._-]+|local|codeden)$/;

/** The front matter keys, in the fixed order the renderer writes them (§5.2). */
export const ISSUE_FILE_FIELDS = [
  "number",
  "title",
  "state",
  "stateReason",
  "closedAt",
  "labels",
  "author",
  "createdAt",
  "updatedAt",
  "pullRequests",
] as const;

/** What `parseIssueFile` gives: the canonical issue, or every problem found (§5.7). */
export type IssueFileParseResult =
  | { ok: true; file: IssueFile }
  | { ok: false; problems: IssueFileProblem[] };

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

// ---------------------------------------------------------------- parsing

/**
 * Parse one issue file. `path` is the file's repository-relative path; its last segment is the
 * filename the number must match. A failure returns the problems and never throws: a malformed
 * file must not stop the scan of the others (§5.7).
 */
export function parseIssueFile(input: { path: string; text: string }): IssueFileParseResult {
  const path = input.path.trim();
  const problems: IssueFileProblem[] = [];
  const fail = (detail: string): IssueFileParseResult => {
    problems.push({ kind: "malformed", path, detail });
    return { ok: false, problems };
  };

  const name = path.split("/").pop() ?? "";
  if (!parseIssueFileName(name)) {
    return {
      ok: false,
      problems: [
        {
          kind: "bad_name",
          path,
          detail:
            "the filename must be NNNN-<slug>.md: at least four digits and a lowercase slug of 1–60 characters",
        },
      ],
    };
  }

  let text = input.text;
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (text.includes("\uFEFF"))
    return fail("the file contains a byte-order mark, not just at its start");
  if (text.includes("\u0000")) return fail("the file contains a NUL byte; it must be UTF-8 text");
  if (utf8Length(text) > MAX_ISSUE_FILE_BYTES) {
    return fail(`the file is larger than ${MAX_ISSUE_FILE_BYTES} bytes`);
  }
  // CRLF is accepted on read and normalized on write (§5.8).
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  if (lines[0] !== "---") {
    return fail("the file must start with a `---` front matter fence");
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      close = index;
      break;
    }
  }
  if (close < 0) return fail("the front matter fence is not closed with `---`");
  const frontMatter = lines.slice(0, close + 1).join("\n");
  if (utf8Length(frontMatter) > MAX_ISSUE_FRONT_MATTER_BYTES) {
    return fail(`the front matter is larger than ${MAX_ISSUE_FRONT_MATTER_BYTES} bytes`);
  }

  const fields = parseFrontMatterLines(lines, close, path, problems);
  for (const field of fields.values()) {
    if (field.items.length > 0 && field.key !== "labels" && field.key !== "pullRequests") {
      problems.push({
        kind: "malformed",
        path,
        detail: `line ${field.line}: \`${field.key}\` does not take a list`,
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const filename = parseIssueFileName(name);
  if (!filename) return fail("the filename is not an issue filename");

  const numberField = fields.get("number");
  if (!numberField) {
    problems.push({
      kind: "missing_number",
      path,
      detail: "the front matter has no `number`; the filename's number is not assumed",
    });
    return { ok: false, problems };
  }
  const number = readInteger(numberField.value);
  if (number === null || number < 1) {
    problems.push({
      kind: "malformed",
      path,
      detail: `line ${numberField.line}: \`number\` must be a positive integer`,
    });
    return { ok: false, problems };
  }
  if (number !== filename.number) {
    problems.push({
      kind: "malformed",
      path,
      detail: `line ${numberField.line}: \`number\` ${number} does not match the filename's ${filename.number}`,
    });
    return { ok: false, problems };
  }

  const titleField = fields.get("title");
  if (!titleField) return fail("the front matter has no `title`");
  const title = parseScalar(titleField.value);
  if (title === null) {
    return fail(`line ${titleField.line}: \`title\` must be a quoted or plain string`);
  }
  if (title.length < 1 || title.length > MAX_ISSUE_TITLE_LENGTH) {
    return fail(
      `line ${titleField.line}: \`title\` must be 1 to ${MAX_ISSUE_TITLE_LENGTH} characters`,
    );
  }
  if (hasControlCharacters(title)) {
    return fail(`line ${titleField.line}: \`title\` must not contain control characters`);
  }

  const stateField = fields.get("state");
  if (!stateField) return fail("the front matter has no `state`");
  const state = parseScalar(stateField.value);
  if (state !== "open" && state !== "closed") {
    return fail(`line ${stateField.line}: \`state\` must be \`open\` or \`closed\``);
  }

  const stateReasonField = fields.get("stateReason");
  let stateReason: IssueFile["stateReason"] = null;
  if (stateReasonField) {
    const value = parseScalar(stateReasonField.value);
    if (value === null || value === "" || value === "null") stateReason = null;
    else if (value === "completed" || value === "not_planned" || value === "duplicate") {
      stateReason = value;
    } else {
      return fail(
        `line ${stateReasonField.line}: \`stateReason\` must be completed, not_planned, duplicate or null`,
      );
    }
  }

  const closedAtField = fields.get("closedAt");
  const closedAt = closedAtField ? readTimestamp(closedAtField) : null;
  if (closedAtField && closedAt === undefined) {
    return fail(`line ${closedAtField.line}: \`closedAt\` must be an RFC 3339 timestamp or null`);
  }

  const labelsField = fields.get("labels");
  const labels = labelsField ? readLabels(labelsField) : [];
  if (labels === null) {
    return fail(
      `line ${labelsField?.line ?? 1}: \`labels\` must be a list of 1–100 character strings`,
    );
  }

  const authorField = fields.get("author");
  let author: string | null = null;
  if (authorField) {
    const value = parseScalar(authorField.value);
    if (value === null)
      return fail(`line ${authorField.line}: \`author\` must be a string or null`);
    if (value !== "" && value !== "null") {
      if (value.startsWith("@")) {
        return fail(`line ${authorField.line}: \`author\` is a login without \`@\``);
      }
      if (value.length > 100) {
        return fail(`line ${authorField.line}: \`author\` must be at most 100 characters`);
      }
      if (hasControlCharacters(value)) {
        return fail(`line ${authorField.line}: \`author\` must not contain control characters`);
      }
      author = value;
    }
  }

  const createdAtField = fields.get("createdAt");
  const createdAt = createdAtField ? readTimestamp(createdAtField) : null;
  if (createdAtField && createdAt === undefined) {
    return fail(`line ${createdAtField.line}: \`createdAt\` must be an RFC 3339 timestamp or null`);
  }
  const updatedAtField = fields.get("updatedAt");
  const updatedAt = updatedAtField ? readTimestamp(updatedAtField) : null;
  if (updatedAtField && updatedAt === undefined) {
    return fail(`line ${updatedAtField.line}: \`updatedAt\` must be an RFC 3339 timestamp or null`);
  }

  const pullRequestsField = fields.get("pullRequests");
  const pullRequests = pullRequestsField ? readPullRequests(pullRequestsField) : [];
  if (pullRequests === null) {
    return fail(
      `line ${pullRequestsField?.line ?? 1}: \`pullRequests\` must be a list of positive numbers or \`{ number, url }\``,
    );
  }

  const section = readBodyAndComments(lines, close, path);
  if ("problems" in section) return { ok: false, problems: section.problems };

  const file = {
    number,
    title,
    state,
    stateReason,
    closedAt: closedAt ?? null,
    labels,
    author,
    createdAt: createdAt ?? null,
    updatedAt: updatedAt ?? null,
    pullRequests,
    body: section.body,
    comments: section.comments,
  };
  const parsed = IssueFileSchema.safeParse(file);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        kind: "malformed" as const,
        path,
        detail: `${issue.path.join(".") || "issue"}: ${issue.message}`,
      })),
    };
  }
  return { ok: true, file: parsed.data };
}

interface FrontMatterField {
  key: string;
  value: string;
  line: number;
  items: { value: string; line: number }[];
}

/**
 * Read the front matter's `key: value` lines and indented list items into fields, reporting
 * unknown, duplicate and unsupported lines (§5.3). Blank lines and full-line `#` comments are
 * accepted but not written by the renderer.
 */
function parseFrontMatterLines(
  lines: readonly string[],
  close: number,
  path: string,
  problems: IssueFileProblem[],
): Map<string, FrontMatterField> {
  const known = new Set<string>(ISSUE_FILE_FIELDS);
  const fields = new Map<string, FrontMatterField>();
  let current: FrontMatterField | null = null;
  for (let index = 1; index < close; index += 1) {
    const line = lines[index] ?? "";
    const lineNumber = index + 1;
    const report = (detail: string) => {
      problems.push({
        kind: "malformed",
        path,
        detail: `line ${lineNumber}: ${detail}`,
      });
    };
    if (line.trim() === "") {
      current = null;
      continue;
    }
    if (line.startsWith("#")) {
      current = null;
      continue;
    }
    if (/^[ \t]/.test(line)) {
      const item = /^[ \t]+-[ \t]*(.*)$/.exec(line);
      if (!item) {
        report("unsupported YAML: only `- ` list items may be indented");
        current = null;
        continue;
      }
      if (!current) {
        report("a list item must follow a field");
        continue;
      }
      current.items.push({ value: (item[1] ?? "").trim(), line: lineNumber });
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!field) {
      report("expected `key: value`");
      current = null;
      continue;
    }
    const key = field[1] ?? "";
    if (!known.has(key)) {
      report(`unknown field \`${key}\``);
      current = null;
      continue;
    }
    if (fields.has(key)) {
      report(`duplicate field \`${key}\``);
      current = null;
      continue;
    }
    const entry: FrontMatterField = {
      key,
      value: (field[2] ?? "").trim(),
      line: lineNumber,
      items: [],
    };
    fields.set(key, entry);
    current = entry;
  }
  return fields;
}

/** A front matter scalar: quoted (double or single) or plain, or null when unsupported. */
function parseScalar(raw: string): string | null {
  if (raw === "") return "";
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"') || raw.length < 2) return null;
    return unescapeDoubleQuoted(raw.slice(1, -1));
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) return null;
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  // Indicators that start a YAML construct this parser does not support (`#` starts a comment, a
  // leading `- ` or `? ` starts a sequence or key, `~` is a null), and the two sequences that
  // would need quoting in YAML: a value after `: `, and an inline comment after ` #`.
  if (/^[:#[\]{}&*!|>'"%@`~]/.test(raw)) return null;
  if (/^-(?:[ \t]|$)/.test(raw) || /^\?(?:[ \t]|$)/.test(raw)) return null;
  if (raw.includes(": ") || raw.includes(" #")) return null;
  return raw;
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  "\\": "\\",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Unescape the fixed set of double-quoted escapes the renderer writes; null for anything else. */
function unescapeDoubleQuoted(raw: string): string | null {
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] ?? "";
    if (character !== "\\") {
      out += character;
      continue;
    }
    index += 1;
    const escaped = raw[index];
    if (escaped === undefined) return null;
    const replacement = DOUBLE_QUOTE_ESCAPES[escaped];
    if (replacement === undefined) return null;
    out += replacement;
  }
  return out;
}

/** A positive integer written plain or quoted; null otherwise (§5.3). */
function readInteger(raw: string): number | null {
  let value = raw;
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
}

/** A timestamp field: a normalized timestamp, null for `null`, or undefined when malformed. */
function readTimestamp(field: FrontMatterField): string | null | undefined {
  const value = parseScalar(field.value);
  if (value === null) return undefined;
  if (value === "" || value === "null") return null;
  const normalized = normalizeIssueTimestamp(value);
  return normalized ?? undefined;
}

/** Labels from a flow sequence or a block list; duplicates removed, order preserved (§5.3). */
function readLabels(field: FrontMatterField): string[] | null {
  const raw = readListRaw(field);
  if (raw === null) return null;
  const labels: string[] = [];
  for (const item of raw) {
    const label = parseScalar(item);
    if (label === null || label.length < 1 || label.length > MAX_ISSUE_LABEL_LENGTH) return null;
    if (hasControlCharacters(label)) return null;
    if (!labels.includes(label)) labels.push(label);
  }
  if (labels.length > MAX_ISSUE_LABELS) return null;
  return labels;
}

/** `{ number, url? }` items from a flow sequence or a block list (§5.3). */
function readPullRequests(field: FrontMatterField): IssueFilePullRequest[] | null {
  const raw = readListRaw(field);
  if (raw === null) return null;
  const pullRequests: IssueFilePullRequest[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed === "") return null;
    if (trimmed.startsWith("{")) {
      const mapped = readFlowMap(trimmed);
      if (!mapped) return null;
      const number = mapped.get("number");
      if (number === undefined) return null;
      const parsedNumber = readInteger(number);
      if (parsedNumber === null || parsedNumber < 1) return null;
      const urlRaw = mapped.get("url");
      if (urlRaw === undefined) {
        pullRequests.push({ number: parsedNumber });
        continue;
      }
      const url = parseScalar(urlRaw);
      if (url === null || !z.url().safeParse(url).success) return null;
      pullRequests.push({ number: parsedNumber, url });
      continue;
    }
    const parsedNumber = readInteger(trimmed);
    if (parsedNumber === null || parsedNumber < 1) return null;
    pullRequests.push({ number: parsedNumber });
  }
  return pullRequests;
}

/**
 * A field's list items, from `key: []`, `key: [a, b]` or the indented `- item` lines after it.
 * The renderer always writes a block list or `[]`, but a person may write the flow form.
 */
function readListRaw(field: FrontMatterField): string[] | null {
  const raw = field.value.trim();
  if (raw === "") return field.items.map((item) => item.value);
  if (!raw.startsWith("[")) return null;
  if (!raw.endsWith("]")) return null;
  if (field.items.length > 0) return null;
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = splitFlow(inner);
  if (parts === null) return null;
  return parts.map((part) => part.trim());
}

/** Split a flow sequence's contents on top-level commas, respecting quotes and braces. */
function splitFlow(inner: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index] ?? "";
    if (quote) {
      current += character;
      if (character === "\\" && quote === '"') {
        index += 1;
        current += inner[index] ?? "";
        continue;
      }
      if (character === quote) {
        // A doubled single quote is an escaped quote inside a single-quoted scalar.
        if (quote === "'" && inner[index + 1] === "'") {
          index += 1;
          current += "'";
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    if (character === "}" || character === "]") depth -= 1;
    if (depth < 0) return null;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (quote || depth !== 0) return null;
  parts.push(current);
  return parts;
}

/** The keys and raw values of a `{ key: value, ... }` flow map; null for anything else. */
function readFlowMap(raw: string): Map<string, string> | null {
  if (!raw.startsWith("{") || !raw.endsWith("}")) return null;
  const inner = raw.slice(1, -1).trim();
  const map = new Map<string, string>();
  if (inner === "") return map;
  const parts = splitFlow(inner);
  if (parts === null) return null;
  for (const part of parts) {
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(.*))?$/.exec(part.trim());
    if (!match) return null;
    const key = match[1] ?? "";
    if (key !== "number" && key !== "url") return null;
    if (map.has(key)) return null;
    map.set(key, (match[2] ?? "").trim());
  }
  return map;
}

/** The body and comments appendix, or the problems that make them unreadable (§5.4). */
function readBodyAndComments(
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

/** Drop blank lines at both ends: the canonical body and comment bodies have none. */
function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start += 1;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(start, end);
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

// ---------------------------------------------------------------- rendering

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

/** Always quote a value: titles and timestamps are the values whose YAML form is ambiguous. */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

const PLAIN_SCALAR = /^[A-Za-z0-9][A-Za-z0-9._/+@-]*$/;
const RESERVED_PLAIN_SCALARS = new Set([
  "true",
  "false",
  "null",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
  "~",
]);

/** A value as a plain YAML scalar when that is unambiguous, else double-quoted. */
function scalar(value: string): string {
  if (
    PLAIN_SCALAR.test(value) &&
    !RESERVED_PLAIN_SCALARS.has(value.toLowerCase()) &&
    !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)
  ) {
    return value;
  }
  return quote(value);
}

// ---------------------------------------------------------------- scanning

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
