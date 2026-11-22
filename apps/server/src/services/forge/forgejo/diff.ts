import type { GithubPrDiffFile } from "@codeden/contracts";

/**
 * Parse Forgejo's whole-pull-request `.diff` into per-file patches (`docs/forges.md` §5.5).
 * Forgejo's file listing has no per-file patch, so CodeDen reads the unified diff once and
 * splits it on `diff --git` headers. Pure, so binary files, renames and quoted paths are
 * covered by tests without a forge.
 */
export function parseUnifiedDiff(text: string): GithubPrDiffFile[] {
  const files: GithubPrDiffFile[] = [];
  for (const block of text.split(/\n(?=diff --git )/)) {
    if (!block.startsWith("diff --git ")) continue;
    const lines = block.split("\n");
    const header = lines[0]?.slice("diff --git ".length) ?? "";
    const paths = headerPaths(header);
    if (!paths) continue;

    let path = paths.newPath;
    let previousPath = paths.oldPath;
    let status = "modified";
    let renames = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith("new file mode ")) status = "added";
      else if (line.startsWith("deleted file mode ")) status = "removed";
      else if (line.startsWith("rename from ")) {
        status = "renamed";
        previousPath = unquoteGitPath(line.slice("rename from ".length));
        renames = true;
      } else if (line.startsWith("rename to ")) {
        status = "renamed";
        path = unquoteGitPath(line.slice("rename to ".length));
        renames = true;
      } else if (line.startsWith("copy from ")) {
        status = "copied";
        previousPath = unquoteGitPath(line.slice("copy from ".length));
        renames = true;
      } else if (line.startsWith("copy to ")) {
        status = "copied";
        path = unquoteGitPath(line.slice("copy to ".length));
        renames = true;
      } else if (line === "--- /dev/null") status = "added";
      else if (line === "+++ /dev/null") status = "removed";
      else if (line.startsWith("--- ") && !renames) {
        const old = stripPrefix(unquoteGitPath(line.slice(4)), "a/");
        if (old) previousPath = old;
      } else if (line.startsWith("+++ ") && !renames) {
        const next = stripPrefix(unquoteGitPath(line.slice(4)), "b/");
        if (next) path = next;
      }
    }

    let additions = 0;
    let deletions = 0;
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) additions++;
      else if (inHunk && line.startsWith("-")) deletions++;
    }

    files.push({
      path,
      ...(status === "renamed" || status === "copied" ? { previousPath } : {}),
      status,
      additions,
      deletions,
      patch: block.endsWith("\n") ? block : `${block}\n`,
    });
  }
  return files;
}

/** Split the two `a/… b/…` paths of a `diff --git` header, honoring git's quoting. */
function headerPaths(header: string): { oldPath: string; newPath: string } | null {
  if (header.startsWith('"')) {
    const first = readQuoted(header, 0);
    if (!first) return null;
    let at = first.end;
    while (header[at] === " ") at++;
    const second = readQuoted(header, at);
    if (!second) return null;
    return {
      oldPath: stripPrefix(unquoteGitPath(first.token), "a/"),
      newPath: stripPrefix(unquoteGitPath(second.token), "b/"),
    };
  }
  // Git leaves ordinary spaces bare, so the second path's `b/` marks the split.
  const split = header.indexOf(" b/");
  if (split < 0) return null;
  return {
    oldPath: stripPrefix(header.slice(0, split), "a/"),
    newPath: stripPrefix(header.slice(split + 1), "b/"),
  };
}

function readQuoted(text: string, start: number): { token: string; end: number } | null {
  if (text[start] !== '"') return null;
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === '"') {
      return { token: text.slice(start, index + 1), end: index + 1 };
    }
    index++;
  }
  return null;
}

/** Decode the C escapes git writes inside a quoted path (`core.quotePath`, its default). */
export function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  for (let index = 1; index < raw.length - 1; index++) {
    const char = raw[index];
    if (char !== "\\") {
      for (const byte of Buffer.from(char ?? "", "utf8")) bytes.push(byte);
      continue;
    }
    const next = raw[++index] ?? "";
    const named: Record<string, string> = {
      a: "\u0007",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      '"': '"',
      "\\": "\\",
    };
    if (named[next] !== undefined) {
      for (const byte of Buffer.from(named[next] as string, "utf8")) bytes.push(byte);
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(raw[index + 1] ?? "")) {
        octal += raw[++index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    for (const byte of Buffer.from(next, "utf8")) bytes.push(byte);
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(path: string, prefix: string): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
