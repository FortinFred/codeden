import {
  type CreateGithubIssueRequest,
  type ForgePr,
  type ForgeRepo,
  type GithubConnection,
  type GithubIssue,
  GithubIssueDetails,
  type GithubIssuesResponse,
  type GithubLabelRequest,
  GithubPr,
  GithubPrDetails,
  type GithubPrDiff,
  type GithubPrsResponse,
  type GithubReview,
  type GithubSyncStatus,
  type Project,
  type Session,
  type Settings,
  type TriageIssueRequest,
  type TriageIssueResult,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import type { ArtifactService } from "../artifacts";
import { conflict, ForgeError } from "../errors";
import type { AttachEvidenceInput, AttachEvidenceResult } from "../github/attach";
import { withoutMarker } from "../github/issues";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../github/pull-requests";
import type { GithubStore, IssueStateFilter } from "../github/store";
import type { ProjectService } from "../projects/project-service";
import type { RunnerDeps } from "../runner-port";
import type { SecretStore } from "../secrets";
import type { SessionRepo } from "../sessions/repo";
import { remoteWorkspaceFs } from "../workspace-fs/workspace-fs";
import { FORGEJO_TOKEN_KEY, type ForgejoConnection } from "./connection";
import { attachForgeEvidence } from "./evidence";
import { ForgejoClient } from "./forgejo/client";
import { ForgejoSync, type ForgeProject } from "./forgejo/sync";
import * as issues from "./issues";
import * as pulls from "./pulls";
import { isTrustedForgeReview } from "./review-trust";

export interface ForgeServiceDeps extends RunnerDeps {
  /** Domain events, for the sync's appends. */
  store: EventStore;
  /** The shared issue/PR projections (`github_issues`, `github_prs`, `github_sync_state`). */
  data: GithubStore;
  projects: ProjectService;
  /** Sessions, for the PR writes' branch push and link. */
  repo: SessionRepo;
  /** Evidence files: paths in a worktree, the temp folder, or the session's artifacts. */
  artifacts: ArtifactService;
  /** CodeDen's data directory: its credential files are never attached as evidence (§15). */
  home?: string;
  /** Current settings, read on every call so a saved connection applies at once. */
  settings: () => Pick<Settings, "forges">;
  secrets: SecretStore;
  connection: ForgejoConnection;
  /** Transport for the project clients (tests point it at a fake Forgejo). */
  fetch?: typeof fetch;
  /** Poll intervals (ms): idle (default 60 s), while a session PR is open (default 15 s). */
  idleIntervalMs?: number;
  activeIntervalMs?: number;
  /** How often the scheduler checks for due projects (default 5 s). */
  tickMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * A forge project's reads, sync and issue writes (`docs/forges.md` §4.3, §5.4, §8.1), the
 * counterpart of `GithubService` for Forgejo. Issue and PR lists come from the shared projection
 * tables; one issue, one PR and its diff are read fresh through the client. The sync polls each
 * configured forge project and writes the same `forge.synced`, `issue.*`, `pr.*` and
 * `review.submitted` events as GitHub, so the existing projections, session PR links and read
 * responses need no provider branch. Issue writes (create, comment, label, triage) go through the
 * client and are projected at once, as are pull request writes (phase B2: push a session's branch,
 * open or update its PR). Evidence is uploaded as issue/PR attachments, with a Contents-API branch
 * as the fallback (phase D), and the vision is shared through a normal pull request.
 */
export class ForgeService {
  readonly sync: ForgejoSync;
  /** The shared issue/PR projections (the same tables GitHub writes). */
  readonly data: GithubStore;
  private readonly clients = new Map<string, { key: string; client: ForgejoClient }>();
  private readonly deps: ForgeServiceDeps;

  constructor(deps: ForgeServiceDeps) {
    this.deps = deps;
    this.data = deps.data;
    this.sync = new ForgejoSync({
      clientFor: (project) => this.clientFor(project),
      store: deps.data,
      events: deps.store,
      projects: () => deps.projects.list(),
      idleIntervalMs: deps.idleIntervalMs,
      activeIntervalMs: deps.activeIntervalMs,
      tickMs: deps.tickMs,
      now: deps.now,
      log: deps.log,
    });
  }

  /** Start polling forge projects (`sync: false` keeps the connection reads only). */
  start(opts: { sync?: boolean } = {}): void {
    if (opts.sync !== false) this.sync.start();
  }

  stop(): void {
    this.sync.stop();
  }

  /** Sync a forge project now; errors surface (not connected, rate limited). */
  syncNow(projectId: string): Promise<void> {
    return this.sync.syncProject(projectId);
  }

  syncStatus(projectId: string): GithubSyncStatus {
    return this.sync.status(projectId);
  }

  /* ------------------------------------------------------------ connection */

  /** The connection as the `/github` routes report it, for a forge project. */
  async connection(_project: ForgeProject): Promise<GithubConnection> {
    const status = await this.deps.connection.status();
    return {
      connected: status.connected,
      source: "keychain",
      login: status.login,
      message: status.message,
      provider: status.provider,
      host: status.host,
    };
  }

  /**
   * The token account's login (`GET /user`), cached by the connection until its token or base
   * URL changes; null when the token cannot read an account or Forgejo is not connected.
   */
  async viewerLogin(): Promise<string | null> {
    try {
      const status = await this.deps.connection.status();
      return status.connected ? status.login : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether the factory can work on the project: a forge project whose Forgejo connection is
   * configured. A removed connection or token fails closed at the calls that need the forge.
   */
  connected(projectId: string): boolean {
    let project: Project;
    try {
      project = this.deps.projects.get(projectId);
    } catch {
      return false;
    }
    return (
      project.kind === "forge" &&
      project.forge.provider === "forgejo" &&
      this.deps.settings().forges.forgejo !== null
    );
  }

  /** The connected client for a project; throws `forge_not_connected` without a connection. */
  client(projectId: string): ForgejoClient {
    return this.clientForProject(projectId);
  }

  /* ------------------------------------------------------------ issues */

  /** Issues from the projection (synced in the background); `labels` must all match. */
  listIssues(
    projectId: string,
    opts: { state?: IssueStateFilter; labels?: string[]; limit?: number } = {},
  ): GithubIssue[] {
    this.forgeProject(projectId);
    const all = this.deps.data.issues(
      projectId,
      opts.state ?? "open",
      opts.labels?.length ? 500 : (opts.limit ?? 100),
    );
    const wanted = opts.labels ?? [];
    return all.filter((i) => wanted.every((l) => i.labels.includes(l))).slice(0, opts.limit ?? 100);
  }

  /** One issue, fresh from the forge, with its latest comments. */
  async getIssue(projectId: string, number: number): Promise<GithubIssueDetails> {
    const details = await this.clientForProject(projectId).issueDetails(number);
    return GithubIssueDetails.parse({
      ...details,
      sessionIds: this.deps.data.issue(projectId, number)?.sessionIds ?? [],
      recentComments: details.recentComments.map((comment) => ({
        ...comment,
        body: withoutMarker(comment.body),
      })),
    });
  }

  async issuesResponse(
    projectId: string,
    state: IssueStateFilter,
    limit: number,
  ): Promise<GithubIssuesResponse> {
    const project = this.forgeProject(projectId);
    return {
      connection: await this.connection(project),
      sync: this.sync.status(projectId),
      issues: this.deps.data.issues(projectId, state, limit),
    };
  }

  /** Create an issue; names resolve to the repository's label IDs, unknown ones are reported. */
  createIssue(projectId: string, req: CreateGithubIssueRequest): Promise<GithubIssue> {
    return issues.createIssue(this.issueDeps(), projectId, this.clientForProject(projectId), req);
  }

  /** Comment on an issue or a PR conversation, with CodeDen's hidden marker. */
  commentOnIssue(
    projectId: string,
    number: number,
    body: string,
  ): Promise<{ id: number; url: string }> {
    return issues.commentOnIssue(this.clientForProject(projectId), number, body);
  }

  /** Add and remove labels by name; the read-back says what actually applied. */
  labelIssue(projectId: string, number: number, req: GithubLabelRequest): Promise<GithubIssue> {
    return issues.labelIssue(
      this.issueDeps(),
      projectId,
      this.clientForProject(projectId),
      number,
      req,
    );
  }

  /** A triage decision: labels, comment and optionally a close (no close reason exists). */
  triageIssue(
    projectId: string,
    number: number,
    req: TriageIssueRequest,
  ): Promise<TriageIssueResult> {
    return issues.triageIssue(
      this.issueDeps(),
      projectId,
      this.clientForProject(projectId),
      number,
      req,
    );
  }

  /* ------------------------------------------------------------ pull requests */

  listPrs(projectId: string, state: IssueStateFilter = "open", limit = 100): ForgePr[] {
    this.forgeProject(projectId);
    return this.deps.data.prs(projectId, state, limit);
  }

  async prsResponse(
    projectId: string,
    state: IssueStateFilter,
    limit: number,
  ): Promise<GithubPrsResponse> {
    const project = this.forgeProject(projectId);
    return {
      connection: await this.connection(project),
      sync: this.sync.status(projectId),
      prs: this.deps.data.prs(projectId, state, limit),
    };
  }

  /** A PR's fresh projection row: checks, reviews, decision and commits, no files. */
  async getPr(projectId: string, number: number): Promise<ForgePr> {
    const pr = await this.clientForProject(projectId).prSnapshot(number);
    return GithubPr.parse({
      ...pr,
      sessionId: this.deps.data.pr(projectId, number)?.sessionId ?? null,
    });
  }

  /** A PR's live details, with the session link the projection has. */
  async getPrDetails(projectId: string, number: number): Promise<GithubPrDetails> {
    const details = await this.clientForProject(projectId).getPull(number);
    return GithubPrDetails.parse({
      ...details,
      sessionId: this.deps.data.pr(projectId, number)?.sessionId ?? null,
    });
  }

  /** A PR's diff at its current head, read from the forge (`GET /pulls/{index}.diff`). */
  getPrDiff(projectId: string, number: number): Promise<GithubPrDiff> {
    return this.clientForProject(projectId).pullDiff(number);
  }

  /**
   * `create_pull_request` on a forge project: push the session's branch and open or update its
   * PR. A draft request is refused before anything is pushed (`draft_unsupported`), and the PR
   * is projected and linked to the session at once.
   */
  async createPullRequest(
    sessionId: string,
    input: CreatePullRequestInput,
  ): Promise<CreatePullRequestResult> {
    const session: Session = this.deps.repo.get(sessionId);
    if (!session.projectId) throw conflict("This session has no project", "no_project");
    const project = this.forgeProject(session.projectId);
    const result = await pulls.createPullRequest(
      {
        client: this.clientForProject(project.id),
        data: this.deps.data,
        events: this.deps.store,
        repo: this.deps.repo,
        runner: this.deps.runner,
        runners: this.deps.runners,
      },
      session,
      project,
      input,
    );
    this.soon(project.id);
    return result;
  }

  /* ------------------------------------------------------------ evidence */

  /**
   * `attach_evidence` on a forge project (`docs/forges.md` §5.8, phase D): upload each file as an
   * issue/PR attachment and post the evidence comment, or commit a file the attachment API
   * refuses to the normal `codeden/evidence` branch. The file and secret rules are the GitHub
   * path's, applied before any upload.
   */
  attachEvidence(sessionId: string, input: AttachEvidenceInput): Promise<AttachEvidenceResult> {
    const session = this.deps.repo.get(sessionId);
    if (!session.projectId) throw conflict("This session has no project", "no_project");
    const project = this.forgeProject(session.projectId);
    return attachForgeEvidence({
      client: this.clientForProject(project.id),
      session,
      artifacts: this.deps.artifacts,
      input,
      defaultBranch: project.forge.defaultBranch,
      home: this.deps.home,
      remote: remoteWorkspaceFs(this.deps, session),
    });
  }

  /**
   * Whether a review may steer the PR's session (`docs/forges.md` §6.2): live write permission,
   * then the review's `official` flag, then the viewer or a trusted author. A permission lookup
   * that cannot answer trusts nobody by itself.
   */
  async reviewIsTrusted(
    projectId: string,
    review: Pick<GithubReview, "author" | "official">,
    viewer: string | null,
  ): Promise<boolean> {
    const project = this.forgeProject(projectId);
    const login = review.author;
    const permission = login
      ? await this.clientForProject(projectId)
          .permission(login)
          .catch((error: unknown) => {
            this.deps.log?.(`forge: permission lookup for ${login}: ${String(error)}`);
            return "unknown" as const;
          })
      : "unknown";
    return isTrustedForgeReview({
      review,
      permission,
      viewer,
      trustedAuthors: project.factoryLimits.trustedAuthors,
    });
  }

  /** True when an open, unlinked PR's head branch is `branch` (a session just started on it). */
  hasUnlinkedPr(projectId: string, branch: string): boolean {
    return this.sync.hasUnlinkedPr(projectId, branch);
  }

  /** Poll a project at the next scheduler tick. */
  soon(projectId: string): void {
    this.sync.soon(projectId);
  }

  /* ------------------------------------------------------------ helpers */

  private issueDeps(): issues.ForgeIssueDeps {
    return { data: this.deps.data, events: this.deps.store, log: this.deps.log };
  }

  /** The client for a project, or null when no forge connection is configured. */
  private clientFor(project: ForgeProject): ForgejoClient | null {
    const config = this.deps.settings().forges.forgejo;
    if (!config) return null;
    const repo: ForgeRepo = project.forge;
    if (repo.provider !== "forgejo") return null;
    const key = `${config.baseUrl}|${repo.owner}/${repo.repo}`;
    const cached = this.clients.get(project.id);
    if (cached?.key === key) return cached.client;
    const client = new ForgejoClient({
      baseUrl: config.baseUrl,
      token: () => this.deps.secrets.get(FORGEJO_TOKEN_KEY),
      owner: repo.owner,
      repo: repo.repo,
      projectId: project.id,
      allowInsecureHttp: config.allowInsecureHttp,
      fetch: this.deps.fetch,
      log: this.deps.log,
    });
    this.clients.set(project.id, { key, client });
    return client;
  }

  private clientForProject(projectId: string): ForgejoClient {
    const project = this.forgeProject(projectId);
    const client = this.clientFor(project);
    if (!client) {
      throw new ForgeError(
        "forge_not_connected",
        "Forgejo is not connected. Add its URL and an access token in Settings.",
      );
    }
    return client;
  }

  private forgeProject(projectId: string): ForgeProject {
    const project: Project = this.deps.projects.get(projectId);
    if (project.kind !== "forge") {
      throw conflict(`${project.name} is not a forge project`, "not_a_forge_project");
    }
    return project;
  }
}
