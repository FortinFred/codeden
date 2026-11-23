import { z } from "zod";
import type { IssueFileProblem } from "../issue-sources";
import type { IssueFilePullRequest } from "./issue";
import { MAX_ISSUE_LABEL_LENGTH, MAX_ISSUE_LABELS } from "./limits";
import { hasControlCharacters } from "./text";
import { normalizeIssueTimestamp } from "./timestamp";

/**
 * The front matter of an issue file (`docs/issue-sources.md` §5.2–§5.3): a small, fixed YAML
 * subset with parse and serialize helpers. Grammar, deliberately smaller than YAML:
 *
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
 */

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

/** One top-level key, its inline value and any indented list items. */
export interface FrontMatterField {
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
export function parseFrontMatterLines(
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
export function parseScalar(raw: string): string | null {
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
export function readInteger(raw: string): number | null {
  let value = raw;
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) ? number : null;
}

/** A timestamp field: a normalized timestamp, null for `null`, or undefined when malformed. */
export function readTimestamp(field: FrontMatterField): string | null | undefined {
  const value = parseScalar(field.value);
  if (value === null) return undefined;
  if (value === "" || value === "null") return null;
  const normalized = normalizeIssueTimestamp(value);
  return normalized ?? undefined;
}

/** Labels from a flow sequence or a block list; duplicates removed, order preserved (§5.3). */
export function readLabels(field: FrontMatterField): string[] | null {
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
export function readPullRequests(field: FrontMatterField): IssueFilePullRequest[] | null {
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

/** Always quote a value: titles and timestamps are the values whose YAML form is ambiguous. */
export function quote(value: string): string {
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
export function scalar(value: string): string {
  if (
    PLAIN_SCALAR.test(value) &&
    !RESERVED_PLAIN_SCALARS.has(value.toLowerCase()) &&
    !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)
  ) {
    return value;
  }
  return quote(value);
}
