import { describe, expect, it } from "vitest";
import {
  CreateForgeIssue,
  CreateForgePull,
  ForgeAttachment,
  ForgeCapabilities,
  ForgeCommit,
  ForgeCompare,
  type ForgeConnection,
  ForgeErrorCode,
  ForgeFileCommit,
  type ForgeIssue,
  ForgeIssueQuery,
  ForgePermission,
  type ForgePr,
  ForgeProvider,
  ForgePrRef,
  ForgePullQuery,
  ForgePutFile,
  ForgeRepo,
  ForgeRepoInfo,
  type ForgeReview,
  ForgeUploadedAttachment,
  GithubConnection,
  GithubIssue,
  GithubPr,
  GithubReview,
  MergeForgePull,
  SubmitForgeReview,
  UpdateForgePull,
} from "../src";

/** Parse, serialize to JSON and parse again; the result must be stable. */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const ts = "2026-11-22T10:00:00.000Z";

describe("forge contracts", () => {
  it("round-trips repository coordinates and capabilities", () => {
    const repo: ForgeRepo = {
      provider: "forgejo",
      baseUrl: "http://localhost:3000",
      host: "localhost:3000",
      owner: "acme",
      repo: "widgets",
      remoteUrl: "http://localhost:3000/acme/widgets.git",
      defaultBranch: "main",
    };
    expect(roundTrip(ForgeRepo, repo)).toEqual(repo);
    expect(ForgeProvider.parse("github")).toBe("github");
    expect(ForgeProvider.safeParse("gitlab").success).toBe(false);

    const capabilities: ForgeCapabilities = {
      issues: true,
      pullRequests: true,
      labels: true,
      reviews: true,
      permissionLookup: true,
      checkRuns: false,
      mergeState: false,
      draftPrs: false,
      issueStateReason: false,
      updateBranch: "unpinned",
      actions: "statuses-only",
      evidence: "attachments",
      revertApi: false,
      conditionalRequests: false,
    };
    expect(roundTrip(ForgeCapabilities, capabilities)).toEqual(capabilities);
    expect(ForgePermission.parse("unknown")).toBe("unknown");
    expect(ForgePermission.safeParse("admin").success).toBe(false);
  });

  it("names every ForgeError code the design specifies", () => {
    expect(ForgeErrorCode.options).toEqual([
      "forge_not_connected",
      "forge_not_found",
      "forge_forbidden",
      "forge_conflict",
      "forge_validation",
      "forge_not_allowed",
      "forge_rate_limited",
      "forge_unavailable",
    ]);
  });

  it("applies issue and pull request query defaults", () => {
    expect(ForgeIssueQuery.parse({})).toEqual({ state: "open", labels: [], limit: 100 });
    expect(ForgeIssueQuery.parse({ state: "all", labels: ["bug"], limit: "50" })).toEqual({
      state: "all",
      labels: ["bug"],
      limit: 50,
    });
    expect(ForgePullQuery.parse({})).toEqual({ state: "open", limit: 100 });
    expect(CreateForgeIssue.parse({ title: "Bug" })).toEqual({
      title: "Bug",
      body: "",
      labels: [],
    });
    expect(CreateForgePull.parse({ title: "Fix", head: "codeden/fix", base: "main" })).toEqual({
      title: "Fix",
      body: "",
      head: "codeden/fix",
      base: "main",
      draft: false,
    });
    expect(MergeForgePull.parse({})).toEqual({ method: "squash" });
    expect(UpdateForgePull.parse({})).toEqual({});
    expect(SubmitForgeReview.parse({ event: "approved", commitId: "abc" })).toEqual({
      event: "approved",
      body: "",
      commitId: "abc",
    });
  });

  it("round-trips contents, attachments and their responses", () => {
    const attachment: ForgeAttachment = {
      name: "shot.png",
      bytes: "aGVsbG8=",
      caption: "The failing screen",
    };
    expect(roundTrip(ForgeAttachment, attachment)).toEqual(attachment);
    const uploaded: ForgeUploadedAttachment = {
      name: "shot.png",
      url: "http://localhost:3000/attachments/1",
      caption: "The failing screen",
    };
    expect(roundTrip(ForgeUploadedAttachment, uploaded)).toEqual(uploaded);

    const put: ForgePutFile = {
      path: "docs/vision.md",
      contents: "aGVsbG8=",
      branch: "main",
      newBranch: "codeden/vision",
      message: "Update the vision",
      sha: "abc",
    };
    expect(roundTrip(ForgePutFile, put)).toEqual(put);
    const commit: ForgeFileCommit = {
      path: "docs/vision.md",
      sha: "blob",
      commitSha: "commit",
      url: "http://localhost:3000/acme/widgets/src/branch/main/docs/vision.md",
    };
    expect(roundTrip(ForgeFileCommit, commit)).toEqual(commit);
  });

  it("round-trips repository, compare, commit and PR reference shapes", () => {
    const info: ForgeRepoInfo = {
      defaultBranch: "main",
      hasIssues: true,
      hasPullRequests: true,
      hasActions: false,
      externalTracker: false,
      allowSquashMerge: true,
      permission: "write",
    };
    expect(roundTrip(ForgeRepoInfo, info)).toEqual(info);

    const compare: ForgeCompare = {
      behind: 3,
      files: ["src/a.ts", "src/old.ts"],
      complete: true,
    };
    expect(roundTrip(ForgeCompare, compare)).toEqual(compare);

    const commit: ForgeCommit = {
      sha: "abc",
      message: "Fix it",
      treeSha: "tree",
      parents: ["parent"],
    };
    expect(roundTrip(ForgeCommit, commit)).toEqual(commit);
    const prRef: ForgePrRef = {
      number: 4,
      url: "http://localhost:3000/acme/widgets/pulls/4",
    };
    expect(roundTrip(ForgePrRef, prRef)).toEqual(prRef);
  });

  it("keeps the provider-neutral aliases the same persisted shapes", () => {
    const issue: ForgeIssue = {
      projectId: "p1",
      number: 3,
      title: "Bug",
      state: "open",
      url: "https://forge.example.com/acme/widgets/issues/3",
      labels: ["bug"],
      author: "lee",
      body: null,
      comments: 0,
      createdAt: ts,
      updatedAt: ts,
      closedAt: null,
      stateReason: null,
      sessionIds: [],
    };
    expect(roundTrip(GithubIssue, issue)).toEqual(issue);

    const review: ForgeReview = {
      id: "r1",
      author: "lee",
      state: "approved",
      body: "Looks good",
      submittedAt: ts,
      url: null,
      official: true,
      stale: false,
    };
    expect(roundTrip(GithubReview, review)).toEqual(review);

    const pr: ForgePr = {
      id: "p1:4",
      projectId: "p1",
      number: 4,
      title: "Fix bug",
      state: "open",
      url: "https://forge.example.com/acme/widgets/pulls/4",
      author: "lee",
      headBranch: "codeden/fix",
      baseBranch: "main",
      headSha: "abc",
      checks: { state: "none", total: 0, passed: 0, failed: 0, pending: 0, checks: [] },
      reviewDecision: "none",
      reviews: [review],
      mergeable: "unknown",
      linkedIssues: [3],
      requestedReviewers: [],
      commits: [],
      sessionId: null,
      createdAt: ts,
      updatedAt: ts,
      mergedAt: null,
      closedAt: null,
    };
    expect(roundTrip(GithubPr, pr)).toEqual(pr);

    const connection: ForgeConnection = GithubConnection.parse({
      connected: true,
      source: "keychain",
      login: "codeden-bot",
      message: null,
      provider: "forgejo",
      host: "forge.example.com",
    });
    expect(connection.provider).toBe("forgejo");
    // Responses from before forges existed still parse.
    expect(
      GithubConnection.parse({
        connected: true,
        source: "gh",
        login: "octo",
        message: null,
      }).provider,
    ).toBeUndefined();
  });
});
