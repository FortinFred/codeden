import {
  type ForgePr,
  GithubIssue,
  type GithubNewComment,
  GithubPr,
  type GithubSyncStatus,
  type NewEvent,
  type Project,
  type RawEventEnvelope,
} from "@codeden/contracts";
import type { EventStore } from "../../../events/store";
import { errorMessage, ForgeError } from "../../errors";
import { diffIssue, diffPr } from "../../github/diff";
import { isCodedenComment, withoutMarker } from "../../github/issues";
import type { GithubStore, SyncState } from "../../github/store";
import type { ForgejoClient } from "./client";
import { toForgeIssue } from "./map";
import type { ForgejoIssue } from "./types";

/** A project the forge sync serves (`docs/forges.md` §4.4). GitHub projects keep `GithubSync`. */
export type ForgeProject = Extract<Project, { kind: "forge" }>;

export interface ForgejoSyncDeps {
  /** The client for a project, or null when no forge connection is configured. */
  clientFor: (project: ForgeProject) => ForgejoClient | null;
  store: GithubStore;
  events: EventStore;
  /** Projects to consider; only non-archived `forge` projects with a client are synced. */
  projects: () => Project[];
  /** Poll interval with no session PR open (default 60 s). */
  idleIntervalMs?: number;
  /** Poll interval while a session has an open PR (default 15 s). */
  activeIntervalMs?: number;
  /** How often the scheduler checks for due projects (default 5 s). */
  tickMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Schedule {
  nextAt: number;
  intervalMs: number;
  failures: number;
  ticks: number;
}

const ENDED = new Set(["completed", "failed", "stopped"]);
const MAX_BACKOFF_MS = 15 * 60_000;
const NOT_CONNECTED_BACKOFF_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const BASELINE_CAP = 500;
const BASELINE_CLOSED_DAYS = 30;
const BODY_LIMIT = 20_000;
const MAX_NEW_COMMENTS = 10;
/** The incremental cursor is moved back this far, so an inclusive `since` never loses a row. */
const CURSOR_OVERLAP_MS = 60_000;
/** All open PRs are refreshed every this many successful polls, as `GithubSync` does. */
const FULL_REFRESH_EVERY = 4;

/**
 * Polls a Forgejo project for its issues and pull requests (`docs/forges.md` §8.1): a silent
 * baseline of the open items plus the last 30 days of closed ones, then an `updated` cursor
 * (`state=all&since=…&sort=recentupdate`) whose overlap the projection de-duplicates. Each
 * refresh of a PR also reads its commit statuses and reviews, so the same `diffIssue` /
 * `diffPr` rules that drive GitHub produce the projection. Read-only: nothing here writes to
 * the forge.
 */
export class ForgejoSync {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private readonly schedules = new Map<string, Schedule>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly viewers = new WeakMap<ForgejoClient, Promise<string | null>>();

  constructor(private readonly deps: ForgejoSyncDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? 5_000);
    this.timer.unref();
    // A project that becomes a forge project (or moves to another repository) is polled at once.
    this.unsubscribe ??= this.deps.events.subscribe((events) => this.onEvents(events));
    setImmediate(() => this.tick());
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Sync one project now (joins a sync already in flight). */
  syncProject(projectId: string): Promise<void> {
    const inFlight = this.running.get(projectId);
    if (inFlight) return inFlight;
    const project = this.forgeProjects().find((p) => p.id === projectId);
    if (!project) return Promise.resolve();
    const client = this.deps.clientFor(project);
    if (!client) return Promise.resolve();
    const run = this.runSync(project, client).finally(() => this.running.delete(projectId));
    this.running.set(projectId, run);
    return run;
  }

  /** Poll this project at the next scheduler tick (and right away with `now`). */
  soon(projectId: string, opts: { now?: boolean } = {}): void {
    const schedule = this.schedules.get(projectId);
    if (schedule) schedule.nextAt = 0;
    if (opts.now && this.timer) setImmediate(() => this.tick());
  }

  /** True when an open, unlinked PR's head branch is `branch`: a session just started on it. */
  hasUnlinkedPr(projectId: string, branch: string): boolean {
    return this.deps.store
      .prs(projectId, "open")
      .some((pr) => pr.sessionId === null && pr.headBranch === branch);
  }

  status(projectId: string): GithubSyncStatus {
    const state = this.deps.store.syncState(projectId);
    const schedule = this.schedules.get(projectId);
    return {
      projectId,
      lastSyncAt: state.lastSyncAt,
      lastError: state.lastError,
      intervalMs: schedule?.intervalMs ?? this.idleMs(),
      nextSyncAt: schedule ? new Date(Math.max(schedule.nextAt, this.now())).toISOString() : null,
    };
  }

  private tick(): void {
    if (!this.timer) return; // stopped (the database may be closed)
    const now = this.now();
    for (const project of this.forgeProjects()) {
      const schedule = this.schedule(project.id);
      if (now >= schedule.nextAt && !this.running.has(project.id)) {
        void this.syncProject(project.id).catch(() => undefined);
      }
    }
  }

  /** A project's kind changed: a new forge project can start on this tick. */
  private onEvents(events: RawEventEnvelope[]): void {
    for (const e of events) {
      if (e.type !== "project.created" && e.type !== "project.updated") continue;
      const project = (e.payload as { project?: Project }).project;
      if (project?.kind === "forge" && project.archivedAt === null) {
        this.soon(project.id, { now: true });
      }
    }
  }

  private forgeProjects(): ForgeProject[] {
    return this.deps
      .projects()
      .filter(
        (p): p is ForgeProject =>
          p.kind === "forge" && p.archivedAt === null && this.deps.clientFor(p) !== null,
      );
  }

  private schedule(projectId: string): Schedule {
    let schedule = this.schedules.get(projectId);
    if (!schedule) {
      schedule = { nextAt: 0, intervalMs: this.idleMs(), failures: 0, ticks: 0 };
      this.schedules.set(projectId, schedule);
    }
    return schedule;
  }

  private async runSync(project: ForgeProject, client: ForgejoClient): Promise<void> {
    const schedule = this.schedule(project.id);
    const state = this.deps.store.syncState(project.id);
    try {
      if (!state.baselineAt) await this.baseline(project, client, state);
      else await this.incremental(project, client, state, schedule.ticks);
      state.lastError = null;
      schedule.failures = 0;
      schedule.ticks++;
      schedule.intervalMs = this.hasActiveSessionPr(project.id)
        ? (this.deps.activeIntervalMs ?? 15_000)
        : this.idleMs();
      schedule.nextAt = this.now() + schedule.intervalMs;
    } catch (error) {
      schedule.failures++;
      state.lastError = errorMessage(error);
      if (error instanceof ForgeError && error.forgeCode === "forge_rate_limited") {
        schedule.nextAt =
          this.now() + Math.min(error.retryAfterMs ?? RATE_LIMIT_BACKOFF_MS, MAX_BACKOFF_MS);
      } else if (error instanceof ForgeError && error.forgeCode === "forge_not_connected") {
        schedule.nextAt = this.now() + NOT_CONNECTED_BACKOFF_MS;
      } else {
        const backoff = Math.min(this.idleMs() * 2 ** (schedule.failures - 1), MAX_BACKOFF_MS);
        schedule.nextAt = this.now() + backoff;
        this.deps.log?.(
          `forge sync ${project.forge.owner}/${project.forge.repo}: ${state.lastError}`,
        );
      }
      throw error;
    } finally {
      state.lastSyncAt = new Date(this.now()).toISOString();
      this.deps.store.saveSyncState(project.id, state);
    }
  }

  /** First import: open issues and PRs plus recently closed ones, as one silent event. */
  private async baseline(
    project: ForgeProject,
    client: ForgejoClient,
    state: SyncState,
  ): Promise<void> {
    const open = await client.listIssueRows({ state: "open", limit: BASELINE_CAP });
    const since = new Date(this.now() - BASELINE_CLOSED_DAYS * 86_400_000).toISOString();
    const closed = await client.listIssueRows({
      state: "closed",
      since,
      sort: "recentupdate",
      limit: BASELINE_CAP,
    });
    const listed = [...open, ...closed];
    const issues = listed
      .filter((row) => !row.pull_request)
      .map((row) => this.issueOf(project.id, row));
    const numbers = [...new Set(listed.filter((row) => row.pull_request).map((row) => row.number))];
    const prs: ForgePr[] = [];
    for (const number of numbers) prs.push(await this.prOf(client, project.id, number, undefined));
    // The import itself is silent, but a PR that already belongs to a session gets a
    // `pr.updated`, so the session's PR link follows as it would for a PR opened later.
    const linked: NewEvent[] = prs
      .filter((pr) => pr.sessionId !== null)
      .map((pr) => ({
        type: "pr.updated",
        sessionId: pr.sessionId,
        payload: { pr, changes: ["sessionId"] },
      }));
    this.deps.events.append([
      { type: "forge.synced", sessionId: null, payload: { projectId: project.id, issues, prs } },
      ...linked,
    ]);
    state.since = maxUpdated(listed, state.since);
    state.baselineAt = state.since ?? new Date(this.now()).toISOString();
  }

  private async incremental(
    project: ForgeProject,
    client: ForgejoClient,
    state: SyncState,
    tick: number,
  ): Promise<void> {
    const since = state.since
      ? new Date(Date.parse(state.since) - CURSOR_OVERLAP_MS).toISOString()
      : undefined;
    const rows = await client.listIssueRows({
      state: "all",
      ...(since ? { since } : {}),
      sort: "recentupdate",
    });
    const events: NewEvent[] = [];
    const changedPrs = new Set<number>();
    for (const raw of rows) {
      if (raw.pull_request) {
        changedPrs.add(raw.number);
        continue;
      }
      const next = this.issueOf(project.id, raw);
      const prev = this.deps.store.issue(project.id, raw.number);
      events.push(...diffIssue(prev, next, { importedBefore: state.baselineAt }));
    }
    // The cursor keeps the newest row's `updated_at`; the overlap is applied when reading it.
    // It moves only once this pass's events are appended, so a failed pass re-reads its window.
    const nextSince = maxUpdated(rows, state.since);

    const refresh = new Set(changedPrs);
    const sessionBranches = this.sessionBranches(project.id);
    for (const pr of this.deps.store.prs(project.id, "open")) {
      const unsettled = pr.checks.state === "pending" || pr.mergeable === "unknown";
      // An unlinked PR whose head branch a session now works on is linked on this poll.
      const linkable = pr.sessionId === null && sessionBranches.has(pr.headBranch);
      if (unsettled || linkable || pr.sessionId !== null || tick % FULL_REFRESH_EVERY === 0) {
        refresh.add(pr.number);
      }
    }
    if (refresh.size > 0) {
      const viewer = await this.viewer(client);
      for (const number of refresh) {
        const prev = this.deps.store.pr(project.id, number);
        const next = await this.prOf(client, project.id, number, prev);
        events.push(...diffPr(prev, next, { importedBefore: state.baselineAt, viewer }));
      }
    }
    await this.fillNewComments(client, project.id, events);
    if (events.length > 0) this.deps.events.append(events);
    state.since = nextSince;
  }

  /** Read the new comments of each `issue.commented` (best effort: left empty on errors). */
  private async fillNewComments(
    client: ForgejoClient,
    projectId: string,
    events: NewEvent[],
  ): Promise<void> {
    for (const e of events) {
      if (e.type !== "issue.commented") continue;
      const payload = e.payload as { issue: GithubIssue; comments: GithubNewComment[] };
      const prev = this.deps.store.issue(projectId, payload.issue.number);
      const added = Math.max(1, payload.issue.comments - (prev?.comments ?? 0));
      try {
        const listed = await client.comments(payload.issue.number, {
          ...(prev ? { since: prev.updatedAt } : {}),
        });
        payload.comments = listed.slice(-Math.min(added, MAX_NEW_COMMENTS)).map((c) => {
          const body = withoutMarker(c.body);
          return {
            id: c.id,
            author: c.author,
            body: body.length > BODY_LIMIT ? body.slice(0, BODY_LIMIT) : body,
            createdAt: c.createdAt,
            url: c.url || payload.issue.url,
            fromCodeden: isCodedenComment(c.body),
          };
        });
      } catch (error) {
        this.deps.log?.(`forge sync: comments of #${payload.issue.number}: ${errorMessage(error)}`);
      }
    }
  }

  private issueOf(projectId: string, raw: ForgejoIssue): GithubIssue {
    const issue = toForgeIssue(projectId, raw);
    return issue.body && issue.body.length > BODY_LIMIT
      ? GithubIssue.parse({ ...issue, body: issue.body.slice(0, BODY_LIMIT) })
      : issue;
  }

  /** Read one PR's fresh row and link it to its session: kept from before, or on its branch. */
  private async prOf(
    client: ForgejoClient,
    projectId: string,
    number: number,
    prev: ForgePr | undefined,
  ): Promise<GithubPr> {
    const snapshot = await client.prSnapshot(number);
    let sessionId = prev?.sessionId ?? null;
    if (!sessionId) {
      const owner = this.deps.store
        .projectSessions(projectId)
        .filter((s) => s.branch === snapshot.headBranch || s.pr?.number === number)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      sessionId = owner?.id ?? null;
    }
    return GithubPr.parse({ ...snapshot, sessionId });
  }

  /** Branches of the project's sessions (to link PRs opened on them). */
  private sessionBranches(projectId: string): Set<string> {
    const branches = new Set<string>();
    for (const s of this.deps.store.projectSessions(projectId)) {
      if (s.branch) branches.add(s.branch);
    }
    return branches;
  }

  private hasActiveSessionPr(projectId: string): boolean {
    const sessions = new Map(this.deps.store.projectSessions(projectId).map((s) => [s.id, s]));
    return this.deps.store.prs(projectId, "open").some((pr) => {
      const session = pr.sessionId ? sessions.get(pr.sessionId) : undefined;
      return session !== undefined && !ENDED.has(session.status);
    });
  }

  /**
   * The login the pass reads with, asked once per client and kept: `review.submitted` carries
   * it so a review by the account CodeDen uses counts as its own (`docs/forges.md` §6.2). A
   * repository-only token cannot answer; the pass then stamps `null`.
   */
  private viewer(client: ForgejoClient): Promise<string | null> {
    const cached = this.viewers.get(client);
    if (cached) return cached;
    const value = client.viewer().catch((error: unknown) => {
      if (!(error instanceof ForgeError)) {
        this.deps.log?.(`forge sync: reading the viewer: ${errorMessage(error)}`);
      }
      return null;
    });
    this.viewers.set(client, value);
    return value;
  }

  private idleMs(): number {
    return this.deps.idleIntervalMs ?? 60_000;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function maxUpdated(items: Array<{ updated_at?: string }>, current: string | null): string | null {
  let max = current;
  let maxAt = current ? Date.parse(current) : Number.NaN;
  if (!Number.isFinite(maxAt)) maxAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (!item.updated_at) continue;
    const at = Date.parse(item.updated_at);
    if (!Number.isFinite(at) || at <= maxAt) continue;
    max = item.updated_at;
    maxAt = at;
  }
  return max;
}
