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

/** A repository label; create-issue takes IDs, add/remove take names (§5.4). */
export interface FakeForgejoLabel {
  id: number;
  name: string;
  color: string;
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
 * pull requests, comments, reviews, commit statuses, branch protection and the issue writes of
 * phase B1 (create, comment, label add/remove, close). Every request is recorded; the sync's own
 * suite asserts that no sync or read path ever sends a write.
 */
export class FakeForgejo {
  readonly owner = "acme";
  readonly repo = "widgets";
  /** A loopback base URL, accepted by the client's validation; no server listens on it. */
  readonly baseUrl = "http://127.0.0.1:3000";
  readonly issues = new Map<number, FakeForgejoIssue>();
  /**
   * The repository's labels (`GET /labels`). Create-issue labels are IDs, resolved from these;
   * add/remove use names, and a name that is not here is silently ignored, as Forgejo does.
   */
  readonly labels = new Map<string, FakeForgejoLabel>(
    (
      [
        { id: 1, name: "bug", color: "d73a4a" },
        { id: 2, name: "enhancement", color: "a2eeef" },
        { id: 3, name: "needs info", color: "d4c5f9" },
      ] satisfies FakeForgejoLabel[]
    ).map((label) => [label.name, label]),
  );
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
  private nextLabelId = 100;

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
    return this.route(url.pathname, url.searchParams, method, body, answer);
  };

  private route(
    path: string,
    query: URLSearchParams,
    method: string,
    body: string,
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
    if (rest === "/labels") return this.listLabels(query, answer);
    if (rest === "/issues") {
      if (method === "POST") return this.createIssue(bodyOf(body), answer);
      return this.listIssues(query, answer);
    }
    let match = rest.match(/^\/issues\/(\d+)$/);
    if (match) {
      const number = Number(match[1]);
      if (method === "PATCH") return this.editIssue(number, bodyOf(body), answer);
      const issue = this.issues.get(number);
      return issue ? answer(200, this.issueRow(issue)) : answer(404, notFound());
    }
    match = rest.match(/^\/issues\/(\d+)\/comments$/);
    if (match) {
      return method === "POST"
        ? this.createComment(Number(match[1]), bodyOf(body), answer)
        : this.listComments(Number(match[1]), query, answer);
    }
    match = rest.match(/^\/issues\/(\d+)\/labels$/);
    if (match) {
      return method === "POST"
        ? this.addLabels(Number(match[1]), bodyOf(body), answer)
        : answer(405, { message: "method not allowed" });
    }
    match = rest.match(/^\/issues\/(\d+)\/labels\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[2] ?? "");
      return method === "DELETE"
        ? this.removeLabel(Number(match[1]), name, answer)
        : answer(405, { message: "method not allowed" });
    }
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

  /** `POST /issues`: labels are IDs here, so unknown IDs are dropped (Forgejo's own rule). */
  private createIssue(
    body: Record<string, unknown>,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const ids = Array.isArray(body.labels) ? (body.labels as number[]) : [];
    const issue = this.addIssue({
      title: String(body.title ?? ""),
      body: String(body.body ?? ""),
      labels: ids
        .map((id) => [...this.labels.values()].find((label) => label.id === id)?.name)
        .filter((name): name is string => name !== undefined),
      author: this.viewer ?? "codeden-bot",
    });
    return answer(201, this.issueRow(issue));
  }

  /** `PATCH /issues/{n}`: a close or reopen; Forgejo has no `state_reason` to record. */
  private editIssue(
    number: number,
    body: Record<string, unknown>,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const issue = this.issues.get(number);
    if (!issue) return answer(404, notFound());
    const closing = body.state === "closed" && issue.state !== "closed";
    this.touch(number, (row) => {
      if (body.state === "closed" || body.state === "open") row.state = body.state;
      if (typeof body.title === "string") row.title = body.title;
      if (typeof body.body === "string") row.body = body.body;
      if (closing) row.closedAt = this.tick();
      if (body.state === "open") row.closedAt = null;
    });
    return answer(200, this.issueRow(issue));
  }

  /** `POST /issues/{n}/comments`: the body is stored as sent, marker included. */
  private createComment(
    number: number,
    body: Record<string, unknown>,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const issue = this.issues.get(number);
    if (!issue) return answer(404, notFound());
    const comment = this.addComment(number, String(body.body ?? ""), this.viewer ?? "codeden-bot");
    return answer(201, this.commentRow(number, comment));
  }

  /** `POST /issues/{n}/labels`: names, of which Forgejo silently ignores the unknown ones. */
  private addLabels(
    number: number,
    body: Record<string, unknown>,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const issue = this.issues.get(number);
    if (!issue) return answer(404, notFound());
    const names = Array.isArray(body.labels) ? (body.labels as string[]) : [];
    this.touch(number, (row) => {
      for (const name of names) {
        if (this.labels.has(name) && !row.labels.includes(name)) row.labels.push(name);
      }
    });
    return answer(200, this.issueRow(issue).labels);
  }

  /** `DELETE /issues/{n}/labels/{name}`: 404 when the issue doesn't carry it, as Forgejo does. */
  private removeLabel(
    number: number,
    name: string,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const issue = this.issues.get(number);
    if (!issue) return answer(404, notFound());
    if (!issue.labels.includes(name)) return answer(404, notFound());
    this.touch(number, (row) => {
      row.labels = row.labels.filter((label) => label !== name);
    });
    return answer(200, this.issueRow(issue).labels);
  }

  /** `GET /labels`, paginated like every listing. */
  private listLabels(
    query: URLSearchParams,
    answer: (status: number, data: unknown, extra?: Record<string, string>) => Response,
  ): Response {
    const rows = [...this.labels.values()];
    const page = Number(query.get("page") ?? "1");
    const limit = Number(query.get("limit") ?? "50");
    return answer(200, rows.slice((page - 1) * limit, page * limit), {
      "x-total-count": String(rows.length),
    });
  }

  /** A label by name, registering one a test put on an issue without adding it to the repo. */
  private labelOf(name: string): FakeForgejoLabel {
    const found = this.labels.get(name);
    if (found) return found;
    const label = { id: this.nextLabelId++, name, color: "ededed" };
    this.labels.set(name, label);
    return label;
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
      rows.map((comment) => this.commentRow(number, comment)),
      { "x-total-count": String(rows.length) },
    );
  }

  private commentRow(number: number, comment: FakeForgejoComment) {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: comment.author },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      html_url: `${this.baseUrl}/${this.owner}/${this.repo}/issues/${number}#issuecomment-${comment.id}`,
    };
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
      labels: issue.labels.map((name) => this.labelOf(name)),
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

/** A write's request body as an object (an empty or unparsable body is `{}`). */
function bodyOf(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
