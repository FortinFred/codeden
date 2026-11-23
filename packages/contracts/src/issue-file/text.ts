/**
 * Text helpers shared by the issue-file parser and renderer. They work on decoded JavaScript
 * strings only; the reader that decodes UTF-8 lives in the server (phase 1).
 */

/** Drop blank lines at both ends: the canonical body and comment bodies have none. */
export function trimBlankLines(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start += 1;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(start, end);
}

/** True for the C0/C1 control characters a title, label or author may not contain. */
export function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value);
}

/** UTF-8 byte length, for the file and front matter caps (§5.7). */
export function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
