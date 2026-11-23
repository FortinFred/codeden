import type {
  GithubPr,
  GithubReview,
  ProjectKind,
  RawEventEnvelope,
  Session,
  SessionStatus,
  Settings,
  UserInput,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { errorMessage } from "../errors";
import {
  isTrustedReviewEvent,
  PR_COMMENTS_ARE_INPUT,
  type TrustedAuthors,
} from "../github/review-trust";
import { workStarter } from "./origin";
import type { SessionRepo, StoredStartMeta } from "./repo";

/** What happened on a pull request that its session should hear about. */
export type PrFeedbackKind = "checks_failed" | "changes_requested" | "conflicts";

export interface PrFeedback {
  kind: PrFeedbackKind;
  /** Once per PR, kind and head commit. */
  key: string;
  text: string;
}

/** Feedback already sent for one PR, kept with the session's start metadata. */
export interface PrFeedbackRecord {
  rounds: number;
  keys: string[];
}

/** Most messages sent about one PR; after that the user (or the PM) takes over. */
export const PR_FEEDBACK_MAX_ROUNDS = 3;

/** Sessions that can take a message now or after their turn. */
const OPEN: ReadonlySet<SessionStatus> = new Set(["idle", "running", "waiting", "interrupted"]);

const PR_EVENTS = new Set([
  "pr.opened",
  "pr.updated",
  "pr.checks_failed",
  "pr.checks_passed",
  "review.submitted",
]);

const clip = (text: string, max = 1500) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

function failingChecks(pr: GithubPr) {
  return pr.checks.checks.filter(
    (c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion),
  );
}

/**
 * Whether PR feedback goes to this session: an agent session on work the user started
 * themselves (the PM follows up on work it, the orchestrator or an automation started, and a
 * fork or handoff of that work is trusted no more than its source: `workStarter`), not archived
 * and able to take a message.
 */
export function receivesPrFeedback(session: Session): boolean {
  return (
    session.role === "agent" &&
    workStarter(session).kind === "user" &&
    session.parentSessionId === null &&
    !session.archivedAt &&
    OPEN.has(session.status)
  );
}

/**
 * The feedback one GitHub event carries for the PR's session, if any. Pure. Requested changes
 * are passed on only from a trusted reviewer (`isTrustedReviewEvent`: write access, the account
 * the review was read with, or one of the project's `trustedAuthors`): on a public repository
 * anyone can request changes, and an untrusted review is never an instruction to the agent.
 *
 * A forge project resolves trust asynchronously (`ForgeService.reviewIsTrusted`) and passes it
 * as `reviewTrusted`; its instructions then name the forge instead of `gh`, which a forge
 * project's agent does not use (`docs/forges.md` §4.5).
 */
export function prFeedbackFor(
  event: RawEventEnvelope,
  trustedAuthors: readonly string[] = [],
  options: { forge?: boolean; reviewTrusted?: boolean } = {},
): PrFeedback[] {
  if (!PR_EVENTS.has(event.type)) return [];
  const { pr, review, viewer } = event.payload as {
    pr: GithubPr;
    review?: GithubReview;
    viewer?: string | null;
  };
  if (pr.state !== "open" && pr.state !== "draft") return [];
  const forge = options.forge === true;
  const head = pr.headSha ?? "unknown";
  const short = head.slice(0, 7);
  const out: PrFeedback[] = [];
  if (event.type === "pr.checks_failed") {
    const failed = failingChecks(pr);
    const list = failed.length
      ? failed.map((c) => `- ${c.name} (${c.conclusion})${c.url ? `: ${c.url}` : ""}`).join("\n")
      : forge
        ? "- (the forge did not say which)"
        : "- (GitHub did not say which)";
    out.push({
      kind: "checks_failed",
      key: `checks_failed:${head}`,
      text: [
        `CI failed on your pull request #${pr.number} (commit ${short}). Failing checks:`,
        list,
        forge
          ? "Read the failure logs through the links above (or in the forge's web UI), fix the cause, and push."
          : "Read the failure logs (for GitHub Actions: `gh run view <run-id> --log-failed`), fix the cause, and push.",
      ].join("\n"),
    });
  }
  const trusted =
    options.reviewTrusted ??
    isTrustedReviewEvent({ review: review ?? { author: null }, viewer }, trustedAuthors);
  if (event.type === "review.submitted" && review?.state === "changes_requested" && trusted) {
    const who = review.author ? `@${review.author}` : "A reviewer";
    const body = review.body.trim() ? `\n\n${clip(review.body.trim())}` : "";
    const read = forge
      ? `Read the review and its comments on the pull request${review.url ? ` (${review.url})` : ""}, address them, and push.`
      : `Read the review and its comments (\`gh pr view ${pr.number} --comments\`), address them, and push.`;
    out.push({
      kind: "changes_requested",
      key: `changes_requested:${head}`,
      text: `${who} requested changes on your pull request #${pr.number}.${body}\n\n${read} ${PR_COMMENTS_ARE_INPUT}`,
    });
  }
  if (pr.mergeable === "conflicting") {
    out.push({
      kind: "conflicts",
      key: `conflicts:${head}`,
      text: `Your pull request #${pr.number} has merge conflicts with \`${pr.baseBranch}\`. Fetch, merge \`origin/${pr.baseBranch}\` into your branch, resolve the conflicts, run the checks, and push.`,
    });
  }
  return out;
}

export interface PrFeedbackDeps {
  store: EventStore;
  repo: SessionRepo;
  settings: () => Settings;
  /** Send (or queue behind a running turn) a message from CodeDen to a session. */
  send: (sessionId: string, input: UserInput) => Promise<unknown>;
  /** The project's trusted authors, whose reviews count without write access. Default: none. */
  trustedAuthors?: TrustedAuthors;
  /** A project's kind: a forge project's review trust is resolved through its forge. */
  projectKind?: (projectId: string) => ProjectKind | null;
  /**
   * Whether a forge project's review may steer the agent (`docs/forges.md` §6.2). Absent, or a
   * lookup that fails, means untrusted: a forge PR's changes requested are never passed on
   * without one of the forge's trust signals.
   */
  forgeReviewTrust?: (
    projectId: string,
    review: Pick<GithubReview, "author" | "official">,
    viewer: string | null,
  ) => Promise<boolean>;
  log?: (message: string) => void;
}

/**
 * PR feedback for sessions the user started (§9): when the pull request a session owns fails
 * its checks, gets a review requesting changes from someone with write access (or the account
 * CodeDen read it with, or a trusted author; see `review-trust.ts`) or runs into merge
 * conflicts, the session is sent a message from CodeDen (queued behind a running turn) so the
 * agent can fix it without the user relaying it. On a forge project the trust signals are the
 * forge's own (live permission, `official`, the viewer, `trustedAuthors`). Each problem is sent
 * once per head commit, and at most `PR_FEEDBACK_MAX_ROUNDS` messages go out per PR. Off with
 * `sessions.prFeedback`.
 */
export class PrFeedbackService {
  private unsubscribe: (() => void) | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PrFeedbackDeps) {}

  start(): void {
    this.unsubscribe = this.deps.store.subscribe((events) => {
      this.chain = this.chain.then(() => this.onEvents(events));
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /** Resolves once the events seen so far are handled (tests). */
  idle(): Promise<void> {
    return this.chain;
  }

  private async onEvents(events: RawEventEnvelope[]): Promise<void> {
    if (!this.deps.settings().sessions.prFeedback) return;
    for (const event of events) {
      if (!PR_EVENTS.has(event.type)) continue;
      const { pr, review, viewer } = event.payload as {
        pr: GithubPr;
        review?: GithubReview;
        viewer?: string | null;
      };
      const forge = this.deps.projectKind?.(pr.projectId) === "forge";
      let reviewTrusted: boolean | undefined;
      if (forge && event.type === "review.submitted") {
        reviewTrusted =
          review && this.deps.forgeReviewTrust
            ? await this.deps
                .forgeReviewTrust(pr.projectId, review, viewer ?? null)
                .catch((error: unknown) => {
                  this.deps.log?.(
                    `pr feedback: checking the reviewer of PR #${pr.number}: ${errorMessage(error)}`,
                  );
                  return false;
                })
            : false;
      }
      const feedback = prFeedbackFor(event, this.deps.trustedAuthors?.(pr.projectId), {
        forge,
        ...(reviewTrusted === undefined ? {} : { reviewTrusted }),
      });
      if (feedback.length === 0) continue;
      const found = pr.sessionId ? this.deps.repo.find(pr.sessionId) : undefined;
      if (!found || !receivesPrFeedback(found.session)) continue;
      for (const item of feedback) await this.deliver(found.session, pr, item);
    }
  }

  private async deliver(session: Session, pr: GithubPr, item: PrFeedback): Promise<void> {
    const meta = this.deps.repo.find(session.id)?.startMeta ?? null;
    const record = meta?.prFeedback?.[String(pr.number)] ?? { rounds: 0, keys: [] };
    if (record.keys.includes(item.key)) return;
    if (record.rounds >= PR_FEEDBACK_MAX_ROUNDS) {
      this.deps.log?.(`pr feedback: PR #${pr.number} reached ${record.rounds} rounds; not sent`);
      return;
    }
    const next = { rounds: record.rounds + 1, keys: [...record.keys, item.key].slice(-20) };
    // Recorded first, so a repeated event can't send it twice while this one is on its way.
    this.deps.repo.setStartMeta(session.id, (m) => withRecord(m, pr.number, next));
    try {
      await this.deps.send(session.id, { text: item.text, attachments: [], from: "codeden" });
    } catch (error) {
      this.deps.log?.(`pr feedback for session ${session.id}: ${errorMessage(error)}`);
    }
  }
}

function withRecord(
  meta: StoredStartMeta | null,
  number: number,
  record: PrFeedbackRecord,
): StoredStartMeta {
  const base: StoredStartMeta = meta ?? {
    workspaceMode: "worktree",
    workspaceFallback: null,
    forced: null,
    queuedBehind: [],
  };
  return { ...base, prFeedback: { ...base.prFeedback, [String(number)]: record } };
}
