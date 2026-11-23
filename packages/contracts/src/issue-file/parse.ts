import type { IssueFileProblem } from "../issue-sources";
import { readBodyAndComments } from "./comments";
import { parseIssueFileName } from "./file-name";
import {
  parseFrontMatterLines,
  parseScalar,
  readInteger,
  readLabels,
  readPullRequests,
  readTimestamp,
} from "./front-matter";
import { type IssueFile, IssueFile as IssueFileSchema } from "./issue";
import {
  MAX_ISSUE_FILE_BYTES,
  MAX_ISSUE_FRONT_MATTER_BYTES,
  MAX_ISSUE_TITLE_LENGTH,
} from "./limits";
import { hasControlCharacters, utf8Length } from "./text";

/** What `parseIssueFile` gives: the canonical issue, or every problem found (§5.7). */
export type IssueFileParseResult =
  | { ok: true; file: IssueFile }
  | { ok: false; problems: IssueFileProblem[] };

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
