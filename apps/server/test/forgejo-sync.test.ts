import type { GithubIssue, GithubPr, Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createForgeEnv, FORGE_TEST_NOW, type ForgeEnv } from "./support/forge-env";

let env: ForgeEnv;
const P = "p-forge";

beforeEach(() => {
  env = createForgeEnv();
});
afterEach(async () => {
  // Every sync and read in this suite is read-only: nothing POSTs, PATCHes or DELETEs.
  expect(env.forge.requests.every((request) => request.method === "GET")).toBe(true);
  await env.close();
});

const types = (from = 0) => env.events.slice(from).map((e) => e.type);
const synced = () =>
  env.events.find((e) => e.type === "forge.synced") as
    | { payload: { projectId: string; issues: GithubIssue[]; prs: GithubPr[] } }
    | undefined;
const listRequests = () => env.forge.requests.filter((request) => request.url.includes("/issues?"));

describe("forge sync", () => {
  it("imports open items and the last 30 days of closed ones as one silent forge.synced", async () => {
    const bug = env.forge.addIssue({ title: "Bug", labels: ["bug"] });
    const pr = env.forge.addPr("codeden/task-1", { body: "Fixes #1" });
    const recent = env.forge.addIssue({
      state: "closed",
      title: "Fixed",
      createdAt: "2026-10-30T00:00:00Z",
      updatedAt: "2026-10-30T00:00:00Z",
      closedAt: "2026-10-30T00:00:00Z",
    });
    env.forge.addIssue({
      state: "closed",
      title: "Ancient",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      closedAt: "2026-09-01T00:00:00Z",
    });
    const session = env.addSession({ branch: "codeden/task-1" });

    const mark = env.events.length;
    await env.service.syncNow(P);

    expect(types(mark)).toEqual(["forge.synced", "pr.updated"]);
    const payload = synced()?.payload;
    expect(payload?.projectId).toBe(P);
    expect(payload?.issues.map((issue) => issue.number).sort()).toEqual([
      bug.number,
      recent.number,
    ]);
    expect(payload?.issues.every((issue) => issue.stateReason === null)).toBe(true);
    expect(payload?.prs).toHaveLength(1);
    expect(payload?.prs[0]).toMatchObject({
      number: pr.number,
      sessionId: session.id,
      linkedIssues: [1],
      checks: { state: "none" },
      mergeable: "mergeable",
    });

    // PR rows are never issues; closed items older than 30 days are not imported.
    expect(env.service.listIssues(P).map((issue) => issue.number)).toEqual([bug.number]);
    expect(env.service.listIssues(P, { state: "all" }).map((issue) => issue.number)).not.toContain(
      pr.number,
    );
    expect(env.service.listIssues(P, { state: "all" })).toHaveLength(2);
    expect(env.service.listPrs(P)).toHaveLength(1);
    expect(types()).not.toContain("github.synced");
  });

  it("moves the cursor back a minute and de-duplicates the overlapping rows", async () => {
    const bug = env.forge.addIssue({ title: "Bug" });
    env.forge.addPr("feature/x");
    await env.service.syncNow(P);

    env.forge.touch(bug.number, (issue) => {
      issue.title = "Bug fixed";
    });
    const mark = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark)).toContain("issue.updated");
    const updated = env.events.slice(mark).find((e) => e.type === "issue.updated") as
      | { payload: { issue: GithubIssue; changes: string[] } }
      | undefined;
    expect(updated?.payload).toMatchObject({ issue: { title: "Bug fixed" }, changes: ["title"] });

    // A second pass sees the same row again (the overlap) and writes nothing.
    const mark2 = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark2)).toEqual([]);

    // The second pass read from the newest updated_at minus the one-minute overlap.
    const request = listRequests().at(-1);
    const since = new URL(request?.url ?? "", "http://x").searchParams.get("since");
    expect(since).toBe(new Date(Date.parse(bug.updatedAt) - 60_000).toISOString());
  });

  it("refreshes a PR whose mergeable state has not settled, and never as an issue", async () => {
    const pr = env.forge.addPr("feature/merge", {}, { mergeable: false });
    await env.service.syncNow(P);
    expect(env.service.listPrs(P)[0]?.mergeable).toBe("unknown");
    const reads = () => env.forge.requests.filter((r) => r.url.endsWith(`/pulls/${pr.number}`));

    const before = reads().length;
    const mark = env.events.length;
    await env.service.syncNow(P);
    expect(reads().length).toBeGreaterThan(before);
    expect(env.service.listPrs(P)[0]?.mergeable).toBe("conflicting");
    expect(types(mark)).toContain("pr.updated");
    expect(types(mark)).not.toContain("issue.updated");
    expect(env.service.listIssues(P)).toHaveLength(0);
  });

  it("turns commit statuses into checks transitions; a warning never passes", async () => {
    const pr = env.forge.addPr("codeden/task-1");
    const session = env.addSession({ branch: "codeden/task-1" });
    await env.service.syncNow(P);

    env.forge.setStatuses(pr.number, [{ context: "ci / test (push)", status: "warning" }]);
    const failed = env.events.length;
    await env.service.syncNow(P);
    expect(types(failed)).toContain("pr.checks_failed");
    const failure = env.events.slice(failed).find((e) => e.type === "pr.checks_failed") as
      | { sessionId: string; payload: { pr: GithubPr } }
      | undefined;
    expect(failure?.sessionId).toBe(session.id);
    expect(failure?.payload.pr.checks).toMatchObject({
      state: "failure",
      failed: 1,
      checks: [{ name: "ci / test (push)", conclusion: "warning" }],
    });

    env.forge.setStatuses(pr.number, [{ context: "ci / test (push)", status: "success" }]);
    const passed = env.events.length;
    await env.service.syncNow(P);
    expect(types(passed)).toContain("pr.checks_passed");
    expect(env.service.listPrs(P)[0]?.checks.state).toBe("success");
  });

  it("emits review.submitted with the pass viewer and counts only official reviews", async () => {
    env.forge.setRequiredApprovals("main", 1);
    const pr = env.forge.addPr("codeden/task-1");
    env.addSession({ branch: "codeden/task-1" });
    await env.service.syncNow(P);
    expect(env.service.listPrs(P)[0]?.reviewDecision).toBe("review_required");

    env.forge.addReview(pr.number, {
      author: "maintainer",
      state: "APPROVED",
      body: "Looks good",
      official: true,
    });
    const mark = env.events.length;
    await env.service.syncNow(P);
    const submitted = env.events.slice(mark).find((e) => e.type === "review.submitted") as
      | { payload: { pr: GithubPr; review: { official?: boolean; state: string }; viewer: string } }
      | undefined;
    expect(submitted?.payload).toMatchObject({
      review: { author: "maintainer", state: "approved", official: true },
      viewer: "codeden-bot",
    });
    expect(env.service.listPrs(P)[0]?.reviewDecision).toBe("approved");

    // A reviewer CodeDen cannot verify: the review exists, but it does not decide the PR.
    env.forge.addReview(pr.number, {
      author: "stranger",
      state: "REQUEST_CHANGES",
      body: "Do it differently",
      official: false,
    });
    const mark2 = env.events.length;
    await env.service.syncNow(P);
    expect(types(mark2)).toContain("review.submitted");
    expect(env.service.listPrs(P)[0]?.reviewDecision).toBe("approved");
    const prProjection = env.service.listPrs(P)[0];
    expect(prProjection?.reviews.find((review) => review.author === "stranger")).toMatchObject({
      state: "changes_requested",
      official: false,
    });
  });

  it("does not count a stale official approval", async () => {
    env.forge.setRequiredApprovals("main", 1);
    const pr = env.forge.addPr("codeden/task-1");
    env.addSession({ branch: "codeden/task-1" });
    env.forge.addReview(pr.number, { author: "maintainer", state: "APPROVED", stale: true });
    await env.service.syncNow(P);
    expect(env.service.listPrs(P)[0]?.reviewDecision).toBe("review_required");
  });

  it("stamps a null viewer when the token cannot read its account", async () => {
    // A specific-repository token: `/user` is forbidden, so no login is CodeDen's own (§6.2).
    env.forge.viewer = null;
    env.forge.setRequiredApprovals("main", 1);
    const pr = env.forge.addPr("codeden/task-1");
    env.addSession({ branch: "codeden/task-1" });
    await env.service.syncNow(P);
    expect(env.service.listPrs(P)[0]?.reviewDecision).toBe("review_required");

    env.forge.addReview(pr.number, { author: "maintainer", state: "APPROVED", official: true });
    const mark = env.events.length;
    await env.service.syncNow(P);
    const submitted = env.events.slice(mark).find((e) => e.type === "review.submitted") as
      | { payload: { viewer: string | null } }
      | undefined;
    expect(submitted?.payload.viewer).toBeNull();
    // `official` is the fallback when no live permission is available.
    expect(env.service.listPrs(P)[0]?.reviewDecision).toBe("approved");
  });

  it("fills issue.commented from one comment read, capped and marker-free", async () => {
    const bug = env.forge.addIssue({ title: "Bug" });
    env.forge.addComment(bug.number, "Before the import");
    await env.service.syncNow(P);
    expect(env.service.listIssues(P)[0]?.comments).toBe(1);

    env.forge.addComment(bug.number, "Still broken on Windows");
    const mark = env.events.length;
    await env.service.syncNow(P);
    const commented = env.events.slice(mark).find((e) => e.type === "issue.commented") as
      | {
          payload: {
            issue: GithubIssue;
            comments: Array<{ author: string | null; body: string; fromCodeden: boolean }>;
          };
        }
      | undefined;
    expect(commented?.payload.comments).toEqual([
      expect.objectContaining({
        author: "lee",
        body: "Still broken on Windows",
        fromCodeden: false,
      }),
    ]);

    env.forge.addComment(bug.number, `Triage\n\n<!-- codeden -->`);
    const mark2 = env.events.length;
    await env.service.syncNow(P);
    const own = env.events.slice(mark2).find((e) => e.type === "issue.commented") as
      | { payload: { comments: Array<{ body: string; fromCodeden: boolean }> } }
      | undefined;
    expect(own?.payload.comments[0]).toMatchObject({ body: "Triage", fromCodeden: true });

    // At most 10 new comments and 20 000 characters each.
    for (let i = 0; i < 12; i++) env.forge.addComment(bug.number, `note ${i}`);
    const mark3 = env.events.length;
    await env.service.syncNow(P);
    const many = env.events.slice(mark3).find((e) => e.type === "issue.commented") as
      | { payload: { comments: Array<{ body: string }> } }
      | undefined;
    expect(many?.payload.comments).toHaveLength(10);

    env.forge.addComment(bug.number, "x".repeat(25_000));
    const mark4 = env.events.length;
    await env.service.syncNow(P);
    const huge = env.events.slice(mark4).find((e) => e.type === "issue.commented") as
      | { payload: { comments: Array<{ body: string }> } }
      | undefined;
    expect(huge?.payload.comments[0]?.body).toHaveLength(20_000);
  });

  it("backs off on 429 with the retry-after the forge sends", async () => {
    env.forge.rateLimited = true;
    await expect(env.service.syncNow(P)).rejects.toMatchObject({
      forgeCode: "forge_rate_limited",
    });
    const status = env.service.syncStatus(P);
    expect(status.lastError).toContain("too many requests");
    expect(Date.parse(status.nextSyncAt ?? "")).toBe(FORGE_TEST_NOW + 30_000);
  });

  it("never syncs a github or local project", async () => {
    env.forge.addIssue({ title: "Should not be requested" });
    const mark = env.events.length;
    await env.service.syncNow("p-gh");
    await env.service.syncNow("p-local");
    expect(env.events).toHaveLength(mark);
    expect(env.forge.requests).toHaveLength(0);
    expect(env.service.syncStatus("p-gh").lastSyncAt).toBeNull();
  });

  it("starts a project that becomes a forge project, and stops one that leaves", async () => {
    env.service.start();
    await waitFor(() => types().includes("forge.synced"));

    const asForge = {
      ...env.localProject,
      kind: "forge" as const,
      forge: env.forgeProject.kind === "forge" ? env.forgeProject.forge : undefined,
    } as Project;
    env.store.append([{ type: "project.updated", sessionId: null, payload: { project: asForge } }]);
    const synced = () =>
      env.events.some(
        (e) =>
          e.type === "forge.synced" && (e.payload as { projectId: string }).projectId === "p-local",
      );
    await waitFor(synced);

    // Back to local: the scheduler skips it, and even a direct sync does nothing.
    const asLocal = { ...env.localProject } as Project;
    env.store.append([{ type: "project.updated", sessionId: null, payload: { project: asLocal } }]);
    const mark = env.events.length;
    const requests = env.forge.requests.length;
    await env.service.syncNow("p-local");
    expect(env.events).toHaveLength(mark);
    expect(env.forge.requests).toHaveLength(requests);
  });

  it("never writes to the forge, for the sync or the read APIs", async () => {
    const issue = env.forge.addIssue({ title: "Bug" });
    const pr = env.forge.addPr("codeden/task-1", { body: "Fixes #1" });
    pr.diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const session = env.addSession({ branch: "codeden/task-1" });
    await env.service.syncNow(P);
    await env.service.syncNow(P);

    await env.github.getIssue(P, issue.number);
    await env.github.getPrDetails(`${P}:${pr.number}`);
    await env.github.getPrDiff(`${P}:${pr.number}`);
    await env.github.issuesResponse(P, "open", 100);
    await env.github.prsResponse(P, "open", 100);
    await env.github.sessionGithub(session.id);

    expect(env.forge.requests.length).toBeGreaterThan(0);
    expect(env.forge.requests.map((request) => request.method).filter((m) => m !== "GET")).toEqual(
      [],
    );
  });
});

describe("forge read APIs", () => {
  it("serves forge projects from the projection and the client, never GitHub", async () => {
    const bug = env.forge.addIssue({ title: "Bug", labels: ["bug"], body: "Broken" });
    const pr = env.forge.addPr("codeden/task-1", { body: "Fixes #1" });
    pr.diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const session = env.addSession({ branch: "codeden/task-1" });
    env.forge.addComment(bug.number, `Triage\n\n<!-- codeden -->`, "codeden-bot");
    await env.service.syncNow(P);
    env.repo.update(session.id, (current) => ({
      ...current,
      pr: {
        number: pr.number,
        url: `${env.forge.baseUrl}/acme/widgets/pulls/${pr.number}`,
        state: "open",
        title: "A change",
      },
    }));

    const issues = await env.github.issuesResponse(P, "open", 100);
    expect(issues.connection).toMatchObject({
      connected: true,
      source: "keychain",
      login: "codeden-bot",
      provider: "forgejo",
      host: "127.0.0.1:3000",
    });
    expect(issues.sync).toMatchObject({ projectId: P, intervalMs: 15_000 });
    expect(issues.issues).toHaveLength(1);

    const prs = await env.github.prsResponse(P, "open", 100);
    expect(prs.prs[0]).toMatchObject({ number: pr.number, sessionId: session.id });

    const details = await env.github.getIssue(P, bug.number);
    expect(details).toMatchObject({ title: "Bug", labels: ["bug"], sessionIds: [] });
    expect(details.recentComments).toEqual([
      expect.objectContaining({ body: "Triage", author: "codeden-bot" }),
    ]);

    const prDetails = await env.github.getPrDetails(`${P}:${pr.number}`);
    expect(prDetails).toMatchObject({
      number: pr.number,
      sessionId: session.id,
      body: "Fixes #1",
      changedFiles: 1,
      mergeState: "unknown",
      files: [{ path: "src/a.ts", status: "modified" }],
    });

    const diff = await env.github.getPrDiff(`${P}:${pr.number}`);
    expect(diff.headSha).toBe(pr.headSha);
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0]?.patch).toContain("+b");

    const sessionPr = await env.github.sessionGithub(session.id);
    expect(sessionPr.connection.provider).toBe("forgejo");
    expect(sessionPr.pr).toMatchObject({ number: pr.number });

    // The projection lists work too (no fresh read), with the session link.
    expect((await env.github.listIssues(P))[0]?.number).toBe(bug.number);
    expect(env.github.listPrs(P)[0]?.number).toBe(pr.number);

    // A forge project's GitHub-only writes fail closed without touching either forge.
    try {
      await env.github.mergePr(`${P}:${pr.number}`, { method: "squash" });
      expect.unreachable("a forge project must not accept a GitHub PR write");
    } catch (error) {
      expect(error).toMatchObject({ code: "not_a_github_project", status: 409 });
    }
    expect(env.githubRequests).toEqual([]);
  });

  it("keeps local projects without forge features", async () => {
    expect(() => env.service.listIssues("p-local")).toThrow("notes is not a forge project");
    await expect(env.github.listIssues("p-local")).rejects.toMatchObject({
      code: "not_a_github_project",
    });
    const response = await env.github.issuesResponse("p-local", "open", 10);
    expect(response).toMatchObject({ connection: { connected: false }, sync: null, issues: [] });
    expect(env.githubRequests).toEqual([]);
  });
});

async function waitFor(probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
