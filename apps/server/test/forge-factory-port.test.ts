import { FactoryLimits, FactoryTuning, type ReviewVerdict } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeError } from "../src/services/errors";
import { evaluateChecks } from "../src/services/factory/checks";
import { isTrustedCommenter } from "../src/services/factory/comment-trust";
import type { FactoryPr } from "../src/services/factory/github-port";
import { GithubFactoryPort } from "../src/services/factory/github-port";
import { githubRefused } from "../src/services/factory/merge";
import { trustedLogins } from "../src/services/factory/trust";
import {
  associationFor,
  ForgeFactoryPort,
  ProjectFactoryPort,
} from "../src/services/forge/factory-port";
import type { FakeForgejoIssue } from "./support/fake-forgejo";
import { createForgeEnv, type ForgeEnv } from "./support/forge-env";

/**
 * `docs/forges.md` phase C1: the factory's `FactoryGithub` port over a Forgejo project. Commit
 * statuses only, a merge pinned to the reviewed head, `mergeable` settled over two reads,
 * update-branch's pre/post head, compare for `mainSince`, and trust from live permissions and
 * `official`. No GitHub call is made for a forge project.
 */

let env: ForgeEnv;
const P = "p-forge";

beforeEach(() => {
  env = createForgeEnv();
});
afterEach(async () => {
  await env.close();
});

function port(): ForgeFactoryPort {
  return new ForgeFactoryPort({
    projects: env.projects,
    forge: env.service,
    log: (message) => env.logs.push(message),
  });
}

/** The forge error a call refused with, or a failed assertion. */
async function refusal(run: Promise<unknown>): Promise<ForgeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ForgeError) return error;
    throw error;
  }
  throw new Error("expected the forge to refuse");
}

/** A fake PR's head commit (the fake always stamps one). */
function head(pr: FakeForgejoIssue): string {
  if (!pr.headSha) throw new Error("the fake pull request has no head commit");
  return pr.headSha;
}

const approve: ReviewVerdict = {
  verdict: "approve",
  summary: "Looks good",
  criteria: [{ criterion: "works", met: true }],
  vision: { aligned: true },
  tests: { adequate: true },
  security: { concerns: [] },
  lessons: [],
};

function checksFor(opts: {
  files: string[];
  body?: string;
  evidence: boolean;
  testOutput: boolean;
  evidenceSupported?: boolean;
}) {
  const headSha = "head-1";
  const pr: FactoryPr = {
    ref: { number: 7, url: "https://forge.test/acme/widgets/pulls/7", state: "open" },
    title: "Add the settings panel",
    body: opts.body ?? "Fixes #3\n\n## Test results\n- 12 passed",
    headSha,
    headBranch: "codeden/settings",
    checks: "success",
    failedChecks: [],
    mergeable: "mergeable",
    additions: 40,
    deletions: 2,
    files: opts.files,
  };
  const { checks, outcome } = evaluateChecks({
    pr,
    issueTitle: "Add the settings panel",
    review: approve,
    approvedHead: headSha,
    reviewer: "codex",
    type: "feature",
    evidence: opts.evidence,
    testOutput: opts.testOutput,
    ...(opts.evidenceSupported === undefined ? {} : { evidenceSupported: opts.evidenceSupported }),
    audit: null,
    auditConfigured: false,
    ciTimedOut: true,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 5 } }),
    tuning: FactoryTuning.parse({}),
    largeChange: null,
    areas: { globs: [], topics: [] },
    now: "2026-11-23T10:00:00.000Z",
  });
  return {
    checks,
    outcome,
    check: (name: string) => checks.find((c) => c.name === name),
  };
}

describe("forge factory checks", () => {
  it("reads commit statuses, counts warning and error as failures, and names contexts", async () => {
    const pr = env.forge.addPr(
      "codeden/a",
      {},
      {
        statuses: [
          { context: "build", status: "success" },
          { context: "lint", status: "warning" },
          { context: "test", status: "error" },
          { context: "docs", status: "skipped" },
        ],
      },
    );

    const details = await port().prDetails(P, pr.number);

    expect(details.checks).toBe("failure");
    expect(details.failedChecks.sort()).toEqual(["lint", "test"]);
    expect(details.mergeState).toBe("unknown");
  });

  it("never reads a PR with no statuses as green", async () => {
    const pr = env.forge.addPr("codeden/a");

    const details = await port().prDetails(P, pr.number);

    expect(details.checks).toBe("none");
    expect(details.failedChecks).toEqual([]);
    expect(await port().commitChecks(P, head(pr))).toBe("none");
  });

  it("reads statuses on any commit, and names a failed one", async () => {
    env.forge.setCommitStatuses("main-2", [
      { context: "ci / test", status: "success" },
      { context: "ci / deploy", status: "failure" },
    ]);

    expect(await port().commitChecks(P, "main-2")).toBe("failure");
    expect(await port().failedChecks(P, "main-2")).toEqual(["ci / deploy"]);
  });

  it("reads the default branch's head and its statuses", async () => {
    env.forge.branchHeads.set("main", "main-3");
    env.forge.setCommitStatuses("main-3", [{ context: "ci", status: "success" }]);

    expect(await port().mainHead(P)).toEqual({
      sha: "main-3",
      checks: "success",
      failed: [],
    });
    // Forgejo has no `until` on commits: a head from a past time is unknown, never guessed.
    expect(await port().mainHeadAt(P, "2026-11-23T09:00:00.000Z")).toBeNull();
  });

  it("settles mergeable false over two reads of the same head, and never settles a draft", async () => {
    const conflicting = env.forge.addPr("codeden/a", {}, { mergeable: false });
    const details = port();

    expect((await details.prDetails(P, conflicting.number)).mergeable).toBe("unknown");
    expect((await details.prDetails(P, conflicting.number)).mergeable).toBe("conflicting");

    const draft = env.forge.addPr("codeden/b", {}, { draft: true, mergeable: false });
    expect((await details.prDetails(P, draft.number)).mergeable).toBe("unknown");
    expect((await details.prDetails(P, draft.number)).mergeable).toBe("unknown");
  });

  it("reads a clean PR as mergeable", async () => {
    const pr = env.forge.addPr("codeden/a", {}, { mergeable: true });
    expect((await port().prDetails(P, pr.number)).mergeable).toBe("mergeable");
  });
});

describe("forge factory merge", () => {
  it("squash-merges pinned to the reviewed head and reads the merge commit back", async () => {
    const pr = env.forge.addPr("codeden/a");

    const result = await port().merge(P, pr.number, {
      sha: head(pr),
      title: "Fix the bug (#1)",
    });

    expect(result).toEqual({ merged: true, sha: `merge-${pr.number}` });
    expect(env.forge.merges.at(-1)?.body).toMatchObject({
      Do: "squash",
      head_commit_id: pr.headSha,
      MergeTitleField: "Fix the bug (#1)",
    });
    expect((await port().prDetails(P, pr.number)).ref.state).toBe("merged");
  });

  it("counts a moved head (409) as a refusal, not a retry", async () => {
    const pr = env.forge.addPr("codeden/a");

    const error = await refusal(
      port().merge(P, pr.number, { sha: "stale-head", title: "Fix (#1)" }),
    );

    expect(error.forgeCode).toBe("forge_conflict");
    expect(githubRefused(error)).toBe(true);
    expect(env.forge.issues.get(pr.number)?.merged).toBe(false);
  });

  it("counts a refused style or unmergeable PR (405) as a refusal", async () => {
    env.forge.refuseMerge = { status: 405, message: "squash merges are not allowed" };
    const pr = env.forge.addPr("codeden/a");

    const error = await refusal(port().merge(P, pr.number, { sha: head(pr), title: "Fix (#1)" }));

    expect(error.forgeCode).toBe("forge_not_allowed");
    expect(githubRefused(error)).toBe(true);
  });

  it("does not count an unavailable forge as a refusal", async () => {
    env.forge.refuseMerge = { status: 503, message: "the forge is down" };
    const pr = env.forge.addPr("codeden/a");

    const error = await refusal(port().merge(P, pr.number, { sha: head(pr), title: "Fix (#1)" }));

    expect(error.forgeCode).toBe("forge_unavailable");
    expect(githubRefused(error)).toBe(false);
  });
});

describe("forge factory update-branch and compare", () => {
  it("refuses to update when the head moved, without calling update", async () => {
    const pr = env.forge.addPr("codeden/a");

    const error = await refusal(port().updateBranch(P, pr.number, "another-head"));

    expect(error.forgeCode).toBe("forge_conflict");
    expect(env.forge.updates).toEqual([]);
  });

  it("updates with style=merge and reports the new head", async () => {
    const pr = env.forge.addPr("codeden/a");
    const before = head(pr);

    await port().updateBranch(P, pr.number, before);

    expect(env.forge.updates).toEqual([`${pr.number}:${before}`]);
    const sent = env.forge.requests.find(
      (request) => request.method === "POST" && request.url.includes("/update"),
    );
    expect(sent?.url).toContain("style=merge");
    // The new head is read back: the approval and diffKey checks decide on it, not on `before`.
    const after = await port().prDetails(P, pr.number);
    expect(after.headSha).not.toBe(before);
    expect(after.headSha).toBe(`${before}-u1`);
    expect(env.logs.some((line) => line.includes("is now at"))).toBe(true);
  });

  it("compares the head to the default branch for mainSince, old rename paths included", async () => {
    const pr = env.forge.addPr("codeden/a");
    env.forge.compareResult = {
      totalCommits: 3,
      files: [
        { filename: "src/a.ts" },
        { filename: "src/b.ts", previous_filename: "src/old-b.ts" },
      ],
    };

    const since = await port().mainSince(P, pr.number, head(pr));

    expect(since).toEqual({
      behind: 3,
      files: ["src/a.ts", "src/b.ts", "src/old-b.ts"],
      complete: true,
    });
    expect(env.forge.compares.at(-1)).toBe(`${head(pr)}...main`);
    expect(await port().behindBy(P, pr.number, head(pr))).toBe(3);
  });

  it("marks a 300-file compare incomplete, never the whole change", async () => {
    const pr = env.forge.addPr("codeden/a");
    env.forge.compareResult = {
      totalCommits: 1,
      files: Array.from({ length: 300 }, (_, index) => ({ filename: `src/f${index}.ts` })),
    };

    const since = await port().mainSince(P, pr.number, head(pr));

    expect(since.behind).toBe(1);
    expect(since.files).toHaveLength(300);
    expect(since.complete).toBe(false);
  });

  it("answers whether CI can run: true, false, or unknown", async () => {
    env.forge.hasActions = true;
    env.forge.workflowFiles = [".forgejo/workflows/ci.yml"];
    expect(await port().actionsAvailable(P)).toBe(true);

    // Actions on without a workflow: a status may still come from another CI: unknown.
    env.forge.workflowFiles = [];
    expect(await port().actionsAvailable(P)).toBe(null);

    // Actions off, no workflow, and no status ever seen: CI can never run here.
    env.forge.hasActions = false;
    expect(await port().actionsAvailable(P)).toBe(false);

    // Another CI has reported before: unknown, not false.
    env.forge.setCommitStatuses("base-sha", [{ context: "woodpecker", status: "success" }]);
    expect(await port().actionsAvailable(P)).toBe(null);
  });
});

describe("forge factory trust", () => {
  it("maps live permissions to write access and unknown to none", async () => {
    env.forge.permissions.set("lee", "write");
    env.forge.permissions.set("eve", "read");
    env.forge.permissions.set("mallory", null);
    const writer = env.forge.addIssue({ author: "lee" });
    const reader = env.forge.addIssue({ author: "eve" });
    const unknown = env.forge.addIssue({ author: "mallory" });
    const owner = env.forge.addIssue({ author: env.forge.owner });
    const stranger = env.forge.addIssue({ author: "nobody" });
    const details = port();

    expect(await details.issueAuthor(P, writer.number)).toEqual({
      login: "lee",
      association: "collaborator",
    });
    expect((await details.issueAuthor(P, reader.number)).association).toBe("none");
    // A permission the forge cannot read is never write access.
    expect((await details.issueAuthor(P, unknown.number)).association).toBe("none");
    expect((await details.issueAuthor(P, owner.number)).association).toBe("owner");
    // A login without access is 404, which Forgejo reports as none.
    expect((await details.issueAuthor(P, stranger.number)).association).toBe("none");
    expect(associationFor("unknown")).toBe("none");
  });

  it("trusts a review's official flag only when no permission grants write access", async () => {
    env.forge.permissions.set("lee", "write");
    env.forge.permissions.set("eve", "read");
    env.forge.permissions.set("mallory", "read");
    const pr = env.forge.addPr("codeden/a", { author: "lee" });
    env.forge.addComment(pr.number, "I looked at the parsing", "lee");
    env.forge.addComment(pr.number, "Me too", "eve");
    env.forge.addReview(pr.number, { author: "eve", state: "APPROVED", official: true });
    env.forge.addReview(pr.number, { author: "mallory", state: "COMMENT", official: false });

    const commenters = await port().commenters(P, pr.number, { pr: true });

    expect(commenters).toEqual([
      { login: "lee", association: "collaborator" },
      { login: "eve", association: "none" },
      { login: "eve", association: "collaborator" },
      { login: "mallory", association: "none" },
    ]);
    // The factory's precedence: write access, then `official`, then the viewer/trusted authors.
    const trusted = trustedLogins(
      { trustedAuthors: ["trusted-person"] },
      await port().viewerLogin(P),
    );
    expect(isTrustedCommenter({ login: "lee", association: "collaborator" }, trusted)).toBe(true);
    const official = commenters.filter((c) => c.login === "eve")[1];
    expect(official).toBeDefined();
    expect(isTrustedCommenter(official as (typeof commenters)[number], trusted)).toBe(true);
    expect(isTrustedCommenter({ login: "mallory", association: "none" }, trusted)).toBe(false);
    // The viewer (`GET /user`) and trusted authors are trusted without write access.
    expect(isTrustedCommenter({ login: "codeden-bot", association: "none" }, trusted)).toBe(true);
    expect(isTrustedCommenter({ login: "trusted-person", association: "none" }, trusted)).toBe(
      true,
    );
  });

  it("reads the viewer from the connection, and fails closed when it is gone", async () => {
    expect(await port().viewerLogin(P)).toBe("codeden-bot");

    await env.secrets.delete("forgejo.token");
    const pr = env.forge.addPr("codeden/a");
    const details = port();

    expect(await details.viewerLogin(P)).toBeNull();
    expect((await refusal(details.prDetails(P, pr.number))).forgeCode).toBe("forge_not_connected");
    const merge = await refusal(details.merge(P, pr.number, { sha: head(pr), title: "Fix (#1)" }));
    expect(merge.forgeCode).toBe("forge_not_connected");
    expect(githubRefused(merge)).toBe(false);
    expect(env.forge.issues.get(pr.number)?.merged).toBe(false);
  });
});

describe("forge factory intake and projection", () => {
  it("reads open issues, one issue, PRs and linked issues from the projection", async () => {
    const issue = env.forge.addIssue({ title: "Crash on save" });
    const merged = env.forge.addPr(
      "codeden/fix",
      { title: "Fix the crash", body: `Fixes #${issue.number}`, state: "closed" },
      { merged: true, mergedAt: "2026-11-20T10:00:00Z" },
    );
    await env.service.syncNow(P);
    const details = port();

    expect(details.openIssues(P).map((row) => row.number)).toContain(issue.number);
    expect(details.issue(P, issue.number)?.title).toBe("Crash on save");
    expect(details.prRef(P, merged.number)).toMatchObject({ state: "merged" });
    expect(details.mergedPrClosing(P, issue.number)).toMatchObject({ number: merged.number });
  });

  it("links a PR to the session whose branch it heads", async () => {
    const session = env.addSession({ branch: "codeden/session-work" });
    const pr = env.forge.addPr("codeden/session-work");
    await env.service.syncNow(P);

    expect(port().prForSession(P, session.id, session.branch)?.number).toBe(pr.number);
  });

  it("creates, labels, unlabels and comments through the B1 writes", async () => {
    const details = port();
    const created = await details.createIssue(P, {
      title: "New work",
      body: "What to do",
      labels: ["bug"],
    });

    expect(details.issue(P, created.number)?.labels).toEqual(["bug"]);
    await details.labelIssue(P, created.number, ["enhancement"]);
    expect(details.issue(P, created.number)?.labels.sort()).toEqual(["bug", "enhancement"]);
    await details.unlabelIssue(P, created.number, ["bug"]);
    expect(details.issue(P, created.number)?.labels).toEqual(["enhancement"]);
    await details.comment(P, created.number, "Thanks, taking this on");
    expect(env.forge.issues.get(created.number)?.comments.at(-1)?.body).toContain(
      "Thanks, taking this on",
    );
  });

  it("supports evidence and finds none before it is posted, with no revert API", async () => {
    const pr = env.forge.addPr("codeden/a");
    const details = port();

    expect(details.evidenceSupported(P)).toBe(true);
    expect(await details.evidence(P, pr.number, null)).toEqual({
      screenshots: false,
      testOutput: false,
    });
    expect(await details.revertMerge(P, { sha: "m-1", prNumber: pr.number, title: "Fix" })).toBe(
      null,
    );
  });

  it("proves an exact revert by tree and parent, and nothing else", async () => {
    env.forge.gitCommits.set("merge-1", { tree: "tree-merged", parents: ["parent-1"] });
    env.forge.gitCommits.set("parent-1", { tree: "tree-before", parents: ["parent-0"] });
    env.forge.gitCommits.set("revert-1", { tree: "tree-before", parents: ["merge-1"] });
    env.forge.gitCommits.set("revert-2", { tree: "tree-before", parents: ["merge-1", "other"] });
    env.forge.gitCommits.set("revert-3", { tree: "tree-changed", parents: ["merge-1"] });
    const details = port();

    expect(await details.revertMatches(P, { headSha: "revert-1", mergeSha: "merge-1" })).toBe(true);
    expect(await details.revertMatches(P, { headSha: "revert-2", mergeSha: "merge-1" })).toBe(
      false,
    );
    expect(await details.revertMatches(P, { headSha: "revert-3", mergeSha: "merge-1" })).toBe(
      false,
    );
  });
});

describe("the factory's port per project kind", () => {
  it("routes a forge project to the forge port and never calls GitHub", async () => {
    const pr = env.forge.addPr(
      "codeden/a",
      {},
      { statuses: [{ context: "ci", status: "success" }] },
    );
    const ports = new ProjectFactoryPort({
      projects: env.projects,
      github: new GithubFactoryPort(env.github),
      forge: port(),
    });

    expect(ports.isForgeProject(P)).toBe(true);
    expect((await ports.prDetails(P, pr.number)).checks).toBe("success");
    expect(await ports.mainHead(P)).toMatchObject({ checks: "none" });
    expect(await ports.actionsAvailable(P)).toBe(null);
    const details = env.forge.addIssue({ author: "lee" });
    expect((await ports.issueAuthor(P, details.number)).login).toBe("lee");
    expect(await ports.viewerLogin(P)).toBe("codeden-bot");
    expect(env.githubRequests).toEqual([]);
  });

  it("routes a GitHub project to the GitHub port, and a local project to none", async () => {
    const ports = new ProjectFactoryPort({
      projects: env.projects,
      github: new GithubFactoryPort(env.github),
      forge: port(),
    });

    expect(ports.isForgeProject("p-gh")).toBe(true);
    expect(ports.isForgeProject("p-local")).toBe(false);
    expect(ports.openIssues("p-local")).toEqual([]);
    expect(ports.issue("p-local", 1)).toBeNull();
    expect(ports.prRef("p-local", 1)).toBeNull();
    expect(await ports.viewerLogin("p-local")).toBeNull();
    expect(ports.evidenceSupported("p-local")).toBe(false);
    await expect(ports.prDetails("p-local", 1)).rejects.toMatchObject({
      code: "not_a_github_project",
    });
  });
});

describe("the evidence checks on a forge PR (phase D)", () => {
  it("requires screenshots for UI changes, from evidence or not", () => {
    const missing = checksFor({
      files: ["src/settings/panel.tsx", "src/settings/panel.ts", "src/settings/panel.test.ts"],
      evidence: false,
      testOutput: false,
      evidenceSupported: true,
    });

    expect(missing.check("ui_evidence")).toMatchObject({ state: "fail" });
    expect(missing.check("ui_evidence")?.detail).toContain("no screenshots were attached");
    expect(missing.check("test_results")).toMatchObject({ state: "pass" });
    expect(missing.outcome).toBe("fail");

    const attached = checksFor({
      files: ["src/settings/panel.tsx", "src/settings/panel.test.ts"],
      evidence: true,
      testOutput: false,
      evidenceSupported: true,
    });
    expect(attached.check("ui_evidence")).toMatchObject({ state: "pass" });
    expect(attached.outcome).toBe("pass");
  });

  it("accepts test results from the PR description or attached test output", () => {
    const description = checksFor({
      files: ["src/order.ts"],
      body: "Fixes #3",
      evidence: false,
      testOutput: false,
      evidenceSupported: true,
    });
    expect(description.check("test_results")).toMatchObject({ state: "fail" });
    expect(description.check("test_results")?.detail).toBe(
      "No test results: add a `## Test results` section to the PR or attach the test output with attach_evidence",
    );

    const attached = checksFor({
      files: ["src/order.ts", "src/order.test.ts"],
      body: "Fixes #3",
      evidence: false,
      testOutput: true,
      evidenceSupported: true,
    });
    expect(attached.check("test_results")).toMatchObject({ state: "pass" });
    expect(attached.outcome).toBe("pass");
  });
});
