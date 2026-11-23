import { z } from "zod";
import { IssueFileComment } from "./comments";
import {
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_COMMENTS,
  MAX_ISSUE_LABEL_LENGTH,
  MAX_ISSUE_LABELS,
  MAX_ISSUE_TITLE_LENGTH,
} from "./limits";
import { IssueFileTimestamp } from "./timestamp";

/** Why a closed issue was closed (§5.2); `null` means unknown, never "completed". */
export const IssueFileStateReason = z.enum(["completed", "not_planned", "duplicate"]);
export type IssueFileStateReason = z.infer<typeof IssueFileStateReason>;

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
