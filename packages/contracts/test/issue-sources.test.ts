import { describe, expect, it } from "vitest";
import {
  DEFAULT_ISSUE_FOLDER,
  IssueFileProblem,
  IssueSourceSettings,
  IssueSourceStatus,
  isIssueProject,
  issueCommentAnchor,
  issueCommentId,
  issueFileName,
  issueFolderOf,
  issueFolderProblem,
  issueSlug,
  issueSourceOf,
  nextIssueNumber,
  normalizeIssueFolder,
  normalizeIssueTimestamp,
  Project,
  parseIssueFileName,
  parseIssueNumberLedger,
  renderIssueNumberLedger,
  resolveIssueFolderPath,
} from "../src";
import { sampleProject, ts } from "./fixtures";

function roundTrip<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return second;
}

const localPayload = (() => {
  const { github: _github, ...rest } = sampleProject as Extract<Project, { kind: "github" }>;
  return { ...rest, kind: "local" as const };
})();

const forgePayload = {
  ...localPayload,
  kind: "forge" as const,
  forge: {
    provider: "forgejo" as const,
    baseUrl: "https://forge.example.com",
    host: "forge.example.com",
    owner: "acme",
    repo: "widgets",
    remoteUrl: "git@forge.example.com:acme/widgets.git",
    defaultBranch: "main",
  },
};

const folderProject = Project.parse({
  ...localPayload,
  issues: { source: "folder", folder: ".codeden/issues" },
});

// docs/issue-sources.md §4.1–§4.4: issues can come from a folder, independently of the PR forge.
describe("a project's issue source", () => {
  it("defaults to the forge with the standard folder on payloads written before it existed", () => {
    const { issues: _issues, ...legacy } = sampleProject;
    for (const payload of [legacy, { ...legacy, kind: "local" as const }, forgePayload]) {
      expect(Project.parse(payload).issues).toEqual({
        source: "forge",
        folder: DEFAULT_ISSUE_FOLDER,
      });
    }
    expect(roundTrip(Project, sampleProject).issues).toEqual({
      source: "forge",
      folder: DEFAULT_ISSUE_FOLDER,
    });
  });

  it("round-trips a folder source and normalizes the folder", () => {
    expect(roundTrip(Project, folderProject).issues).toEqual({
      source: "folder",
      folder: ".codeden/issues",
    });
    expect(IssueSourceSettings.parse({ source: "folder", folder: "./docs/tickets/" })).toEqual({
      source: "folder",
      folder: "docs/tickets",
    });
  });

  it("refuses a folder that is not a plain path inside the repository", () => {
    for (const folder of [
      "",
      ".",
      "/etc/issues",
      "../issues",
      "docs/../../issues",
      "C:\\issues",
      "~/issues",
      "issues\u0000",
    ]) {
      expect(IssueSourceSettings.safeParse({ folder }).success).toBe(false);
    }
    expect(issueFolderProblem(".codeden/issues")).toBeNull();
    expect(issueFolderProblem("docs//tickets/")).toBeNull();
    expect(normalizeIssueFolder("docs//./tickets/")).toBe("docs/tickets");
    expect(resolveIssueFolderPath("/repo", ".codeden/issues")).toBe("/repo/.codeden/issues");
    expect(resolveIssueFolderPath("C:\\repo", ".codeden/issues")).toBe(
      "C:\\repo\\.codeden\\issues",
    );
    expect(resolveIssueFolderPath("/repo", "../issues")).toBeNull();
  });

  it("reads the source from the kind and the setting, never from the kind alone", () => {
    expect(issueSourceOf(sampleProject)).toBe("forge");
    expect(isIssueProject(sampleProject)).toBe(true);
    expect(issueFolderOf(sampleProject)).toBeNull();

    expect(issueSourceOf(Project.parse(forgePayload))).toBe("forge");

    const local = Project.parse(localPayload);
    expect(issueSourceOf(local)).toBe("none");
    expect(isIssueProject(local)).toBe(false);
    expect(issueFolderOf(local)).toBeNull();

    expect(issueSourceOf(folderProject)).toBe("folder");
    expect(isIssueProject(folderProject)).toBe(true);
    expect(issueFolderOf(folderProject)).toBe(".codeden/issues");

    const githubWithFiles = Project.parse({
      ...sampleProject,
      issues: { source: "folder", folder: ".codeden/issues" },
    });
    expect(issueSourceOf(githubWithFiles)).toBe("folder");
  });
});

// docs/issue-sources.md §5.8: RFC 3339 in UTC, second precision, on read and write.
describe("issue timestamps", () => {
  it("normalizes hand-written forms to UTC seconds", () => {
    expect(normalizeIssueTimestamp("2026-11-23T10:02:00Z")).toBe("2026-11-23T10:02:00Z");
    expect(normalizeIssueTimestamp("2026-11-23T10:02:00.987Z")).toBe("2026-11-23T10:02:00Z");
    expect(normalizeIssueTimestamp("2026-11-23T11:02:00+01:00")).toBe("2026-11-23T10:02:00Z");
    expect(normalizeIssueTimestamp("2026-11-23T05:02:00-05:00")).toBe("2026-11-23T10:02:00Z");
  });

  it("rejects what is not a real timestamp", () => {
    expect(normalizeIssueTimestamp("2026-02-30T10:00:00Z")).toBeNull();
    expect(normalizeIssueTimestamp("2026-11-23")).toBeNull();
    expect(normalizeIssueTimestamp("yesterday")).toBeNull();
    expect(normalizeIssueTimestamp("2026-11-23T10:02:00+24:00")).toBeNull();
  });
});

// docs/issue-sources.md §5.1 and §8.2: filename and slug rules.
describe("issue file names", () => {
  it("reads a number and slug only from a valid name", () => {
    expect(parseIssueFileName("0001-export-monthly-report-as-csv.md")).toEqual({
      number: 1,
      slug: "export-monthly-report-as-csv",
    });
    expect(parseIssueFileName("12345-a.md")).toEqual({ number: 12345, slug: "a" });
    for (const name of [
      "1-foo.md",
      "0001-Foo.md",
      "0001-foo.markdown",
      "0001-foo.MD",
      "0001--foo.md",
      "-0001-foo.md",
      "0001-foo bar.md",
      `0001-${"a".repeat(61)}.md`,
    ]) {
      expect(parseIssueFileName(name)).toBeNull();
    }
    expect(parseIssueFileName(`0001-${"a".repeat(60)}.md`)).not.toBeNull();
  });

  it("derives a lowercase slug and a padded filename from a title", () => {
    expect(issueSlug("Export the monthly report as CSV")).toBe("export-the-monthly-report-as-csv");
    expect(issueSlug("Café — déjà vu!")).toBe("cafe-deja-vu");
    expect(issueSlug("!!!")).toBe("issue");
    expect(issueSlug("a".repeat(80))).toBe("a".repeat(60));
    expect(issueFileName(42, "Export CSV")).toBe("0042-export-csv.md");
    expect(issueFileName(10000, "Export CSV")).toBe("10000-export-csv.md");
  });
});

// docs/issue-sources.md §5.5: the committed `.numbers` ledger and its never-reuse rule.
describe("the number ledger", () => {
  it("reads a ledger, a missing ledger and a malformed one", () => {
    expect(parseIssueNumberLedger(null)).toEqual({ ok: true, ledger: null });
    expect(parseIssueNumberLedger('{"next": 42}\n')).toEqual({ ok: true, ledger: { next: 42 } });
    for (const text of ['{"next": 0}', '{"next": 2, "reserved": true}', '{"next": "42"}', "{"]) {
      expect(parseIssueNumberLedger(text).ok).toBe(false);
    }
    expect(renderIssueNumberLedger({ next: 42 })).toBe('{\n  "next": 42\n}\n');
  });

  it("allocates max(ledger, files) + 1 and never goes down", () => {
    expect(nextIssueNumber({})).toBe(1);
    expect(nextIssueNumber({ ledgerNext: 42 })).toBe(42);
    expect(nextIssueNumber({ ledgerNext: 42, numbers: [7, 41] })).toBe(42);
    expect(nextIssueNumber({ ledgerNext: 3, numbers: [7] })).toBe(8);
    expect(nextIssueNumber({ numbers: [7, 9] })).toBe(10);
    // A number reserved by a create that never wrote its file stays reserved.
    expect(nextIssueNumber({ ledgerNext: 43, numbers: [1] })).toBe(43);
  });
});

// docs/issue-sources.md §5.4: comment ids come from immutable entry data, anchors from position.
describe("issue comments", () => {
  const comment = { createdAt: "2026-11-23T09:40:00Z", author: "@alice" as const, body: "Hello" };

  it("derives a stable 53-bit id from timestamp, author and body", () => {
    const id = issueCommentId(comment);
    expect(Number.isSafeInteger(id)).toBe(true);
    expect(id).toBe(issueCommentId({ ...comment }));
    expect(issueCommentId({ ...comment, body: "Other" })).not.toBe(id);
    expect(issueCommentId({ ...comment, author: "codeden" })).not.toBe(id);
    expect(issueCommentId({ ...comment, createdAt: "2026-11-23T09:41:00Z" })).not.toBe(id);
    expect(issueCommentAnchor(2)).toBe("#comment-2");
  });
});

describe("issue source operational state", () => {
  it("round-trips a problem of each kind", () => {
    for (const kind of [
      "bad_name",
      "malformed",
      "duplicate",
      "missing_number",
      "bad_folder",
    ] as const) {
      const problem = { kind, path: ".codeden/issues/0001-a.md", detail: "what is wrong" };
      expect(roundTrip(IssueFileProblem, problem)).toEqual(problem);
    }
    expect(IssueFileProblem.safeParse({ kind: "other", path: "x", detail: "y" }).success).toBe(
      false,
    );
  });

  it("round-trips a folder status and fills its operational defaults", () => {
    const status = {
      projectId: "p1",
      source: "folder" as const,
      folder: ".codeden/issues",
      writable: true,
      stale: false,
      problems: [
        { kind: "duplicate" as const, path: ".codeden/issues/0001-a.md", detail: "two files" },
      ],
      baselineAt: ts,
      lastSyncAt: ts,
      lastError: null,
    };
    expect(roundTrip(IssueSourceStatus, status)).toEqual(status);
    expect(
      IssueSourceStatus.parse({
        projectId: "p1",
        source: "none",
        folder: null,
        writable: false,
        lastError: null,
      }),
    ).toMatchObject({ stale: false, problems: [], baselineAt: null, lastSyncAt: null });
  });
});
