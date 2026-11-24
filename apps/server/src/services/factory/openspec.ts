import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenSpecChangeRef, Project } from "@codeden/contracts";

/**
 * OpenSpec as a factory work source (§10.1). A change is a folder under `openspec/changes/`
 * holding `proposal.md` (why and what), `design.md` (how), the spec deltas under `specs/` and
 * `tasks.md`. The folders are ordinary files in the project's main checkout, so reading them is
 * local and trusted; pull requests, CI, review and merge still run on GitHub.
 */

/** A change folder read from the project. */
export interface OpenSpecChange {
  ref: OpenSpecChangeRef;
  title: string;
  /** The proposal, without its frontmatter or title heading. */
  body: string;
}

/** Most change folders taken in per tick: the rest wait for the next one. */
export const MAX_OPENSPEC_CHANGES = 500;

/**
 * A proposal's title and body. The first `# ` heading is the title (the folder id when there is
 * none); a YAML frontmatter block and that heading are left out of the body.
 */
export function parseProposal(id: string, contents: string): { title: string; body: string } {
  let text = contents.replace(/\r\n/g, "\n");
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) text = text.slice(end + 4).replace(/^\n/, "");
  }
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => /^#\s+\S/.test(line));
  const title = heading === -1 ? id : (lines[heading]?.replace(/^#\s+/, "").trim() ?? id);
  const body = lines
    .filter((_, i) => i !== heading)
    .join("\n")
    .trim();
  return { title: title.slice(0, 200), body: body.slice(0, 8_000) };
}

/**
 * The project's OpenSpec changes: one per folder under `openspec/changes/` with a readable
 * `proposal.md`, sorted by id. An empty list when the folder is missing, and a folder that can't
 * be read is skipped: a repository without OpenSpec is simply not an OpenSpec work source.
 */
export function readOpenSpecChanges(project: Project): OpenSpecChange[] {
  const root = join(project.path, "openspec", "changes");
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_OPENSPEC_CHANGES);
  } catch {
    return [];
  }
  const changes: OpenSpecChange[] = [];
  for (const id of ids) {
    try {
      const file = join(root, id, "proposal.md");
      // A symlink is followed by `statSync`: `lstatSync` keeps the read inside the folder.
      if (!lstatSync(file).isFile()) continue;
      const { title, body } = parseProposal(id, readFileSync(file, "utf8"));
      changes.push({
        ref: { id, path: `openspec/changes/${id}` },
        title,
        body,
      });
    } catch {
      // A folder without a readable proposal isn't work.
    }
  }
  return changes;
}
