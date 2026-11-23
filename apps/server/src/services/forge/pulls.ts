import { GithubPr, type Session } from "@codeden/contracts";
import type { EventStore } from "../../events/store";
import { badRequest } from "../errors";
import { diffPr } from "../github/diff";
import type { CreatePullRequestInput, CreatePullRequestResult } from "../github/pull-requests";
import type { GithubStore } from "../github/store";
import type { RunnerDeps } from "../runner-port";
import { prepareSessionBranch, pullRequestBody } from "../sessions/pr-branch";
import type { SessionRepo } from "../sessions/repo";
import type { ForgejoClient } from "./forgejo/client";
import type { ForgeProject } from "./forgejo/sync";

/**
 * Pull request writes on a forge project (`docs/forges.md` §5.5, phase B2): push the session's
 * branch, then open or update the PR whose head is that branch. The call goes through the
 * Forgejo client, so a draft request refuses with `draft_unsupported` (Forgejo's API has no
 * draft field, and opening a ready PR instead would be a capability lie) and only same-repository
 * heads are used. What the forge answers is projected at once (`pr.opened` / `pr.updated`) and
 * linked to the session, so the session's PR panel answers without waiting for the next sync.
 */

export interface ForgePullDeps extends RunnerDeps {
  client: ForgejoClient;
  data: GithubStore;
  events: EventStore;
  repo: SessionRepo;
}

/** The issues URL on the configured forge, never a hard-coded GitHub one. */
export function forgeIssueUrl(project: ForgeProject, number: number): string {
  const repo = project.forge;
  return `${repo.baseUrl.replace(/\/+$/, "")}/${repo.owner}/${repo.repo}/issues/${number}`;
}

/** Read the PR back from the forge and append the events for what changed. */
async function refreshPr(
  deps: ForgePullDeps,
  projectId: string,
  number: number,
  sessionId: string,
): Promise<GithubPr> {
  const snapshot = await deps.client.prSnapshot(number);
  const prev = deps.data.pr(projectId, number);
  const next = GithubPr.parse({ ...snapshot, sessionId });
  // The sync stamps the viewer; a write between polls must read it too, or one of CodeDen's own
  // reviews would look like a stranger's when the write is what carries the PR forward.
  const viewer = await deps.client.viewer().catch(() => null);
  const events = diffPr(prev, next, { viewer });
  if (events.length > 0) deps.events.append(events);
  return deps.data.pr(projectId, number) ?? next;
}

/**
 * Push the session's branch and open (or update) its pull request on the project's forge. The
 * base is the session's base branch, then the project's default branch; the head is always the
 * session's own branch in the same repository.
 */
export async function createPullRequest(
  deps: ForgePullDeps,
  session: Session,
  project: ForgeProject,
  input: CreatePullRequestInput,
): Promise<CreatePullRequestResult> {
  // Before the push: a refused draft must leave no commit or branch behind.
  if (input.draft) {
    throw badRequest(
      "Forgejo cannot open draft pull requests. Open it ready: drop `draft` and say in the body what is not ready.",
      "draft_unsupported",
    );
  }
  const { branch, base, commit } = await prepareSessionBranch(
    { runner: deps.runner, runners: deps.runners },
    session,
    project.forge.defaultBranch,
    input,
  );

  const issue = input.issue ?? session.issue?.number ?? null;
  const open = await deps.client.listPulls({ state: "open", limit: 100 });
  const existing = open.find((pr) => pr.headBranch === branch);
  let number: number;
  if (existing) {
    number = existing.number;
    await deps.client.updatePull(number, {
      title: input.title,
      ...(input.body !== undefined ? { body: pullRequestBody(input.body, issue, session) } : {}),
    });
  } else {
    const created = await deps.client.createPull({
      title: input.title,
      body: pullRequestBody(input.body ?? "", issue, session),
      head: branch,
      base,
      draft: false,
    });
    number = created.number;
  }

  const pr = await refreshPr(deps, project.id, number, session.id);
  deps.repo.update(session.id, (s) => ({
    ...s,
    pr: { number: pr.number, url: pr.url, state: pr.state, title: pr.title },
    issue: s.issue ?? (issue ? { number: issue, url: forgeIssueUrl(project, issue) } : null),
  }));
  return { number, url: pr.url, state: pr.state, created: !existing, branch, base, commit };
}
