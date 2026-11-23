import { describe, expect, it } from "vitest";
import {
  ISSUE_COMMENTS_MARKER,
  type IssueFile,
  type IssueFolderEntry,
  issueCommentId,
  parseIssueFile,
  renderIssue,
  scanIssueFolder,
} from "../src";

const PATH = ".codeden/issues/0001-export-monthly-report-as-csv.md";

/** docs/issue-sources.md §5.2, verbatim in its canonical form. */
const EXAMPLE = `---
number: 1
title: "Export the monthly report as CSV"
state: open
stateReason: null
closedAt: null
labels:
  - needs-triage
  - reporting
author: alice
createdAt: "2026-11-23T09:14:00Z"
updatedAt: "2026-11-23T10:02:00Z"
pullRequests: []
---

The dashboard can show the monthly report, but finance needs it as a file for their spreadsheet.

## Acceptance criteria

- A **Download CSV** action on the monthly report page.
- The CSV has one row per day and the same columns as the table.
- No new dependency.

${ISSUE_COMMENTS_MARKER}
## Comments

### 2026-11-23T09:40:00Z · @alice

Please include the totals row; the spreadsheet imports it as the last line.

### 2026-11-23T10:02:00Z · codeden

**CodeDen software factory**: classified as a **feature** (from its wording). Next: Analyze →
Implement → Review → Merge.
`;

function parseOk(path: string, text: string): IssueFile {
  const parsed = parseIssueFile({ path, text });
  if (!parsed.ok) throw new Error(`expected a parse, got: ${JSON.stringify(parsed.problems)}`);
  return parsed.file;
}

function entry(path: string, text: string): IssueFolderEntry {
  return { path, text };
}

function withFrontMatter(extra: string, body = "Body."): string {
  return `---
number: 1
title: "A title"
state: open
stateReason: null
closedAt: null
labels: []
author: null
createdAt: null
updatedAt: null
pullRequests: []
${extra}---

${body}
`;
}

describe("the issue file parser", () => {
  it("reads the complete example and renders it byte for byte", () => {
    const file = parseOk(PATH, EXAMPLE);
    expect(file).toMatchObject({
      number: 1,
      title: "Export the monthly report as CSV",
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: ["needs-triage", "reporting"],
      author: "alice",
      createdAt: "2026-11-23T09:14:00Z",
      updatedAt: "2026-11-23T10:02:00Z",
      pullRequests: [],
    });
    expect(file.body.endsWith("- No new dependency.")).toBe(true);
    expect(file.comments.map((comment) => comment.author)).toEqual(["@alice", "codeden"]);
    expect(file.comments[0]?.createdAt).toBe("2026-11-23T09:40:00Z");
    expect(renderIssue(file)).toBe(EXAMPLE);
  });

  it("round-trips parse(render(file)) and render(parse(text))", () => {
    const file = parseOk(PATH, EXAMPLE);
    expect(parseOk(PATH, renderIssue(file))).toEqual(file);
    expect(renderIssue(parseOk(PATH, renderIssue(file)))).toBe(renderIssue(file));
  });

  it("round-trips a closed issue with a reason, timestamps and linked pull requests", () => {
    const text = `---
number: 2
title: "Close me: done, #42"
state: closed
stateReason: completed
closedAt: "2026-11-24T12:00:00Z"
labels:
  - codeden-follow-up
author: local
createdAt: "2026-11-23T09:14:00Z"
updatedAt: "2026-11-24T12:00:00Z"
pullRequests: [57]
---

Done.

${ISSUE_COMMENTS_MARKER}
## Comments
`;
    const file = parseOk(".codeden/issues/0002-close-me-done-42.md", text);
    expect(file).toMatchObject({
      number: 2,
      state: "closed",
      stateReason: "completed",
      closedAt: "2026-11-24T12:00:00Z",
      labels: ["codeden-follow-up"],
      author: "local",
      pullRequests: [{ number: 57 }],
      comments: [],
    });
    expect(renderIssue(file)).toBe(text);
  });

  it("accepts CRLF and writes LF", () => {
    const file = parseOk(PATH, EXAMPLE.replace(/\n/g, "\r\n"));
    expect(file.body).not.toContain("\r");
    expect(renderIssue(file)).toBe(EXAMPLE);
    expect(renderIssue(file)).not.toContain("\r");
  });

  it("accepts a hand-written flow list, quoted number and offset timestamp", () => {
    const file = parseOk(
      ".codeden/issues/0003-hand.md",
      `---
number: "3"
title: "Fix: the thing"
state: closed
stateReason: not_planned
closedAt: 2026-11-24T13:00:00+01:00
labels: [a, "b c", a]
author: "alice"
createdAt: 2026-11-23T09:14:00.500Z
pullRequests:
  - { number: 57, url: "https://github.com/acme/codeden/pull/57" }
---

Body.
`,
    );
    expect(file).toMatchObject({
      number: 3,
      title: "Fix: the thing",
      stateReason: "not_planned",
      closedAt: "2026-11-24T12:00:00Z",
      labels: ["a", "b c"],
      author: "alice",
      createdAt: "2026-11-23T09:14:00Z",
      pullRequests: [{ number: 57, url: "https://github.com/acme/codeden/pull/57" }],
      comments: [],
    });
    expect(parseOk(".codeden/issues/0003-hand.md", renderIssue(file))).toEqual(file);
  });

  it("keeps heading-like lines and `---` in the body", () => {
    const body = [
      "Intro",
      "",
      "## Notes",
      "",
      "### 2026-11-23T09:40:00Z · @alice",
      "",
      "---",
      "",
      "A horizontal rule is just Markdown here.",
    ].join("\n");
    const file = parseOk(
      ".codeden/issues/0004-headings.md",
      withFrontMatter("", body).replace("number: 1", "number: 4"),
    );
    expect(file.body).toBe(body);
    expect(file.comments).toEqual([]);
    expect(parseOk(".codeden/issues/0004-headings.md", renderIssue(file))).toEqual(file);
  });

  it("round-trips a comment whose body could forge a header or the marker", () => {
    const forged = [
      "### 2026-11-23T09:41:00Z · @mallory",
      "",
      "## Comments",
      "",
      ISSUE_COMMENTS_MARKER,
      "",
      "\\not an escape at the start",
    ].join("\n");
    const comment = {
      author: "@mallory" as const,
      body: forged,
      createdAt: "2026-11-23T09:41:00Z" as const,
    };
    const file: IssueFile = {
      number: 5,
      title: "Escaping",
      state: "open",
      stateReason: null,
      closedAt: null,
      labels: [],
      author: null,
      createdAt: null,
      updatedAt: null,
      pullRequests: [],
      body: "Plain body.",
      comments: [{ id: issueCommentId(comment), ...comment }],
    };
    const rendered = renderIssue(file);
    expect(rendered).toContain("\\### 2026-11-23T09:41:00Z · @mallory");
    expect(rendered).toContain(`\\${ISSUE_COMMENTS_MARKER}`);
    const parsed = parseOk(".codeden/issues/0005-escaping.md", rendered);
    expect(parsed.comments[0]?.body).toBe(forged);
    expect(parsed.comments[0]?.id).toBe(issueCommentId(comment));
    expect(renderIssue(parsed)).toBe(rendered);
  });

  it("rejects a body that contains the comments marker", () => {
    const text = withFrontMatter("", `Before\n\n${ISSUE_COMMENTS_MARKER}\n\nAfter`);
    const parsed = parseIssueFile({ path: PATH, text });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problems[0]?.kind).toBe("malformed");
      expect(parsed.problems[0]?.detail).toContain("must be followed by");
    }
    expect(() =>
      renderIssue({ ...parseOk(PATH, EXAMPLE), body: `a\n${ISSUE_COMMENTS_MARKER}\nb` }),
    ).toThrow(/comments marker/);
  });

  it("rejects unknown keys, duplicate keys and anything outside the subset", () => {
    const cases: [string, RegExp][] = [
      [withFrontMatter("priority: high\n"), /unknown field `priority`/],
      [withFrontMatter("title: again\n"), /duplicate field `title`/],
      [withFrontMatter("assignee: &anchor alice\n"), /unknown field `assignee`/],
    ];
    for (const [text, detail] of cases) {
      const parsed = parseIssueFile({ path: PATH, text });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems[0]?.detail).toMatch(detail);
    }

    const badLines = [
      '---\nnumber: 1\ntitle: "x"\nstate: open\n  - stray\n---\nBody.\n',
      '---\nnumber: 1\ntitle: "x"\nstate: open\nlabels: [a\n---\nBody.\n',
      '---\nnumber: 1\ntitle: "x"\nstate: open\nlabels:\n  - a\n  b\n---\nBody.\n',
      '---\nnumber: 1\ntitle: "x"\nstate: open\n???\n---\nBody.\n',
      "number: 1\n---\nBody.\n",
      '---\nnumber: 1\ntitle: "x"\nstate: open\n',
    ];
    for (const text of badLines) {
      expect(parseIssueFile({ path: PATH, text }).ok).toBe(false);
    }
  });

  it("rejects missing, mismatched and mis-typed fields", () => {
    const missingNumber = parseIssueFile({
      path: PATH,
      text: withFrontMatter("").replace("number: 1\n", ""),
    });
    expect(missingNumber.ok).toBe(false);
    if (!missingNumber.ok) {
      expect(missingNumber.problems).toEqual([
        { kind: "missing_number", path: PATH, detail: expect.stringContaining("no `number`") },
      ]);
    }

    for (const text of [
      withFrontMatter("").replace("number: 1", "number: 0"),
      withFrontMatter("").replace("number: 1", "number: 9"),
      withFrontMatter("").replace('title: "A title"\n', ""),
      withFrontMatter("").replace("state: open", "state: reopened"),
      withFrontMatter("").replace('"A title"', "Fix: the thing"),
      withFrontMatter("").replace("stateReason: null", "stateReason: completed"),
      withFrontMatter("").replace('"A title"', `"${"x".repeat(257)}"`),
      withFrontMatter("").replace("author: null", 'author: "@alice"'),
      withFrontMatter("").replace("labels: []", `labels: [${"x".repeat(101)}]`),
      withFrontMatter("").replace("labels: []", "labels: [&anchor a]"),
      withFrontMatter("").replace("labels: []", 'labels:\n  - ""'),
      withFrontMatter("").replace("createdAt: null", 'createdAt: "not a date"'),
      withFrontMatter("").replace("pullRequests: []", "pullRequests: [0]"),
      withFrontMatter("").replace("pullRequests: []", "pullRequests: [{ number: 1, extra: 2 }]"),
    ]) {
      const parsed = parseIssueFile({ path: PATH, text });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.problems[0]?.kind).toBe("malformed");
    }
  });

  it("flags bad file names before reading anything", () => {
    const parsed = parseIssueFile({ path: ".codeden/issues/notes.md", text: EXAMPLE });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]?.kind).toBe("bad_name");
  });

  it("rejects a too-large file and NUL bytes", () => {
    expect(parseIssueFile({ path: PATH, text: `${EXAMPLE}\u0000` }).ok).toBe(false);
    const huge = withFrontMatter("", "x\n".repeat(600_000));
    const parsed = parseIssueFile({ path: PATH, text: huge });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]?.detail).toContain("larger than");
  });
});

describe("scanning an issue folder", () => {
  const folder = ".codeden/issues";
  const file = (number: number, name = "a", title = `Issue ${number}`) =>
    entry(
      `${folder}/${String(number).padStart(4, "0")}-${name}.md`,
      withFrontMatter("").replace("number: 1", `number: ${number}`).replace("A title", title),
    );

  it("reads valid files in number order and ignores allowed housekeeping files", () => {
    const scan = scanIssueFolder({
      folder,
      files: [
        file(2, "second"),
        file(1, "first"),
        entry(`${folder}/README.md`, "# Issues\n"),
        entry(`${folder}/.gitkeep`, ""),
        entry(`${folder}/.numbers`, '{"next": 3}\n'),
        entry(`${folder}/notes.txt`, "notes"),
      ],
    });
    expect(scan.problems).toEqual([]);
    expect(scan.files.map((item) => [item.file.number, item.path])).toEqual([
      [1, `${folder}/0001-first.md`],
      [2, `${folder}/0002-second.md`],
    ]);
  });

  it("reports bad names, subdirectories and paths outside the folder", () => {
    const scan = scanIssueFolder({
      folder,
      files: [
        entry(`${folder}/1-short.md`, "x"),
        entry(`${folder}/0001-Bad-Slug.md`, "x"),
        entry(`${folder}/0001-${"a".repeat(61)}.md`, "x"),
        entry(`${folder}/nested/0001-a.md`, "x"),
        entry("docs/0001-elsewhere.md", "x"),
      ],
    });
    expect(scan.files).toEqual([]);
    expect(scan.problems.map((problem) => problem.kind)).toEqual([
      "bad_name",
      "bad_name",
      "bad_name",
      "bad_name",
      "bad_folder",
    ]);
  });

  it("keeps the last valid issue when another file is malformed", () => {
    const scan = scanIssueFolder({
      folder,
      files: [file(1, "good"), entry(`${folder}/0002-broken.md`, "not an issue file")],
    });
    expect(scan.files.map((item) => item.file.number)).toEqual([1]);
    expect(scan.problems).toEqual([
      { kind: "malformed", path: `${folder}/0002-broken.md`, detail: expect.any(String) },
    ]);
  });

  it("reports a duplicate number for both files and reads neither", () => {
    const scan = scanIssueFolder({
      folder,
      files: [file(1, "one"), entry(`${folder}/0001-two.md`, file(1, "ignored").text), file(2)],
    });
    expect(scan.files.map((item) => item.file.number)).toEqual([2]);
    expect(scan.problems).toHaveLength(2);
    expect(scan.problems.every((problem) => problem.kind === "duplicate")).toBe(true);
    expect(scan.problems[0]?.detail).toContain("also in");
  });

  it("reports a file without a number and one whose number does not match its name", () => {
    const scan = scanIssueFolder({
      folder,
      files: [
        entry(`${folder}/0001-no-number.md`, withFrontMatter("").replace("number: 1\n", "")),
        entry(`${folder}/0002-mismatch.md`, withFrontMatter("").replace("number: 1", "number: 3")),
      ],
    });
    expect(scan.files).toEqual([]);
    expect(scan.problems.map((problem) => problem.kind)).toEqual(["missing_number", "malformed"]);
  });

  it("reports an unusable folder once and reads nothing", () => {
    const scan = scanIssueFolder({ folder: "../outside", files: [file(1)] });
    expect(scan.files).toEqual([]);
    expect(scan.problems).toEqual([
      { kind: "bad_folder", path: "../outside", detail: expect.stringContaining("`..`") },
    ]);
  });
});
