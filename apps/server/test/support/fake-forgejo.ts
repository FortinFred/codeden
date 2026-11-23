import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake forge received. */
export interface FakeForgeRequest {
  method: string;
  /** Path and query, e.g. `/api/v1/repos/acme/widgets/issues?page=1`. */
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
  /** The status the fake answered with. */
  status?: number;
}

export type FakeForgeHandler = (
  request: FakeForgeRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface FakeForge {
  baseUrl: string;
  requests: FakeForgeRequest[];
  close: () => Promise<void>;
}

/** A local HTTP server standing in for Forgejo; no network, no Forgejo process. */
export async function startFakeForge(handler: FakeForgeHandler): Promise<FakeForge> {
  const requests: FakeForgeRequest[] = [];
  const server = createServer(async (incoming, response) => {
    const body = await readBody(incoming);
    const request: FakeForgeRequest = {
      method: incoming.method ?? "GET",
      url: incoming.url ?? "/",
      headers: incoming.headers,
      body,
    };
    requests.push(request);
    try {
      await handler(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => close(server),
  };
}

/** Answer with JSON. */
export function json(
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

/** Answer with plain text (a `.diff`). */
export function text(
  response: ServerResponse,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "text/plain", ...headers });
  response.end(body);
}

// ---------------------------------------------------------------- stateful fake

/** One comment on an issue or PR conversation. */
export interface FakeForgejoComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

/** One review, with Forgejo's trust flags. */
export interface FakeForgejoReview {
  id: number;
  author: string;
  state: "APPROVED" | "COMMENT" | "REQUEST_CHANGES" | "PENDING";
  body?: string;
  submittedAt?: string;
  official?: boolean;
  stale?: boolean;
  dismissed?: boolean;
}

/** One commit status a CI tool posted. */
export interface FakeForgejoStatus {
  context: string;
  status: "pending" | "success" | "error" | "failure" | "warning" | "skipped";
  targetUrl?: string;
  description?: string;
  createdAt?: string;
}

/** One issue or pull request the fake holds (a PR carries `pullRequest: true` and its fields). */
export interface FakeForgejoIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author: string;
  comments: FakeForgejoComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  pullRequest?: boolean;
  headBranch?: string;
  baseBranch?: string;
  headSha?: string;
  draft?: boolean;
  merged?: boolean;
  mergedAt?: string | null;
  mergeable?: boolean;
  requestedReviewers?: string[];
  statuses?: FakeForgejoStatus[];
  reviews?: FakeForgejoReview[];
  files?: Array<{
    filename: string;
    status: string;
    additions?: number;
    deletions?: number;
  }>;
  commits?: Array<{ sha: string; message: string }>;
  diff?: string;
}

/**
 * An in-memory Forgejo behind `fetch`: the issues listing with its `state`/`since` filters,
 * pull requests, comments, reviews, commit statuses and branch protection. Every request is
 * recorded, and every write is refused with 405, so a test can assert the sync is read-only.
 */
export class FakeForgejo {
  readonly owner = "acme";
  readonly repo = "widgets";
  /** A loopback base URL, accepted by the client's validation; no server listens on it. */
  readonly baseUrl = "http://127.0.0.1:3000";
  readonly issues = new Map<number, FakeForgejoIssue>();
  readonly requests: FakeForgeRequest[] = [];
  readonly token = "forge-token";
  /** The `/user` login; `null` makes `/user` answer 403 (a repository-only token). */
  viewer: string | null = "codeden-bot";
  /** Approvals branch protection requires per branch; a `null` value answers 403. */
  readonly requiredApprovals = new Map<string, number | null>();
  rateLimited = false;
  private clock = Date.parse("2026-11-01T00:00:00Z");
  private nextNumber = 1;
  private nextId = 5000;

  /** A monotonically increasing timestamp (seconds apart). */
  tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  addIssue(partial: Partial<FakeForgejoIssue> = {}): FakeForgejoIssue {
    const now = this.tick();
    const issue: FakeForgejoIssue = {
      number: this.nextNumber++,
      title: "An issue",
      body: "",
      state: "open",
      labels: [],
      author: "lee",
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      ...partial,
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  addPr(
    head: string,
    partial: Partial<FakeForgejoIssue> = {},
    pr: Partial<FakeForgejoIssue> = {},
  ): FakeForgejoIssue {
    return this.addIssue({
      title: "A change",
      author: "codeden-bot",
      ...partial,
      pullRequest: true,
      headBranch: head,
      baseBranch: "main",
      headSha: `sha-${head}-1`,
      draft: false,
      merged: false,
      mergedAt: null,
      mergeable: true,
      requestedReviewers: [],
      statuses: [],
      reviews: [],
      files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
      commits: [{ sha: `sha-${head}-1`, message: "A change" }],
      ...pr,
    });
  }

  /** Change an issue the way Forgejo would (bumping `updated_at`). */
  touch(number: number, change: (issue: FakeForgejoIssue) => void): void {
    const issue = this.issue(number);
    change(issue);
    issue.updatedAt = this.tick();
  }

  addComment(number: number, body: string, author = "lee"): FakeForgejoComment {
    const issue = this.issue(number);
    const comment: FakeForgejoComment = {
      id: this.nextId++,
      body,
      author,
      createdAt: this.tick(),
    };
    issue.comments.push(comment);
    // Forgejo bumps the conversation's `updated_at` when a comment arrives.
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  addReview(number: number, review: Partial<FakeForgejoReview> = {}): FakeForgejoReview {
    const issue = this.issue(number);
    const next: FakeForgejoReview = {
      id: this.nextId++,
      author: "maintainer",
      state: "APPROVED",
      body: "",
      submittedAt: this.tick(),
      official: true,
      stale: false,
      dismissed: false,
      ...review,
    };
    issue.reviews = [...(issue.reviews ?? []), next];
    return next;
  }

  setStatuses(number: number, statuses: FakeForgejoStatus[]): void {
    this.issue(number).statuses = statuses;
  }

  setRequiredApprovals(branch: string, required: number | null): void {
    this.requiredApprovals.set(branch, required);
  }

  private issue(number: number): FakeForgejoIssue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`no fake issue ${number}`);
    return issue;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "";
    const record: FakeForgeRequest = {
      method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(headers.entries()) as FakeForgeRequest["headers"],
      body,
    };
    this.requests.push(record);
    const answer = (status: number, data: unknown, extra: Record<string, string> = {}) => {
      record.status = status;
      return new Response(data === null ? null : JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...extra },
      });
    };
    const token = (headers.get("authorization") ?? "").replace(/^(token|bearer)\s+/i, "");
    if (token !== this.token) return answer(401, { message: "invalid token" });
    if (this.rateLimited) {
      return answer(429, { message: "too many requests" }, { "retry-after": "30" });
    }
    if (method !== "GET") return answer(405, { message: "the fake forge is read-only" });
    return this.route(url.pathname, url.searchParams, answer);
  };

  private route(
    path: string,
    query: URLSearchParams,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    if (path === "/api/v1/version") return answer(200, { version: "17.0.2" });
    if (path === "/api/v1/user") {
      return this.viewer === null
        ? answer(403, { message: "token has no user scope" })
        : answer(200, { login: this.viewer });
    }
    const prefix = `/api/v1/repos/${this.owner}/${this.repo}`;
    if (!path.startsWith(prefix)) return answer(404, { message: "not found" });
    const rest = path.slice(prefix.length);

    if (rest === "") return answer(200, this.repository());
    if (rest === "/issues") return this.listIssues(query, answer);
    let match = rest.match(/^\/issues\/(\d+)$/);
    if (match) {
      const issue = this.issues.get(Number(match[1]));
      return issue ? answer(200, this.issueRow(issue)) : answer(404, notFound());
    }
    match = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (match) return this.listComments(Number(match[1]), query, answer);
    match = rest.match(/^\/pulls\/(\d+)$/);
    if (match) {
      const issue = this.issues.get(Number(match[1]));
      return issue?.pullRequest ? answer(200, this.pull(issue)) : answer(404, notFound());
    }
    match = rest.match(/^\/pulls\/(\d+)\/files$/);
    if (match) {
      const issue = this.issues.get(Number(match[1]));
      return issue?.pullRequest
        ? answer(200, issue.files ?? [], { "x-total-count": String((issue.files ?? []).length) })
        : answer(404, notFound());
    }
    match = rest.match(/^\/pulls\/(\d+)\/reviews$/);
    if (match) {
      const issue = this.issues.get(Number(match[1]));
      if (!issue?.pullRequest) return answer(404, notFound());
      return answer(200, this.reviews(issue), {
        "x-total-count": String((issue.reviews ?? []).length),
      });
    }
    match = rest.match(/^\/pulls\/(\d+)\/commits$/);
    if (match) {
      const issue = this.issues.get(Number(match[1]));
      return issue?.pullRequest ? answer(200, this.commits(issue)) : answer(404, notFound());
    }
    match = rest.match(/^\/pulls\/(\d+)\.diff$/);
    if (match) {
      const issue = this.issues.get(Number(match[1]));
      return issue?.pullRequest
        ? new Response(issue.diff ?? "", {
            status: 200,
            headers: { "content-type": "text/plain" },
          })
        : answer(404, notFound());
    }
    match = rest.match(/^\/commits\/([^/]+)\/status$/);
    if (match) return answer(200, this.combinedStatus(decodeURIComponent(match[1] ?? "")));
    match = rest.match(/^\/branches\/(.+)$/);
    if (match) return this.branch(decodeURIComponent(match[1] ?? ""), answer);
    return answer(404, notFound());
  }

  private listIssues(
    query: URLSearchParams,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const state = query.get("state") ?? "open";
    const since = query.get("since");
    let rows = [...this.issues.values()].filter((i) => state === "all" || i.state === state);
    if (since) rows = rows.filter((i) => i.updatedAt >= since);
    rows.sort((a, b) =>
      query.get("sort") === "recentupdate"
        ? b.updatedAt.localeCompare(a.updatedAt)
        : a.number - b.number,
    );
    const page = Number(query.get("page") ?? "1");
    const limit = Number(query.get("limit") ?? "50");
    const slice = rows.slice((page - 1) * limit, page * limit);
    return answer(
      200,
      slice.map((issue) => this.issueRow(issue)),
      { "x-total-count": String(rows.length) },
    );
  }

  private listComments(
    number: number,
    query: URLSearchParams,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const issue = this.issues.get(number);
    if (!issue) return answer(404, notFound());
    const since = query.get("since");
    const rows = issue.comments
      .filter((comment) => !since || comment.createdAt >= since)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return answer(
      200,
      rows.map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: comment.author },
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        html_url: `${this.baseUrl}/${this.owner}/${this.repo}/issues/${number}#issuecomment-${comment.id}`,
      })),
      { "x-total-count": String(rows.length) },
    );
  }

  private branch(
    name: string,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    if (this.requiredApprovals.get(name) === null) {
      return answer(403, { message: "branch protection is not readable" });
    }
    const required = this.requiredApprovals.get(name) ?? 0;
    return answer(200, {
      name,
      commit: { id: "base-sha" },
      protected: required > 0,
      required_approvals: required,
    });
  }

  private repository() {
    return {
      name: this.repo,
      full_name: `${this.owner}/${this.repo}`,
      default_branch: "main",
      has_issues: true,
      has_pull_requests: true,
      has_actions: true,
      allow_squash_merge: true,
      permissions: { admin: false, push: true, pull: true },
      owner: { login: this.owner },
    };
  }

  private issueRow(issue: FakeForgejoIssue) {
    return {
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      html_url: `${this.baseUrl}/${this.owner}/${this.repo}/issues/${issue.number}`,
      labels: issue.labels.map((name, index) => ({ id: index + 1, name })),
      user: { login: issue.author },
      comments: issue.comments.length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      ...(issue.pullRequest ? { pull_request: { merged: issue.merged } } : {}),
    };
  }

  private pull(issue: FakeForgejoIssue) {
    return {
      id: issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      draft: issue.draft ?? false,
      html_url: `${this.baseUrl}/${this.owner}/${this.repo}/pulls/${issue.number}`,
      user: { login: issue.author },
      head: {
        label: `${this.owner}:${issue.headBranch}`,
        ref: issue.headBranch,
        sha: issue.headSha,
      },
      base: { label: `${this.owner}:${issue.baseBranch}`, ref: issue.baseBranch, sha: "base-sha" },
      merged: issue.merged ?? false,
      merged_at: issue.mergedAt ?? null,
      merge_commit_sha: issue.merged ? `merge-${issue.number}` : null,
      mergeable: issue.mergeable ?? true,
      additions: 1,
      deletions: 1,
      changed_files: (issue.files ?? []).length,
      requested_reviewers: (issue.requestedReviewers ?? []).map((login) => ({ login })),
      requested_reviewers_teams: [],
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
    };
  }

  private reviews(issue: FakeForgejoIssue) {
    return (issue.reviews ?? []).map((review) => ({
      id: review.id,
      user: { login: review.author },
      state: review.state,
      body: review.body ?? "",
      commit_id: issue.headSha,
      submitted_at: review.submittedAt ?? null,
      html_url: null,
      official: review.official ?? false,
      stale: review.stale ?? false,
      dismissed: review.dismissed ?? false,
      comments_count: 0,
    }));
  }

  private commits(issue: FakeForgejoIssue) {
    return (issue.commits ?? []).map((commit) => ({
      sha: commit.sha,
      commit: { message: commit.message },
    }));
  }

  private combinedStatus(sha: string) {
    const pr = [...this.issues.values()].find((issue) => issue.headSha === sha);
    const statuses = pr?.statuses ?? [];
    return {
      state: combinedState(statuses),
      sha,
      total_count: statuses.length,
      statuses: statuses.map((status, index) => ({
        id: index + 1,
        status: status.status,
        context: status.context,
        target_url: status.targetUrl ?? null,
        description: status.description ?? null,
        created_at: status.createdAt ?? "2026-11-01T00:00:00Z",
        updated_at: status.createdAt ?? "2026-11-01T00:00:00Z",
      })),
    };
  }
}

function combinedState(statuses: FakeForgejoStatus[]) {
  if (statuses.some((status) => ["error", "failure"].includes(status.status))) return "failure";
  if (statuses.some((status) => status.status === "warning")) return "warning";
  if (statuses.some((status) => status.status === "pending")) return "pending";
  if (statuses.length > 0) return "success";
  return "";
}

function notFound() {
  return { message: "not found" };
}

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    incoming.on("error", reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
