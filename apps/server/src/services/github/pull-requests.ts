import { type GitHubRepo, GithubPr, githubPrId, type Session } from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { notFound } from "../errors";
import { type GitBroker, githubCloneUrl } from "../git-broker";
import type { RunnerDeps, RunnerPort } from "../runner-port";
import { prepareSessionBranch, pullRequestBody } from "../sessions/pr-branch";
import type { SessionRepo } from "../sessions/repo";
import type { GithubClient } from "./client";
import { diffPr } from "./diff";
import { fetchPullRequests, toGithubPr } from "./graphql";
import type { GithubStore } from "./store";

/** What `create_pull_request` asks for. */
export interface CreatePullRequestInput {
  title: string;
  /** Markdown description; the issue link and session footer are added. */
  body?: string;
  /** Open as a draft (new PRs only). */
  draft?: boolean;
  /** Target branch; default the session's base branch, then the repository default. */
  base?: string;
  /** Issue the PR resolves (`Fixes #N`); default the session's issue. */
  issue?: number;
  /** Commit uncommitted changes with this message before pushing. */
  commitMessage?: string;
}

export interface CreatePullRequestResult {
  number: number;
  url: string;
  state: GithubPr["state"];
  created: boolean;
  branch: string;
  base: string;
  commit: string | null;
}

export interface PullRequestDeps extends RunnerDeps {
  client: GithubClient;
  store: GithubStore;
  events: EventStore;
  repo: SessionRepo;
  /** Brokers the push credential for a runner that doesn't share this disk (§9.2). */
  git?: GitBroker;
}

/** The session PR body, shared with a forge project (`docs/forges.md` §5.5). */
export { pullRequestBody };

/**
 * Push the session's branch through its runner and open (or update) its pull request (§8.2,
 * §9). The PR is projected right away (`pr.opened` / `pr.updated`) and linked to the session.
 */
export async function createPullRequest(
  deps: PullRequestDeps,
  session: Session,
  repo: GitHubRepo,
  input: CreatePullRequestInput,
): Promise<CreatePullRequestResult> {
  const git = deps.git;
  const { branch, base, commit } = await prepareSessionBranch(
    {
      runner: deps.runner,
      runners: deps.runners,
      ...(git
        ? {
            credentialFor: (runner: RunnerPort) =>
              git.credentialFor(runner, githubCloneUrl(repo.owner, repo.repo)),
          }
        : {}),
    },
    session,
    repo.defaultBranch,
    input,
  );

  const issue = input.issue ?? session.issue?.number ?? null;
  const existing = await deps.client.run(async (octokit) => {
    const res = await octokit.rest.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      head: `${repo.owner}:${branch}`,
      state: "open",
      per_page: 1,
    });
    return res.data[0];
  });
  let number: number;
  if (existing) {
    number = existing.number;
    await deps.client.run((octokit) =>
      octokit.rest.pulls.update({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: existing.number,
        title: input.title,
        ...(input.body !== undefined ? { body: pullRequestBody(input.body, issue, session) } : {}),
      }),
    );
  } else {
    const created = await deps.client.run((octokit) =>
      octokit.rest.pulls.create({
        owner: repo.owner,
        repo: repo.repo,
        title: input.title,
        body: pullRequestBody(input.body ?? "", issue, session),
        head: branch,
        base,
        draft: input.draft ?? false,
      }),
    );
    number = created.data.number;
  }

  const pr = await refreshPr(deps, session.projectId ?? "", repo, number, session.id);
  deps.repo.update(session.id, (s) => ({
    ...s,
    pr: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
    issue:
      s.issue ??
      (issue
        ? { number: issue, url: `https://github.com/${repo.owner}/${repo.repo}/issues/${issue}` }
        : null),
  }));
  return { number, url: pr.url, state: pr.state, created: !existing, branch, base, commit };
}

/** Re-read one PR with GraphQL and append the events for what changed. */
export async function refreshPr(
  deps: Pick<PullRequestDeps, "client" | "store" | "events">,
  projectId: string,
  repo: GitHubRepo,
  number: number,
  sessionId?: string | null,
): Promise<GithubPr> {
  const [fetched] = await fetchPullRequests(deps.client, repo.owner, repo.repo, [number]);
  if (!fetched)
    throw notFound(`No pull request #${number} in ${repo.owner}/${repo.repo}`, "pr_not_found");
  const prev = deps.store.pr(projectId, number);
  const next = GithubPr.parse(
    toGithubPr(projectId, fetched.node, sessionId ?? prev?.sessionId ?? null),
  );
  const events = diffPr(prev, next, { viewer: fetched.viewer });
  if (events.length > 0) deps.events.append(events);
  return deps.store.pr(projectId, number) ?? { ...next, id: githubPrId(projectId, number) };
}
