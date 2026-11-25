import type { Stats } from "node:fs";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type FactoryOpenSpecChangeRequest,
  OPENSPEC_CHANGE_EXISTS,
  OPENSPEC_CHANGE_ROOT_UNSAFE,
  type OpenSpecChangeRef,
  openSpecChangeId,
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
 * The project's `openspec/changes` folder, resolved from the project's real path. Every
 * component that already exists must be a real directory (`lstatSync`, so a symbolic link is
 * refused): a repository can commit a symlink there, and following it would read proposals from
 * or write a change outside the project. A component that doesn't exist ends the walk, and the
 * rest is created beneath it. The project path itself may be a symlink.
 */
function resolveChangeRoot(project: Project): { root: string } | { reason: string } {
  let root: string;
  try {
    root = realpathSync(project.path);
  } catch {
    return { reason: `The project folder \`${project.path}\` can't be read.` };
  }
  const parts = ["openspec", "changes"] as const;
  for (const [index, part] of parts.entries()) {
    const label = parts.slice(0, index + 1).join("/");
    const next = join(root, part);
    let stat: Stats;
    try {
      stat = lstatSync(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { root: join(root, ...parts.slice(index)) };
      return { reason: `\`${label}\` can't be read in the project.` };
    }
    if (!stat.isDirectory())
      return {
        reason: `\`${label}\` is a ${stat.isSymbolicLink() ? "symbolic link" : "file"}, not a real directory in the project.`,
      };
    root = next;
  }
  return { root };
}

/**
 * The project's OpenSpec changes: one per folder under `openspec/changes/` with a readable
 * `proposal.md`, sorted by id. An empty list when the folder is missing, and a folder that can't
 * be read is skipped: a repository without OpenSpec is simply not an OpenSpec work source. A
 * symlinked `openspec` or `openspec/changes` is never followed, and is reported when a `log` is
 * given.
 */
export function readOpenSpecChanges(
  project: Project,
  log?: (message: string) => void,
): OpenSpecChange[] {
  const resolved = resolveChangeRoot(project);
  if ("reason" in resolved) {
    log?.(`factory: OpenSpec changes skipped: ${resolved.reason}`);
    return [];
  }
  const root = resolved.root;
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
 * Create a change folder from the app ("New change"): `openspec/changes/<slug>/proposal.md`
 * with the title as its `# ` heading, then the body and a trailing newline. 409
 * `openspec_change_exists` when the folder already has a proposal, so nothing is overwritten;
 * a folder without one is a write that died before its rename (or a leftover), so it is reused
 * and its stale tmp cleared. A failed write removes the folder it made. 409
 * `openspec_change_root_unsafe` when the project's `openspec` or `openspec/changes`, or the
 * change folder itself, is a symbolic link or not a directory, so no write leaves the project.
 * The next tick's `intakeOpenSpec` takes the change in.
 */
export function writeOpenSpecChange(
  project: Project,
  req: FactoryOpenSpecChangeRequest,
): OpenSpecChangeRef {
  const title = req.title.replace(/\s+/g, " ").trim();
  const body = req.body.trim();
  const id = openSpecChangeId(title);
  const resolved = resolveChangeRoot(project);
  if ("reason" in resolved)
    throw conflict(
      `${resolved.reason} A change is only ever written inside the project.`,
      OPENSPEC_CHANGE_ROOT_UNSAFE,
    );
  const root = resolved.root;
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
    // `mkdirSync` also finds a symbolic link to a folder existing, and writing through it would
    // leave the project. `lstatSync` looks at the folder itself, never at what a link points to.
    let stats: Stats;
    try {
      stats = lstatSync(dir);
    } catch {
      throw conflict(
        `The OpenSpec change \`${id}\` can't be read. A change is only ever written inside the project.`,
        OPENSPEC_CHANGE_ROOT_UNSAFE,
      );
    }
    if (!stats.isDirectory())
      throw conflict(
        `The OpenSpec change \`${id}\` is a ${stats.isSymbolicLink() ? "symbolic link" : "file"}, not a real folder. A change is only ever written inside the project.`,
        OPENSPEC_CHANGE_ROOT_UNSAFE,
      );
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
    // A plain file can take the folder's place between the check and the write; that is a
    // blocked path, not an internal failure, so it gets the same 409 as a checked one.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR")
      throw conflict(
        `The OpenSpec change \`${id}\` can't be written: a file blocks \`openspec/changes/${id}\`. A change is only ever written inside the project.`,
        OPENSPEC_CHANGE_ROOT_UNSAFE,
      );
    throw error;
  }
  return { id, path: `openspec/changes/${id}` };
}
