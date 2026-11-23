import { z } from "zod";
import { Id, Timestamp } from "./common";

/**
 * File-backed issues (`docs/issue-sources.md`): where a project's issues come from, the shape of
 * an issue file, the problems a folder scan reports and the numbering rules. The parser and
 * renderer live in `issue-file-format.ts`; this module is the data model both phases share, with
 * no Node APIs.
 */

// ---------------------------------------------------------------- settings

/** Default repository-relative folder for file-backed issues (§5.1). */
export const DEFAULT_ISSUE_FOLDER = ".codeden/issues";

/** Where a project's issues come from (§4.1). Default: its forge, as before this setting existed. */
export const IssueSource = z.enum(["forge", "folder"]);
export type IssueSource = z.infer<typeof IssueSource>;

/**
 * What a project's issues resolve to once its kind and settings are applied (§4.3):
 * `forge` for a GitHub or Forgejo connection, `folder` for files in the repository, and `none`
 * for a local project left on the default source. UI and orchestration read this, never `kind`.
 */
export const IssueSourceKind = z.enum(["forge", "folder", "none"]);
export type IssueSourceKind = z.infer<typeof IssueSourceKind>;

/**
 * Why a repository-relative issue folder is not usable, or null when it is (§4.1). Absolute
 * paths, home paths, drive letters and `..` are refused: the folder must be inside the
 * repository, because commits are what make its issues trusted.
 */
export function issueFolderProblem(folder: string): string | null {
  const value = folder.trim();
  if (!value) return "it is empty";
  if (/^[\\/]/.test(value)) return "it must be repository-relative, not absolute";
  if (/^[A-Za-z]:/.test(value)) return "it must be repository-relative, not a drive path";
  if (/^~([\\/]|$)/.test(value)) return "it must be repository-relative, not a home path";
  if (/\p{Cc}/u.test(value)) return "it must not contain control characters";
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return "it must name a folder inside the repository";
  if (segments.includes("..")) return "it must not contain `..`";
  return null;
}

/**
 * The canonical form of an issue folder: forward slashes, no leading `./`, no doubled or
 * trailing slashes. Callers validate with `issueFolderProblem` first.
 */
export function normalizeIssueFolder(folder: string): string {
  return folder
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * The absolute path of the issue folder inside a project, or null when the folder setting is
 * invalid (§4.1). The separator follows `projectPath`, since this is display and filesystem
 * work, not repository-relative data.
 */
export function resolveIssueFolderPath(projectPath: string, folder: string): string | null {
  if (issueFolderProblem(folder)) return null;
  const windows =
    /^[A-Za-z]:[\\/]/.test(projectPath) ||
    (projectPath.includes("\\") && !projectPath.includes("/"));
  const base = projectPath.replace(/[\\/]+$/, "");
  const segments = normalizeIssueFolder(folder).split("/");
  return [base, ...segments].join(windows ? "\\" : "/");
}

/**
 * Where a project's issues come from (§4.1). `folder` is repository-relative and only meaningful
 * when `source` is `folder`; it is ignored (but kept) on a forge source, so switching back and
 * forth does not lose it. The defaults make every `project.created`/`project.updated` payload
 * written before this setting existed parse as `{ source: "forge", folder: ".codeden/issues" }`.
 */
export const IssueSourceSettings = z.object({
  source: IssueSource.default("forge"),
  folder: z
    .string()
    .min(1)
    .default(DEFAULT_ISSUE_FOLDER)
    .superRefine((folder, ctx) => {
      const problem = issueFolderProblem(folder);
      if (problem) {
        ctx.addIssue({ code: "custom", message: `Invalid issue folder: ${problem}` });
      }
    })
    .transform(normalizeIssueFolder),
});
export type IssueSourceSettings = z.infer<typeof IssueSourceSettings>;

// ---------------------------------------------------------------- operational state

/**
 * Which file a folder scan could not use and why (§5.7, §11 phase 1). Problems are rebuilt by
 * every scan and shown in the UI; they are not events. A problem on one file never changes
 * another issue, and a malformed file never deletes a previously synced row.
 */
export const IssueFileProblem = z.object({
  /**
   * `bad_name`: a `.md` file whose name is not `NNNN-<slug>.md` (a typo, a numberless name, a
   * subdirectory entry). `malformed`: the file's front matter, body, comments, encoding or size
   * break the format, including a missing `title`/`state`, an unknown key, a number mismatch or
   * too many comments. `duplicate`: another file carries the same number; neither is read.
   * `missing_number`: the front matter has no `number` (the filename's number is not assumed).
   * `bad_folder`: the folder setting is not a usable repository-relative folder, or a scanned
   * path is not directly inside it.
   */
  kind: z.enum(["bad_name", "malformed", "duplicate", "missing_number", "bad_folder"]),
  /**
   * Repository-relative path with forward slashes: the issue file, or the folder itself for
   * `bad_folder`.
   */
  path: z.string().min(1),
  /** What is wrong, for a person, including the offending field or line where known. */
  detail: z.string().min(1),
});
export type IssueFileProblem = z.infer<typeof IssueFileProblem>;

/**
 * The state of a project's issue source (`GET /api/projects/:id/github/issues`, §10): which
 * source answered, whether files can be written, whether the last scan was stale, the problems
 * that scan reported and when the source's silent baseline last succeeded.
 */
export const IssueSourceStatus = z.object({
  projectId: Id,
  /** What the project's issues resolve to (§4.3); `none`: a local project without folder issues. */
  source: IssueSourceKind,
  /** The repository-relative issue folder for a `folder` source; null for a forge or `none`. */
  folder: z.string().nullable(),
  /** True when CodeDen can write issue files: a `folder` source on a git-backed project. */
  writable: z.boolean(),
  /** The last scan read a previously fetched ref because the forge or fetch failed (§6.1). */
  stale: z.boolean().default(false),
  /** Problems the last scan reported (§5.7); empty when all files are readable. */
  problems: z.array(IssueFileProblem).default([]),
  /** When the source's silent baseline completed; null before the first one (§6.3). */
  baselineAt: Timestamp.nullable().default(null),
  /** When the last scan finished, successfully or not. */
  lastSyncAt: Timestamp.nullable().default(null),
  /** Why the last scan failed, e.g. `not_a_repo` or `folder_missing`; null when it did not. */
  lastError: z.string().nullable().default(null),
});
export type IssueSourceStatus = z.infer<typeof IssueSourceStatus>;

// ---------------------------------------------------------------- the issue file

/** Most labels one issue may carry (§5.3). */
export const MAX_ISSUE_LABELS = 20;
/** Longest label name (§5.3). */
export const MAX_ISSUE_LABEL_LENGTH = 100;
/** Longest issue title (§5.3). */
export const MAX_ISSUE_TITLE_LENGTH = 256;
/** Most comments one issue file may hold (§5.4). */
export const MAX_ISSUE_COMMENTS = 200;
/** Longest body an issue file may hold; the projection truncates at 20,000 (§5.4). */
export const MAX_ISSUE_BODY_LENGTH = 65_000;
/** Largest issue file (§5.7). */
export const MAX_ISSUE_FILE_BYTES = 1024 * 1024;
/** Largest front matter section of an issue file (§5.7). */
export const MAX_ISSUE_FRONT_MATTER_BYTES = 64 * 1024;

/**
 * A timestamp as an issue file holds it (§5.8): RFC 3339, UTC, `Z` suffix, second precision. The
 * parser accepts fractional seconds and numeric offsets from hand edits and normalizes them to
 * this form; the renderer only writes this form.
 */
export const IssueFileTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    "must be an RFC 3339 UTC timestamp with second precision, e.g. 2026-11-23T09:14:00Z",
  );
export type IssueFileTimestamp = z.infer<typeof IssueFileTimestamp>;

const ISSUE_TIMESTAMP_INPUT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Normalize an RFC 3339 timestamp to the file format's UTC second precision, or null when it is
 * not a real timestamp. Fractional seconds are dropped and numeric offsets converted, which is
 * what §5.8 asks of a hand edit; a date a YAML parser read without quotes is just a string here.
 */
export function normalizeIssueTimestamp(value: string): string | null {
  const match = ISSUE_TIMESTAMP_INPUT.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac, zone = "Z"] = match;
  const year = Number(y ?? 0);
  const month = Number(mo ?? 0);
  const day = Number(d ?? 0);
  const hour = Number(h ?? 0);
  const minute = Number(mi ?? 0);
  const second = Number(s ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const whole = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(whole.getTime())) return null;
  if (
    whole.getUTCFullYear() !== year ||
    whole.getUTCMonth() !== month - 1 ||
    whole.getUTCDate() !== day
  ) {
    return null;
  }
  const millis = frac ? Number(frac.slice(0, 3).padEnd(3, "0")) : 0;
  let offsetMs = 0;
  if (zone !== "Z" && zone !== "z") {
    const [offsetHours = 0, offsetMinutes = 0] = zone.slice(1).split(":").map(Number);
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offsetMs = (zone.startsWith("-") ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  }
  const iso = new Date(whole.getTime() + millis - offsetMs).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

/** Why a closed issue was closed (§5.2); `null` means unknown, never "completed". */
export const IssueFileStateReason = z.enum(["completed", "not_planned", "duplicate"]);
export type IssueFileStateReason = z.infer<typeof IssueFileStateReason>;

/**
 * A comment's author as the appendix header shows it (§5.8): `@login` for a person, `local` when
 * no login is known, `codeden` for CodeDen itself. Without the `@` it is the front matter's
 * `author` form.
 */
export const IssueFileCommentAuthor = z
  .string()
  .regex(/^(?:@[A-Za-z0-9._-]+|local|codeden)$/, "must be @login, local or codeden");
export type IssueFileCommentAuthor = z.infer<typeof IssueFileCommentAuthor>;

/**
 * One append-only comment entry (§5.4). `id` is derived from the entry's immutable data — not its
 * position — so a hand deletion elsewhere does not renumber the others; the position is only the
 * `#comment-<ordinal>` anchor.
 */
export const IssueFileComment = z.object({
  /**
   * Stable 53-bit hash of `createdAt`, `author` and `body` (`issueCommentId`); it does not change
   * when other comments are added or removed.
   */
  id: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /**
   * The header's author token: `@login`, `local` or `codeden`. Display metadata; trust comes from
   * the default branch, never from this field.
   */
  author: IssueFileCommentAuthor,
  /** Comment Markdown, stored as written; the projection truncates it at 20,000 characters. */
  body: z.string().min(1).max(MAX_ISSUE_BODY_LENGTH),
  /** The entry header's timestamp, second precision UTC. */
  createdAt: IssueFileTimestamp,
});
export type IssueFileComment = z.infer<typeof IssueFileComment>;

/**
 * A comment's stable id: a 53-bit hash of its timestamp, author and body (§5.4). Deterministic
 * across servers and clones, independent of position, and safe as a JavaScript integer.
 */
export function issueCommentId(
  comment: Pick<IssueFileComment, "createdAt" | "author" | "body">,
): number {
  const text = `${comment.createdAt}\u0000${comment.author}\u0000${comment.body}`;
  // cyrb53, folded into 53 bits.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** The `url` fragment for a comment's position in the appendix: `#comment-<ordinal>` (§5.4). */
export function issueCommentAnchor(ordinal: number): string {
  return `#comment-${ordinal}`;
}

/** A pull request a folder issue mentions (§5.3); the forge stays authoritative for its state. */
export const IssueFilePullRequest = z.object({
  number: z.int().positive(),
  /** A forge PR URL, when the writer knew one; informational only. */
  url: z.url().optional(),
});
export type IssueFilePullRequest = z.infer<typeof IssueFilePullRequest>;

/**
 * One parsed issue file (§5.3–§5.4): its front matter and the body below it, with the comments
 * appendix as `comments`. This is the canonical form: the parser normalizes dates, filenames and
 * line endings into it, and `renderIssue` writes it back so `parse(render(file))` returns it
 * unchanged. `updatedAt` stays nullable because a hand-written file may not carry one and the
 * scan falls back to the file's last commit time (§6.4).
 */
export const IssueFile = z
  .object({
    /** Identity, equal to the filename's number (§5.5). */
    number: z.int().positive(),
    title: z.string().min(1).max(MAX_ISSUE_TITLE_LENGTH),
    state: z.enum(["open", "closed"]),
    /** Why it was closed; null while open or when unknown (§5.2). */
    stateReason: IssueFileStateReason.nullable().default(null),
    /** When CodeDen closed it, or an approximation of a hand close (§5.3). */
    closedAt: IssueFileTimestamp.nullable().default(null),
    /** Free-form labels, order preserved, duplicates removed; no label catalog (§5.6). */
    labels: z
      .array(z.string().min(1).max(MAX_ISSUE_LABEL_LENGTH))
      .max(MAX_ISSUE_LABELS)
      .default([]),
    /** A login without `@`, `local` or `codeden`; display metadata, never trust (§5.8). */
    author: z.string().min(1).max(100).nullable().default(null),
    /** The first commit that added the file, when known; never the baseline time (§6.4). */
    createdAt: IssueFileTimestamp.nullable().default(null),
    /** The file's last commit time, or the value CodeDen wrote on its last write (§6.4). */
    updatedAt: IssueFileTimestamp.nullable().default(null),
    /** Forge PR numbers this issue mentions, informational (§5.3). */
    pullRequests: z.array(IssueFilePullRequest).default([]),
    /** Markdown below the front matter, without the comments appendix (§5.4). */
    body: z.string().max(MAX_ISSUE_BODY_LENGTH).default(""),
    /** Entries under the comments marker, oldest first, at most 200 (§5.4). */
    comments: z.array(IssueFileComment).max(MAX_ISSUE_COMMENTS).default([]),
  })
  .superRefine((file, ctx) => {
    if (file.state === "open" && file.stateReason !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["stateReason"],
        message: "stateReason must be null while the issue is open",
      });
    }
  });
export type IssueFile = z.infer<typeof IssueFile>;

// ---------------------------------------------------------------- file names and slugs

/** `NNNN-<slug>.md`: at least four digits, a lowercase ASCII slug, lowercase `.md` (§5.1). */
export const ISSUE_FILE_NAME_PATTERN = /^(\d{4,})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** Longest slug, in characters (§5.1). */
export const MAX_ISSUE_SLUG_LENGTH = 60;

/** Files a repository may keep in the issue folder without them being issues (§5.1). */
export const ISSUE_IGNORED_FILE_NAMES: readonly string[] = ["README.md", ".gitkeep"];

/**
 * The number and slug of an issue file name, or null when the name is not one. A name that
 * matches the pattern but whose slug is over 60 characters is not an issue file: the limit is
 * what a person reads, not identity.
 */
export function parseIssueFileName(name: string): { number: number; slug: string } | null {
  const match = ISSUE_FILE_NAME_PATTERN.exec(name);
  if (!match) return null;
  const slug = match[2] ?? "";
  if (slug.length > MAX_ISSUE_SLUG_LENGTH) return null;
  const number = Number(match[1] ?? "");
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { number, slug };
}

/** The canonical filename for a number and title: `0042-export-as-csv.md` (§5.1, §8.2). */
export function issueFileName(number: number, title: string): string {
  return `${String(number).padStart(4, "0")}-${issueSlug(title)}.md`;
}

/**
 * A title as a filename slug (§8.2): lower-case ASCII letters and digits, other runs collapsed
 * to `-`, trimmed to 1–60 characters, `issue` when nothing survives. It never changes after the
 * file is created, even when the title does.
 */
export function issueSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ISSUE_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "issue";
}

// ---------------------------------------------------------------- numbering ledger

/** The reservation ledger's filename inside the issue folder (§5.5); not an issue file. */
export const ISSUE_NUMBER_LEDGER_FILE = ".numbers";

/**
 * `<folder>/.numbers` (§5.5): `next` is the next number to hand out. The ledger is committed
 * repository data and the cross-server allocator, not a cache: a reservation moves it with a
 * compare-and-swap write, so two clones cannot receive the same number. It holds no other state.
 */
export const IssueNumberLedger = z.object({ next: z.int().positive() }).strict();
export type IssueNumberLedger = z.infer<typeof IssueNumberLedger>;

/** What reading a ledger file gave: a ledger, no ledger yet, or a malformed one (§5.5). */
export type IssueNumberLedgerRead =
  | { ok: true; ledger: IssueNumberLedger | null }
  | { ok: false; detail: string };

/**
 * Read the `.numbers` file. A missing ledger is not an error — the next number is derived from
 * the files (§5.5) — but a malformed one is returned as such, so reads still work and creates are
 * refused until a person fixes it.
 */
export function parseIssueNumberLedger(text: string | null): IssueNumberLedgerRead {
  if (text === null) return { ok: true, ledger: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, detail: "The number ledger is not valid JSON" };
  }
  const parsed = IssueNumberLedger.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      detail: 'The number ledger must be exactly { "next": <positive integer> }',
    };
  }
  return { ok: true, ledger: parsed.data };
}

/** The canonical `.numbers` content: fixed two-space JSON with a trailing newline. */
export function renderIssueNumberLedger(ledger: IssueNumberLedger): string {
  return `${JSON.stringify({ next: ledger.next }, null, 2)}\n`;
}

/**
 * The next number to allocate (§5.5): `max(ledger.next, max file number + 1)`, at least 1. A
 * ledger below an existing file is corrected upward here, never downward; a gap left by a
 * reservation that never wrote its file stays, so numbers are never reused.
 */
export function nextIssueNumber(input: {
  ledgerNext?: number | null;
  numbers?: readonly number[];
}): number {
  const ledgerNext = input.ledgerNext ?? 1;
  const highest = input.numbers?.reduce((max, number) => Math.max(max, number), 0) ?? 0;
  return Math.max(ledgerNext, highest + 1, 1);
}
