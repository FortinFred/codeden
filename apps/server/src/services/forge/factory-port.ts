import type {
  ForgePermission,
  GitHubIssueRef,
  GitHubPrRef,
  GithubAuthorAssociation,
  GithubIssue,
  Project,
} from "@codeden/contracts";
import { conflict, errorMessage, ForgeError } from "../errors";
import { prDiffKey } from "../factory/diff-key";
import {
  type Commenter,
  type CommitChecks,
  type FactoryGithub,
  type FactoryPr,
  type IssueAuthor,
  type MainHead,
  type MainSince,
  type PrEvidence,
  VISION_BRANCH,
} from "../factory/github-port";
import { EVIDENCE_HEADING } from "../github/evidence";
import type { ProjectService } from "../projects/project-service";
import { forgeEvidenceComment } from "./evidence";
import type { ForgeService } from "./service";

/**
 * The factory's forge port (`docs/forges.md` §5.5–5.9, §6.2, phase C1): `FactoryGithub` over a
 * Forgejo project, so the same software factory loop, merge checks and merge queue run on it.
 *
 * Everything here reads commit statuses, never check runs: `warning` and `error` are failures, a
 * PR with no statuses is `none` and never green. A merge is pinned to the reviewed head with
 * `head_commit_id`; a moved head or a refused style is the forge's refusal, which the queue
 * counts. `mergeable` is Forgejo's boolean, settled over two reads of the same head. Forgejo has
 * no `mergeable_state`, no `until` on commits and no revert API: `mergeState` stays `unknown`,
 * `mainHeadAt` is null and `revertMerge` is null (an agent writes the revert). Evidence is read
 * from CodeDen's own evidence comment (attachments or the contents fallback, phase D), so the
 * merge checks require screenshots again; the vision is shared through the Contents API.
 *
 * Trust follows §6.2: a login's live collaborator permission (`owner`, `write`) is write access;
 * a review's `official` flag stands in when permissions cannot be read; anything unknown is
 * untrusted. The viewer (`GET /user`, cached by the connection) and `trustedAuthors` are applied
 * by the factory around this port, as they are for GitHub.
 */
export interface ForgeFactoryPortDeps {
  projects: ProjectService;
  forge: ForgeService;
  /** Diagnostics only; tokens never reach it. */
  log?: (message: string) => void;
}

/** How a forge permission reads as GitHub's `authorAssociation` (write access, or none). */
export function associationFor(permission: ForgePermission): GithubAuthorAssociation {
  switch (permission) {
    case "owner":
      return "owner";
    case "write":
      return "collaborator";
    default:
      // `read`, `none` and `unknown` are not write access: unknown must never gate a merge.
      return "none";
  }
}

/** A status conclusion that isn't a pass; Forgejo's `warning` is a failure, like `error`. */
const PASSING = new Set(["success", "neutral", "skipped"]);

export class ForgeFactoryPort implements FactoryGithub {
  /** `prDiffKey` fingerprints per project and head commit (a commit's own change never changes). */
  private readonly diffKeys = new Map<string, string | null>();

  constructor(private readonly deps: ForgeFactoryPortDeps) {}

  isForgeProject(projectId: string): boolean {
    return this.deps.forge.connected(projectId);
  }

  viewerLogin(_projectId: string): Promise<string | null> {
    return this.deps.forge.viewerLogin();
  }

  async issueAuthor(projectId: string, number: number): Promise<IssueAuthor> {
    const issue = await this.client(projectId).getIssue(number);
    return {
      login: issue.author,
      association: await this.associationOf(projectId, issue.author),
    };
  }

  /**
   * Everyone who commented on the issue or PR, one entry per comment, plus with `pr` the PR's
   * reviews. Forgejo has no `author_association`: each login's live permission decides (a
   * review's `official` flag when it cannot be read). Review line comments are not read yet;
   * the conversation and the review verdicts are what the factory trusts.
   */
  async commenters(projectId: string, number: number, opts: { pr: boolean }): Promise<Commenter[]> {
    const client = this.client(projectId);
    const found: Commenter[] = [];
    const associations = new Map<string, GithubAuthorAssociation>();
    const associationOf = async (login: string | null): Promise<GithubAuthorAssociation> => {
      if (!login) return "none";
      const key = login.toLowerCase();
      const known = associations.get(key);
      if (known) return known;
      const value = await this.associationOf(projectId, login);
      associations.set(key, value);
      return value;
    };
    for (const comment of await client.comments(number, { limit: 200 })) {
      found.push({ login: comment.author, association: await associationOf(comment.author) });
    }
    if (opts.pr) {
      for (const review of await client.listReviews(number)) {
        const live = await associationOf(review.author);
        found.push({
          login: review.author,
          // Precedence (§6.2): live write access, then `official`, then nothing.
          association: live === "none" && review.official === true ? "collaborator" : live,
        });
      }
    }
    return found;
  }

  async createIssue(
    projectId: string,
    req: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssueRef> {
    const issue = await this.deps.forge.createIssue(projectId, req);
    return { number: issue.number, url: issue.url, title: issue.title };
  }

  async labelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    await this.deps.forge.labelIssue(projectId, number, { add: labels, remove: [] });
  }

  async unlabelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    await this.deps.forge.labelIssue(projectId, number, { add: [], remove: labels });
  }

  async comment(projectId: string, number: number, body: string): Promise<void> {
    await this.deps.forge.commentOnIssue(projectId, number, body);
  }

  openIssues(projectId: string): GithubIssue[] {
    return this.deps.forge.data.issues(projectId, "open", 200);
  }

  issue(projectId: string, number: number): GithubIssue | null {
    return this.deps.forge.data.issue(projectId, number) ?? null;
  }

  prRef(projectId: string, number: number): GitHubPrRef | null {
    const pr = this.deps.forge.data.pr(projectId, number);
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  mergedPrClosing(projectId: string, issueNumber: number): GitHubPrRef | null {
    const pr = this.deps.forge.data
      .prs(projectId, "closed", 200)
      .find((p) => p.state === "merged" && p.linkedIssues.includes(issueNumber));
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  prForSession(projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null {
    const pr = this.deps.forge.data
      .prs(projectId, "all", 200)
      .find((p) => p.sessionId === sessionId || (branch !== null && p.headBranch === branch));
    return pr ? { number: pr.number, url: pr.url, state: pr.state, title: pr.title } : null;
  }

  async prDetails(projectId: string, number: number): Promise<FactoryPr> {
    const pr = await this.deps.forge.getPrDetails(projectId, number);
    // Read pinned to this read's head commit, so the fingerprint is that head's (`diffKeyAt`).
    const diffKey = pr.headSha ? await this.diffKeyAt(projectId, number, pr.headSha) : null;
    return {
      diffKey,
      ref: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
      title: pr.title,
      body: pr.body,
      headSha: pr.headSha,
      headBranch: pr.headBranch,
      checks: pr.checks.state,
      failedChecks: pr.checks.checks
        .filter((c) => c.conclusion !== null && !PASSING.has(c.conclusion))
        .map((c) => c.name),
      // Forgejo's boolean mergeable is settled by the client over two reads of the same head.
      mergeable: pr.mergeable,
      // There is no `mergeable_state`: the merge call is the final authority (§5.9).
      mergeState: "unknown",
      additions: pr.additions,
      deletions: pr.deletions,
      files: pr.files.map((f) => f.path),
      changedFiles: pr.changedFiles,
      renamedFrom: pr.files.flatMap((f) => (f.previousPath ? [f.previousPath] : [])),
      fileLines: pr.files.map((f) => ({
        path: f.path,
        ...(f.previousPath ? { previousPath: f.previousPath } : {}),
        lines: f.additions + f.deletions,
      })),
    };
  }

  /**
   * CodeDen's own evidence comment on the PR or its issue (`docs/forges.md` §5.8, §8.2): only a
   * comment by the viewer counts, because anyone can comment on a public repository. An image
   * link to the configured host (an attachment or the `codeden/evidence` branch) is a screenshot;
   * the test-output block is test output.
   */
  async evidence(
    projectId: string,
    prNumber: number,
    issueNumber: number | null,
  ): Promise<PrEvidence> {
    const baseUrl = this.forgeRepo(projectId).baseUrl;
    const viewer = (await this.viewerLogin(projectId))?.toLowerCase() ?? null;
    const found: PrEvidence = { screenshots: false, testOutput: false };
    if (!viewer) return found;
    for (const number of [prNumber, ...(issueNumber ? [issueNumber] : [])]) {
      const comments = await this.client(projectId).comments(number, { limit: 200 });
      for (const comment of comments) {
        const body = comment.body ?? "";
        if (!body.startsWith(EVIDENCE_HEADING)) continue;
        if (comment.author?.toLowerCase() !== viewer) continue;
        const evidence = forgeEvidenceComment(body, baseUrl);
        if (evidence.screenshots) found.screenshots = true;
        if (evidence.testOutput) found.testOutput = true;
      }
      if (found.screenshots && found.testOutput) break;
    }
    return found;
  }

  /** `attach_evidence` works on a forge PR: the merge checks require screenshots for UI work. */
  evidenceSupported(_projectId: string): boolean {
    return true;
  }

  /**
   * Squash-merge pinned to the reviewed head. Forgejo answers a moved head with 409 and a
   * refused style or unmergeable PR with 405; both surface as a `ForgeError` the queue counts.
   * The merge response is empty, so the client reads the PR back for its merge commit.
   */
  async merge(
    projectId: string,
    number: number,
    opts: { sha: string | null; title: string },
  ): Promise<{ merged: boolean; sha: string | null }> {
    const merged = await this.client(projectId).mergePull(number, {
      method: "squash",
      ...(opts.sha ? { headSha: opts.sha } : {}),
      title: opts.title,
    });
    this.deps.forge.soon(projectId);
    return merged;
  }

  async commitChecks(projectId: string, sha: string): Promise<CommitChecks> {
    return (await this.checksFor(projectId, sha)).state;
  }

  async failedChecks(projectId: string, sha: string): Promise<string[]> {
    return (await this.checksFor(projectId, sha)).failed;
  }

  async mainHead(projectId: string): Promise<MainHead> {
    const client = this.client(projectId);
    const sha = await client.branchHead(this.defaultBranch(projectId));
    const { state, failed } = await this.checksFor(projectId, sha);
    return { sha, checks: state, failed };
  }

  /** Forgejo has no `until` on its commit list: the head at a past time is unknown (§5.9). */
  async mainHeadAt(_projectId: string, _at: string): Promise<MainHead | null> {
    return null;
  }

  /** Commits the default branch has that the PR's head doesn't (0: up to date). */
  async behindBy(projectId: string, _number: number, headSha: string): Promise<number> {
    const compared = await this.compare(projectId, headSha);
    return compared.behind;
  }

  /**
   * The commits the default branch has that the PR's head doesn't, and the files they changed
   * (one compare from the head to the default branch). Forgejo lists at most 300 files, and a
   * list that hits the cap is `complete: false`, never "the whole change".
   */
  async mainSince(projectId: string, _number: number, headSha: string): Promise<MainSince> {
    return this.compare(projectId, headSha);
  }

  /**
   * Bring the PR up to date with the default branch. Forgejo has no `expected_head_sha`: the
   * client pre-reads the head and refuses when it moved, calls `update` with `style=merge`, and
   * reports the new head. The loop's next read decides the approval and `diffKey` on that head.
   */
  async updateBranch(projectId: string, number: number, expectedHeadSha: string): Promise<void> {
    const head = await this.client(projectId).updateBranch(number, { expectedHeadSha });
    this.deps.log?.(
      head === expectedHeadSha
        ? `forge: #${number} was already up to date at ${head.slice(0, 7)}`
        : `forge: #${number} is now at ${head.slice(0, 7)} after updating its branch`,
    );
    this.deps.forge.soon(projectId);
  }

  async closePr(projectId: string, number: number, comment: string): Promise<void> {
    await this.client(projectId).closePull(number, comment);
    this.deps.forge.soon(projectId);
  }

  actionsAvailable(projectId: string): Promise<boolean | null> {
    return this.client(projectId).ciAvailable();
  }

  /**
   * Forgejo has no Git Data write API, so no revert can be created through it: null asks the
   * loop for an agent-written revert, exactly as it does when main moved on (§5.8, §5.9).
   */
  async revertMerge(
    _projectId: string,
    _merge: { sha: string; prNumber: number; title: string },
  ): Promise<GitHubPrRef | null> {
    return null;
  }

  /**
   * Whether the revert's only parent is the squash merge and its tree is the merge's parent's:
   * the same proof as GitHub's tree comparison, from `GET /git/commits/{sha}`.
   */
  async revertMatches(
    projectId: string,
    revert: { headSha: string; mergeSha: string },
  ): Promise<boolean> {
    const client = this.client(projectId);
    const head = await client.commit(revert.headSha);
    if (head.parents.length !== 1 || head.parents[0] !== revert.mergeSha) return false;
    const merge = await client.commit(revert.mergeSha);
    const parent = merge.parents[0];
    if (!parent || merge.parents.length !== 1) return false;
    const before = await client.commit(parent);
    return head.treeSha === before.treeSha;
  }

  /**
   * Commit the vision file through the Contents API to `codeden/vision` (from the default branch,
   * or on top of its open PR), then open or update that PR (`docs/forges.md` §5.8, phase D).
   * Null when the file already matches the branch's copy. A stale branch from a closed or merged
   * vision PR is deleted and recreated from the default branch.
   */
  async shareVision(
    projectId: string,
    path: string,
    contents: string,
  ): Promise<GitHubPrRef | null> {
    const repo = this.forgeRepo(projectId);
    const client = this.client(projectId);
    const open = (await client.listPulls({ state: "open", limit: 100 })).find(
      (pr) => pr.headBranch === VISION_BRANCH,
    );
    const parentRef = open ? VISION_BRANCH : repo.defaultBranch;
    let current: { sha: string; contents: string } | null = null;
    try {
      current = await client.readFile(path, parentRef);
    } catch (error) {
      if (!(error instanceof ForgeError && error.forgeCode === "forge_not_found")) throw error;
    }
    const existing = current ? Buffer.from(current.contents, "base64").toString("utf8") : null;
    if (existing === contents) {
      return open ? { number: open.number, url: open.url, state: "open", title: open.title } : null;
    }
    const encoded = Buffer.from(contents, "utf8").toString("base64");
    const message = "docs: update the project vision\n\nSaved from the CodeDen vision editor.";
    if (open) {
      await client.putFile({
        path,
        contents: encoded,
        branch: VISION_BRANCH,
        ...(current ? { sha: current.sha } : {}),
        message,
      });
      this.deps.forge.soon(projectId);
      return { number: open.number, url: open.url, state: "open", title: open.title };
    }
    // A stale branch from a merged or closed vision PR is reset onto the default branch.
    if (await this.branchExists(projectId, VISION_BRANCH)) {
      await client.deleteBranch(VISION_BRANCH);
    }
    await client.putFile({
      path,
      contents: encoded,
      branch: repo.defaultBranch,
      newBranch: VISION_BRANCH,
      message,
    });
    const title = "Update the project vision";
    const pr = await client.createPull({
      head: VISION_BRANCH,
      base: repo.defaultBranch,
      title,
      draft: false,
      body: `Commits \`${path}\`, saved from the CodeDen vision editor. The factory reads the vision from the local checkout right away; merging this shares it with agent worktrees, which start from \`${repo.defaultBranch}\`.`,
    });
    this.deps.forge.soon(projectId);
    return { number: pr.number, url: pr.url, state: "open", title };
  }

  /* ------------------------------------------------------------ internals */

  private client(projectId: string) {
    return this.deps.forge.client(projectId);
  }

  private defaultBranch(projectId: string): string {
    return this.forgeRepo(projectId).defaultBranch;
  }

  /** The project's forge coordinates; a non-forge project cannot reach this port. */
  private forgeRepo(projectId: string) {
    const project = this.deps.projects.get(projectId);
    if (project.kind !== "forge") {
      throw conflict(`${project.name} is not a forge project`, "not_a_forge_project");
    }
    return project.forge;
  }

  /** Whether a branch exists, for the stale vision branch reset. */
  private async branchExists(projectId: string, branch: string): Promise<boolean> {
    try {
      await this.client(projectId).branchHead(branch);
      return true;
    } catch (error) {
      if (error instanceof ForgeError && error.forgeCode === "forge_not_found") return false;
      throw error;
    }
  }

  /** A login's live permission as write access; anything unreadable is `none`, never trusted. */
  private async associationOf(
    projectId: string,
    login: string | null,
  ): Promise<GithubAuthorAssociation> {
    if (!login) return "none";
    try {
      return associationFor(await this.client(projectId).permission(login));
    } catch {
      // A permission lookup that cannot answer (403, 5xx, no connection) is not write access.
      return "none";
    }
  }

  /** The default branch's commits the head misses, from `compare(head...default)` (§5.9). */
  private async compare(projectId: string, headSha: string): Promise<MainSince> {
    const compared = await this.client(projectId).compare(headSha, this.defaultBranch(projectId));
    return { behind: compared.behind, files: compared.files, complete: compared.complete };
  }

  /**
   * The fingerprint of what the PR at `headSha` itself changes, from the whole `.diff` read
   * pinned to that head (Forgejo lists no per-file patch). Null when the head moved or the diff
   * can't be told; the next read asks again for the head it then sees.
   */
  private async diffKeyAt(
    projectId: string,
    number: number,
    headSha: string,
  ): Promise<string | null> {
    const key = `${projectId}@${headSha}`;
    const hit = this.diffKeys.get(key);
    if (hit !== undefined) return hit;
    const diff = await this.client(projectId).pullDiff(number, headSha);
    if (!diff.headSha) return null;
    const value = prDiffKey(
      diff.files.map((file) => ({
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        status: file.status,
        patch: file.patch,
      })),
      diff.changedFiles,
    );
    if (value !== null) {
      this.diffKeys.set(key, value);
      while (this.diffKeys.size > 64) {
        const oldest = this.diffKeys.keys().next().value;
        if (oldest === undefined) break;
        this.diffKeys.delete(oldest);
      }
    }
    return value;
  }

  /** Commit statuses as the factory's checks; `none` when nothing reported, never green. */
  private async checksFor(
    projectId: string,
    sha: string,
  ): Promise<{ state: CommitChecks; failed: string[] }> {
    try {
      const summary = await this.client(projectId).commitStatuses(sha);
      const failed = summary.checks
        .filter((c) => c.conclusion !== null && !PASSING.has(c.conclusion))
        .map((c) => c.name);
      return { state: summary.state, failed };
    } catch (error) {
      throw new Error(`checks for ${sha.slice(0, 7)}: ${errorMessage(error)}`);
    }
  }
}

/**
 * The factory's port over both forges: each project is routed by its kind to the GitHub port or
 * the forge port, and a local project has no port at all. A forge project therefore never
 * reaches Octokit, and a project whose forge cannot be read fails closed.
 */
export interface ProjectFactoryPortDeps {
  projects: ProjectService;
  github: FactoryGithub;
  forge: FactoryGithub;
}

export class ProjectFactoryPort implements FactoryGithub {
  constructor(private readonly deps: ProjectFactoryPortDeps) {}

  isForgeProject(projectId: string): boolean {
    return this.port(projectId)?.isForgeProject(projectId) ?? false;
  }

  viewerLogin(projectId: string): Promise<string | null> {
    return this.port(projectId)?.viewerLogin(projectId) ?? Promise.resolve(null);
  }

  async issueAuthor(projectId: string, number: number): Promise<IssueAuthor> {
    return this.must(projectId).issueAuthor(projectId, number);
  }

  async commenters(projectId: string, number: number, opts: { pr: boolean }): Promise<Commenter[]> {
    return this.must(projectId).commenters(projectId, number, opts);
  }

  async createIssue(
    projectId: string,
    req: { title: string; body: string; labels: string[] },
  ): Promise<GitHubIssueRef> {
    return this.must(projectId).createIssue(projectId, req);
  }

  async labelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    return this.must(projectId).labelIssue(projectId, number, labels);
  }

  async unlabelIssue(projectId: string, number: number, labels: string[]): Promise<void> {
    return this.must(projectId).unlabelIssue(projectId, number, labels);
  }

  async comment(projectId: string, number: number, body: string): Promise<void> {
    return this.must(projectId).comment(projectId, number, body);
  }

  openIssues(projectId: string): GithubIssue[] {
    return this.port(projectId)?.openIssues(projectId) ?? [];
  }

  issue(projectId: string, number: number): GithubIssue | null {
    return this.port(projectId)?.issue(projectId, number) ?? null;
  }

  prRef(projectId: string, number: number): GitHubPrRef | null {
    return this.port(projectId)?.prRef(projectId, number) ?? null;
  }

  mergedPrClosing(projectId: string, issueNumber: number): GitHubPrRef | null {
    return this.port(projectId)?.mergedPrClosing(projectId, issueNumber) ?? null;
  }

  prForSession(projectId: string, sessionId: string, branch: string | null): GitHubPrRef | null {
    return this.port(projectId)?.prForSession(projectId, sessionId, branch) ?? null;
  }

  async prDetails(projectId: string, number: number): Promise<FactoryPr> {
    return this.must(projectId).prDetails(projectId, number);
  }

  async evidence(
    projectId: string,
    prNumber: number,
    issueNumber: number | null,
  ): Promise<PrEvidence> {
    return this.must(projectId).evidence(projectId, prNumber, issueNumber);
  }

  evidenceSupported(projectId: string): boolean {
    return this.port(projectId)?.evidenceSupported(projectId) ?? false;
  }

  async merge(
    projectId: string,
    number: number,
    opts: { sha: string | null; title: string },
  ): Promise<{ merged: boolean; sha: string | null }> {
    return this.must(projectId).merge(projectId, number, opts);
  }

  async commitChecks(projectId: string, sha: string): Promise<CommitChecks> {
    return this.must(projectId).commitChecks(projectId, sha);
  }

  async failedChecks(projectId: string, sha: string): Promise<string[]> {
    return this.must(projectId).failedChecks(projectId, sha);
  }

  async mainHead(projectId: string): Promise<MainHead> {
    return this.must(projectId).mainHead(projectId);
  }

  async mainHeadAt(projectId: string, at: string): Promise<MainHead | null> {
    return this.must(projectId).mainHeadAt(projectId, at);
  }

  async behindBy(projectId: string, number: number, headSha: string): Promise<number> {
    return this.must(projectId).behindBy(projectId, number, headSha);
  }

  async mainSince(projectId: string, number: number, headSha: string): Promise<MainSince> {
    return this.must(projectId).mainSince(projectId, number, headSha);
  }

  async updateBranch(projectId: string, number: number, expectedHeadSha: string): Promise<void> {
    return this.must(projectId).updateBranch(projectId, number, expectedHeadSha);
  }

  async closePr(projectId: string, number: number, comment: string): Promise<void> {
    return this.must(projectId).closePr(projectId, number, comment);
  }

  async actionsAvailable(projectId: string): Promise<boolean | null> {
    return this.must(projectId).actionsAvailable(projectId);
  }

  async revertMerge(
    projectId: string,
    merge: { sha: string; prNumber: number; title: string },
  ): Promise<GitHubPrRef | null> {
    return this.must(projectId).revertMerge(projectId, merge);
  }

  async revertMatches(
    projectId: string,
    revert: { headSha: string; mergeSha: string },
  ): Promise<boolean> {
    return this.must(projectId).revertMatches(projectId, revert);
  }

  async shareVision(
    projectId: string,
    path: string,
    contents: string,
  ): Promise<GitHubPrRef | null> {
    return this.must(projectId).shareVision(projectId, path, contents);
  }

  private port(projectId: string): FactoryGithub | null {
    let project: Project;
    try {
      project = this.deps.projects.get(projectId);
    } catch {
      return null;
    }
    switch (project.kind) {
      case "github":
        return this.deps.github;
      case "forge":
        return this.deps.forge;
      case "local":
        return null;
    }
  }

  private must(projectId: string): FactoryGithub {
    const port = this.port(projectId);
    if (!port) {
      throw conflict(
        "The software factory needs a GitHub or Forgejo project",
        "not_a_github_project",
      );
    }
    return port;
  }
}
