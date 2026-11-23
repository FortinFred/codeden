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
  type GithubSyncStatus,
  type Project,
  type Settings,
  type TriageIssueRequest,
  type TriageIssueResult,
} from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { conflict, ForgeError } from "../errors";
import { withoutMarker } from "../github/issues";
import type { GithubStore, IssueStateFilter } from "../github/store";
import type { ProjectService } from "../projects/project-service";
import type { SecretStore } from "../secrets";
import { FORGEJO_TOKEN_KEY, type ForgejoConnection } from "./connection";
import { ForgejoClient } from "./forgejo/client";
import { ForgejoSync, type ForgeProject } from "./forgejo/sync";
import * as issues from "./issues";

export interface ForgeServiceDeps {
  /** Domain events, for the sync's appends. */
  store: EventStore;
  /** The shared issue/PR projections (`github_issues`, `github_prs`, `github_sync_state`). */
  data: GithubStore;
  projects: ProjectService;
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
 * client and are projected at once; PR and evidence writes stay GitHub-only until phase B2.
 */
export class ForgeService {
  readonly sync: ForgejoSync;
  private readonly clients = new Map<string, { key: string; client: ForgejoClient }>();

  constructor(private readonly deps: ForgeServiceDeps) {
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
