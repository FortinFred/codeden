import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../src/services/forge/forgejo/diff";
import {
  parseClosingIssues,
  reviewDecisionFor,
  toForgeIssue,
  toForgePr,
  toForgeReview,
  toMergeable,
} from "../src/services/forge/forgejo/map";
import {
  toForgeChecksSummary,
  toForgeCommit,
  toForgeCompare,
} from "../src/services/forge/forgejo/map-git";

describe("Forgejo mapping", () => {
  it("maps issues without inventing a state reason", () => {
    const issue = toForgeIssue("p1", {
      number: 3,
      title: "Bug",
      state: "closed",
      html_url: "http://localhost:3000/acme/widgets/issues/3",
      labels: [{ id: 1, name: "bug" }],
      user: { login: "lee" },
      body: "Broken",
      comments: 2,
      created_at: "2026-11-22T09:00:00Z",
      updated_at: "2026-11-22T10:00:00Z",
      closed_at: "2026-11-22T10:00:00Z",
    });
    expect(issue.state).toBe("closed");
    expect(issue.stateReason).toBeNull();
    expect(issue.updatedAt).toBe("2026-11-22T10:00:00Z");
  });

  it("parses the closing keywords Forgejo understands", () => {
    expect(
      parseClosingIssues("Fixes #3, closes: #4. Resolved #5; fixed #3 again. Not #0."),
    ).toEqual([3, 4, 5]);
    expect(parseClosingIssues("No issue here")).toEqual([]);
    expect(parseClosingIssues(null)).toEqual([]);
  });

  it("keeps mergeable false unknown until a second read of the same head", () => {
    const raw = {
      number: 4,
      title: "Fix",
      state: "open",
      html_url: "http://localhost:3000/acme/widgets/pulls/4",
      head: { ref: "codeden/fix", sha: "head" },
      base: { ref: "main", sha: "base" },
      mergeable: false,
    };
    expect(toMergeable(raw)).toBe("unknown");
    expect(toMergeable(raw, { headSha: "head", mergeable: false })).toBe("conflicting");
    expect(toMergeable(raw, { headSha: "older", mergeable: false })).toBe("unknown");
    expect(toMergeable({ ...raw, draft: true }, { headSha: "head", mergeable: false })).toBe(
      "unknown",
    );
    expect(toMergeable({ ...raw, mergeable: true })).toBe("mergeable");
  });

  it("maps a PR row with linked issues and requested reviewers", () => {
    const pr = toForgePr("p1", {
      number: 4,
      title: "Fix bug",
      body: "Fixes #3",
      state: "open",
      html_url: "http://localhost:3000/acme/widgets/pulls/4",
      user: { login: "lee" },
      head: { ref: "codeden/fix", sha: "abc" },
      base: { ref: "main", sha: "def" },
      requested_reviewers: [{ login: "sam" }],
      requested_reviewers_teams: [{ name: "reviewers", organization: { name: "acme" } }],
      mergeable: true,
      created_at: "2026-11-22T09:00:00.000Z",
      updated_at: "2026-11-22T10:00:00.000Z",
    });
    expect(pr.linkedIssues).toEqual([3]);
    expect(pr.requestedReviewers).toEqual(["acme/reviewers", "sam"]);
    expect(pr.mergeable).toBe("mergeable");
    expect(pr.checks.state).toBe("none");
  });

  it("maps official, stale and dismissed reviews", () => {
    const review = toForgeReview({
      id: 7,
      user: { login: "sam" },
      state: "APPROVED",
      body: "Looks good",
      submitted_at: "2026-11-22T10:00:00Z",
      html_url: "http://localhost:3000/acme/widgets/pulls/4#review-7",
      official: true,
      stale: false,
    });
    expect(review.state).toBe("approved");
    expect(review.official).toBe(true);
    expect(review.stale).toBe(false);
    expect(toForgeReview({ id: 8, state: "REQUEST_CHANGES", dismissed: true }).state).toBe(
      "dismissed",
    );
    // An unknown state is never an approval.
    expect(toForgeReview({ id: 9, state: "FUTURE_STATE" }).state).toBe("commented");
  });

  it("makes warning a failure and deduplicates statuses by context", () => {
    const summary = toForgeChecksSummary({
      state: "warning",
      total_count: 6,
      statuses: [
        { context: "ci", status: "success", created_at: "2026-11-22T09:00:00Z" },
        { context: "ci", status: "warning", created_at: "2026-11-22T10:00:00Z" },
        { context: "lint", status: "error" },
        { context: "audit", status: "failure" },
        { context: "deploy", status: "pending" },
        { context: "docs", status: "skipped" },
      ],
    });
    expect(summary.state).toBe("failure");
    expect(summary.total).toBe(5);
    expect(summary.failed).toBe(3);
    expect(summary.pending).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.checks.find((check) => check.name === "ci")?.conclusion).toBe("warning");
    expect(summary.checks.find((check) => check.name === "deploy")?.status).toBe("pending");
  });

  it("maps a comparison and a commit", () => {
    expect(
      toForgeCompare({
        total_commits: 2,
        files: [
          { filename: "src/a.ts", status: "modified" },
          { filename: "src/b.ts", previous_filename: "src/old-b.ts", status: "renamed" },
        ],
      }),
    ).toEqual({
      behind: 2,
      files: ["src/a.ts", "src/b.ts", "src/old-b.ts"],
      complete: true,
    });
    expect(
      toForgeCommit({
        sha: "abc",
        message: "Fix",
        tree: { sha: "tree" },
        parents: [{ sha: "parent" }],
      }),
    ).toEqual({ sha: "abc", message: "Fix", treeSha: "tree", parents: ["parent"] });
  });
});

describe("Forgejo diff parsing", () => {
  it("splits a diff into per-file patches with status and counts", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "+new",
      "+extra",
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 100%",
      "rename from old name.txt",
      "rename to new name.txt",
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "Binary files /dev/null and b/logo.png differ",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["src/a.ts", "modified", 2, 1],
      ["new name.txt", "renamed", 0, 0],
      ["logo.png", "added", 0, 0],
    ]);
    expect(files[1]?.previousPath).toBe("old name.txt");
    expect(files[0]?.patch).toContain("@@ -1,2 +1,3 @@");
    expect(files[2]?.patch).toContain("Binary files");
  });

  it("decodes a quoted path with an octal UTF-8 byte", () => {
    const diff = [
      'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
      '--- "a/caf\\303\\251.txt"',
      '+++ "b/caf\\303\\251.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]?.path).toBe("café.txt");
  });

  it("returns nothing for text with no diff headers", () => {
    expect(parseUnifiedDiff("not a diff")).toEqual([]);
  });
});

describe("Forgejo review decision", () => {
  const review = (over: Partial<Parameters<typeof toForgeReview>[0]> = {}) =>
    toForgeReview({
      id: 1,
      user: { login: "lee" },
      state: "APPROVED",
      official: true,
      ...over,
    });

  it("counts official approvals against branch protection", () => {
    expect(reviewDecisionFor([], 0)).toBe("none");
    expect(reviewDecisionFor([], 1)).toBe("review_required");
    expect(reviewDecisionFor([review()], 1)).toBe("approved");
    expect(reviewDecisionFor([review({ official: false })], 1)).toBe("review_required");
    expect(
      reviewDecisionFor([review({ id: 1 }), review({ id: 2, user: { login: "sam" } })], 2),
    ).toBe("approved");
  });

  it("fails closed when the requirement cannot be read", () => {
    expect(reviewDecisionFor([], null)).toBe("none");
    expect(reviewDecisionFor([review()], null)).toBe("review_required");
  });

  it("takes only official, non-stale and non-dismissed reviews into account", () => {
    expect(reviewDecisionFor([review({ stale: true })], 1)).toBe("review_required");
    expect(reviewDecisionFor([review({ dismissed: true })], 1)).toBe("review_required");
    expect(reviewDecisionFor([review({ state: "REQUEST_CHANGES", body: "no" })], 0)).toBe(
      "changes_requested",
    );
    // A later comment by the same author keeps the approval.
    expect(reviewDecisionFor([review(), review({ id: 2, state: "COMMENT" })], 1)).toBe("approved");
    // A later approval replaces the author's earlier request for changes.
    expect(
      reviewDecisionFor(
        [review({ id: 1, state: "REQUEST_CHANGES" }), review({ id: 2, state: "APPROVED" })],
        1,
      ),
    ).toBe("approved");
  });
});
