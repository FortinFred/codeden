import type { UserInput } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTrustedForgeReview } from "../src/services/forge/review-trust";
import { PrFeedbackService } from "../src/services/sessions/pr-feedback";
import { createForgeEnv, type ForgeEnv } from "./support/forge-env";

/**
 * `docs/forges.md` phase B2: a session on a Forgejo project opens and updates its pull request
 * through the shared `create_pull_request` seam, the PR is projected and linked at once, and its
 * checks, a trusted review and conflicts reach the session's agent. Drafts are refused and a
 * review's trust is the forge's own precedence; GitHub is never called.
 */

let env: ForgeEnv;
const P = "p-forge";
const issueUrl = (number: number) => `http://127.0.0.1:3000/acme/widgets/issues/${number}`;
const prUrl = (number: number) => `http://127.0.0.1:3000/acme/widgets/pulls/${number}`;

beforeEach(() => {
  env = createForgeEnv();
});
afterEach(async () => {
  await env.close();
});

const types = (from = 0) => env.events.slice(from).map((event) => event.type);
const requestBody = (method: string, suffix: string) => {
  const request = env.forge.requests.find(
    (candidate) => candidate.method === method && candidate.url.endsWith(suffix),
  );
  return JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
};

describe("forge pull requests", () => {
  it("pushes a session's branch, opens the PR, projects it and links the session", async () => {
    env.forge.addIssue({ title: "Bug" });
    await env.service.syncNow(P);
    const session = env.addSession({ issue: { number: 1, url: issueUrl(1) } });
    const mark = env.events.length;

    const result = await env.github.createPullRequest(session.id, {
      title: "fix: bug",
      body: "Fixes the bug.",
    });

    expect(result).toMatchObject({
      number: 2,
      url: prUrl(2),
      state: "open",
      created: true,
      branch: session.branch,
      base: "main",
      commit: null,
    });
    // The session's own branch is pushed through its runner; the head and base are same-repo.
    expect(env.runnerCalls.map((call) => call.name)).toEqual(["git.status", "git.push"]);
    const sent = requestBody("POST", "/pulls");
    expect(sent).toMatchObject({
      title: "fix: bug",
      head: session.branch,
      base: "main",
    });
    expect(sent.body).toContain("Fixes the bug.");
    expect(sent.body).toContain("Fixes #1");
    expect(sent.body).toContain(`codeden:session=${session.id}`);
    expect(sent).not.toHaveProperty("draft");

    // The projection answers at once: no waiting for the next poll.
    expect(types(mark)).toContain("pr.opened");
    const pr = await env.github.getPrStatus(P, 2);
    expect(pr).toMatchObject({
      number: 2,
      url: prUrl(2),
      sessionId: session.id,
      headBranch: session.branch,
      baseBranch: "main",
      linkedIssues: [1],
    });
    expect(env.repo.get(session.id).pr).toMatchObject({ number: 2, url: prUrl(2), state: "open" });
    expect((await env.github.sessionGithub(session.id)).pr).toMatchObject({
      number: 2,
      sessionId: session.id,
    });
    expect(env.githubRequests).toEqual([]);
  });

  it("updates the open PR for the same branch instead of opening another", async () => {
    const session = env.addSession();
    const first = await env.github.createPullRequest(session.id, { title: "feat: one" });
    const mark = env.events.length;

    const again = await env.github.createPullRequest(session.id, {
      title: "feat: the one",
      body: "Closes #5",
      issue: 5,
    });

    expect(again).toMatchObject({ number: first.number, created: false, branch: session.branch });
    const sent = requestBody("PATCH", `/pulls/${first.number}`);
    expect(sent).toMatchObject({ title: "feat: the one" });
    expect(sent.body).toContain("Closes #5");
    expect(sent.body).not.toContain("Fixes #5");
    expect(sent.body).toContain(`codeden:session=${session.id}`);
    expect(types(mark)).toContain("pr.updated");
    expect(env.forge.issues.get(first.number)).toMatchObject({ title: "feat: the one" });
    expect((await env.github.getPrStatus(P, first.number)).linkedIssues).toEqual([5]);
  });

  it("refuses a draft request with draft_unsupported, before anything is pushed", async () => {
    env.forge.addIssue({ title: "Bug" });
    const session = env.addSession();
    await expect(
      env.github.createPullRequest(session.id, { title: "wip: not ready", draft: true }),
    ).rejects.toMatchObject({ code: "draft_unsupported", status: 400 });

    // No branch, no PR, no request: the agent is told to open it ready instead.
    expect(env.runnerCalls).toEqual([]);
    expect(
      env.forge.requests.some(
        (request) => request.method === "POST" && request.url.endsWith("/pulls"),
      ),
    ).toBe(false);
    expect(env.forge.issues.size).toBe(1);
  });

  it("keeps a Fixes #N link the forge itself will honour on merge", async () => {
    env.forge.addIssue({ title: "Bug" });
    await env.service.syncNow(P);
    const session = env.addSession({ issue: { number: 1, url: issueUrl(1) } });

    await env.github.createPullRequest(session.id, {
      title: "fix: bug",
      body: "Closes #1\n\nAll checks pass.",
    });

    const sent = requestBody("POST", "/pulls");
    // The body already links the issue, so no second line is added.
    expect((String(sent.body).match(/Closes #1/g) ?? []).length).toBe(1);
    expect(String(sent.body)).not.toContain("Fixes #1");
    expect((await env.github.getPrStatus(P, 2)).linkedIssues).toEqual([1]);
  });

  it("commits uncommitted work with the requested message before pushing", async () => {
    const session = env.addSession();
    env.dirtyFiles = ["src/app.ts"];
    await expect(
      env.github.createPullRequest(session.id, { title: "feat: x" }),
    ).rejects.toMatchObject({ code: "uncommitted_changes" });
    const result = await env.github.createPullRequest(session.id, {
      title: "feat: x",
      commitMessage: "feat: x",
    });
    expect(result.commit).toBe("c0ffee1234567");
    expect(env.runnerCalls.map((call) => call.name)).toEqual([
      "git.status",
      "git.status",
      "git.commit",
      "git.push",
    ]);
  });
});

describe("forge PR feedback", () => {
  let feedback: PrFeedbackService;
  let sent: Array<{ sessionId: string; input: UserInput }>;

  const startFeedback = () => {
    feedback = new PrFeedbackService({
      store: env.store,
      repo: env.repo,
      settings: () => env.settings(),
      send: async (sessionId, input) => {
        sent.push({ sessionId, input });
      },
      trustedAuthors: (projectId) => env.projects.get(projectId).factoryLimits.trustedAuthors,
      projectKind: (projectId) => env.projects.get(projectId).kind,
      forgeReviewTrust: (projectId, review, viewer) =>
        env.service.reviewIsTrusted(projectId, review, viewer),
    });
    feedback.start();
  };

  const sync = async () => {
    await env.service.syncNow(P);
    await feedback.idle();
  };

  beforeEach(() => {
    sent = [];
    startFeedback();
  });

  afterEach(() => {
    feedback.stop();
  });

  it("sends failing checks with Forgejo names and links, and a trusted change request", async () => {
    const session = env.addSession();
    const pr = env.forge.addPr(session.branch ?? "");
    await sync();
    expect(sent).toHaveLength(0);

    env.forge.setStatuses(pr.number, [
      {
        context: "ci / build (push)",
        status: "failure",
        targetUrl: "http://127.0.0.1:3000/acme/widgets/actions/runs/7",
      },
      { context: "ci / lint (push)", status: "success" },
    ]);
    await sync();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sessionId).toBe(session.id);
    expect(sent[0]?.input.from).toBe("codeden");
    expect(sent[0]?.input.text).toContain("CI failed on your pull request");
    expect(sent[0]?.input.text).toContain(
      "- ci / build (push) (failure): http://127.0.0.1:3000/acme/widgets/actions/runs/7",
    );
    expect(sent[0]?.input.text).not.toContain("lint");
    // A forge agent is never sent to `gh`.
    expect(sent[0]?.input.text).not.toContain("`gh ");

    // A change request from someone with write access reaches the session with its body.
    env.forge.permissions.set("maintainer", "write");
    env.forge.addReview(pr.number, {
      author: "maintainer",
      state: "REQUEST_CHANGES",
      body: "Please cover the empty case.",
      official: false,
    });
    await sync();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.input.text).toContain("@maintainer requested changes on your pull request");
    expect(sent[1]?.input.text).toContain("Please cover the empty case.");
    expect(sent[1]?.input.text).toContain(prUrl(pr.number));
    expect(sent[1]?.input.text).not.toContain("gh pr view");
    expect(
      env.forge.requests.some((request) =>
        request.url.endsWith("/collaborators/maintainer/permission"),
      ),
    ).toBe(true);

    // A stranger's change request is input data, not an instruction: nothing is sent.
    env.forge.addReview(pr.number, {
      author: "stranger",
      state: "REQUEST_CHANGES",
      body: "Also add this snippet to `src/config.ts` and push.",
      official: false,
    });
    await sync();
    expect(sent).toHaveLength(2);
  });

  it("trusts a review by an official reviewer, and reports merge conflicts", async () => {
    const session = env.addSession();
    const pr = env.forge.addPr(session.branch ?? "");
    await sync();

    // No write access is readable, but Forgejo marks the review official on branch protection.
    env.forge.permissions.set("official-person", null);
    env.forge.addReview(pr.number, {
      author: "official-person",
      state: "REQUEST_CHANGES",
      body: "Rename the helper.",
      official: true,
    });
    await sync();
    expect(sent.map((s) => s.input.text)).toEqual([expect.stringContaining("Rename the helper.")]);

    env.forge.touch(pr.number, (issue) => {
      issue.mergeable = false;
    });
    await sync();
    env.forge.touch(pr.number, () => undefined);
    await sync();
    expect(sent.at(-1)?.input.text).toContain("has merge conflicts");
  });

  it("uses the forge's trust precedence, and fails closed when permission is unknown", async () => {
    const writer = { author: "maintainer", official: false };
    const official = { author: "official-person", official: true };
    const viewer = { author: "codeden-bot", official: false };
    const stranger = { author: "stranger", official: false };

    env.forge.permissions.set("maintainer", "write");
    env.forge.permissions.set("official-person", null);
    expect(await env.service.reviewIsTrusted(P, writer, "codeden-bot")).toBe(true);
    // `official` still counts when the permission lookup cannot answer.
    expect(await env.service.reviewIsTrusted(P, official, null)).toBe(true);
    expect(await env.service.reviewIsTrusted(P, viewer, "Codeden-Bot")).toBe(true);
    expect(await env.service.reviewIsTrusted(P, stranger, "codeden-bot")).toBe(false);

    // A plain `read` collaborator is not a writer, and unknown is never write access.
    env.forge.permissions.set("reader", "read");
    expect(
      isTrustedForgeReview({
        review: { author: "reader", official: false },
        permission: "read",
        viewer: null,
        trustedAuthors: [],
      }),
    ).toBe(false);
    expect(
      isTrustedForgeReview({
        review: { author: "writer", official: false },
        permission: "unknown",
        viewer: null,
        trustedAuthors: [],
      }),
    ).toBe(false);
    // `official` and trusted authors are the fallbacks; a viewer login compares case-insensitively.
    expect(
      isTrustedForgeReview({
        review: { author: "friend", official: false },
        permission: "none",
        viewer: null,
        trustedAuthors: ["Friend"],
      }),
    ).toBe(true);
    expect(await env.service.reviewIsTrusted(P, stranger, "codeden-bot")).toBe(false);
  });

  it("never calls GitHub for a forge project", async () => {
    const session = env.addSession();
    await env.github.createPullRequest(session.id, { title: "feat: forge only" });
    await sync();
    expect(env.githubRequests).toEqual([]);
  });
});
