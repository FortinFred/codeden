import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type FactoryOpenSpecChangeRequest,
  OPENSPEC_CHANGE_EXISTS,
  type OpenSpecChangeRef,
  type Project,
} from "@codeden/contracts";
import { conflict } from "../errors";

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
 * Largest `proposal.md` read from a change folder, in bytes. A proposal is a short document
 * (the body is cut at 8,000 characters), so anything past 1 MB is not a change to take in; the
 * folder is skipped rather than loaded whole on every factory tick.
 */
export const MAX_PROPOSAL_BYTES = 1_000_000;

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
      const stats = lstatSync(file);
      if (!stats.isFile() || stats.size > MAX_PROPOSAL_BYTES) continue;
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

/** Longest change id created from the app, so the folder name stays a comfortable file name. */
const CHANGE_ID_MAX = 100;

/**
 * Names Windows reserves for devices: a folder with one of them can't be created there, in any
 * case. A title that unfolds to one gets a prefix so it stays a valid folder.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** Whether a path exists at all, without following a symlink. */
function hasEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A change folder id from a title: lowercase letters, digits and single hyphens, with accents
 * folded (`Café` becomes `cafe`). Nothing else survives, so a title can never make the folder
 * leave `openspec/changes/`; a title with no usable character becomes `change`, and a Windows
 * device name (`CON`, `NUL`, `COM1`…) gets `change-` so the folder can be created there too.
 */
export function openSpecChangeId(title: string): string {
  const id =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, CHANGE_ID_MAX)
      .replace(/-+$/, "") || "change";
  return WINDOWS_DEVICE.test(id) ? `change-${id}` : id;
}

/**
 * Create a change folder from the app ("New change"): `openspec/changes/<slug>/proposal.md`
 * with the title as its `# ` heading, then the body and a trailing newline. 409
 * `openspec_change_exists` when the folder already has a proposal, so nothing is overwritten;
 * a folder without one is a write that died before its rename (or a leftover), so it is reused
 * and its stale tmp cleared. A failed write removes the folder it made. The next tick's
 * `intakeOpenSpec` takes the change in.
 */
export function writeOpenSpecChange(
  project: Project,
  req: FactoryOpenSpecChangeRequest,
): OpenSpecChangeRef {
  const title = req.title.replace(/\s+/g, " ").trim();
  const body = req.body.trim();
  const id = openSpecChangeId(title);
  const root = join(project.path, "openspec", "changes");
  const dir = join(root, id);
  const file = join(dir, "proposal.md");
  const tmp = `${file}.tmp`;
  mkdirSync(root, { recursive: true });
  let made = true;
  try {
    // Without `recursive`, this fails when the folder exists: the change is never overwritten.
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A folder with a proposal is taken, and is never touched. Without one it is a write that
    // died before its rename (or an empty leftover): the folder is reused, its tmp cleared.
    if (hasEntry(file))
      throw conflict(
        `The OpenSpec change \`${id}\` already exists; choose another title.`,
        OPENSPEC_CHANGE_EXISTS,
      );
    made = false;
    rmSync(tmp, { recursive: true, force: true });
  }
  try {
    // Write then rename, so a tick never reads a half-written proposal.
    writeFileSync(tmp, body ? `# ${title}\n\n${body}\n` : `# ${title}\n`);
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (made) rmSync(dir, { recursive: true, force: true });
      else rmSync(tmp, { recursive: true, force: true });
    } catch {
      // The write error is the one worth reporting.
    }
    throw error;
  }
  return { id, path: `openspec/changes/${id}` };
}
