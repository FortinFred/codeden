import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryItem, Project } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { parseProposal, readOpenSpecChanges } from "../src/services/factory/openspec";
import { builderPrompt } from "../src/services/factory/prompts";

/** Reading an OpenSpec change's proposal for the factory (§10.1). */

describe("OpenSpec change root", () => {
  it("reads a real changes folder, and reports a symlinked one instead of following it", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeden-openspec-"));
    const project = { path: join(dir, "project") } as Project;
    const inside = join(project.path, "openspec", "changes", "add-login");
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(inside, "proposal.md"), "# Add login\n\nInside the project.\n");
    expect(readOpenSpecChanges(project).map((change) => change.ref.id)).toEqual(["add-login"]);

    const outside = join(dir, "outside");
    mkdirSync(join(outside, "add-other"), { recursive: true });
    writeFileSync(join(outside, "add-other", "proposal.md"), "# Add other\n\nOutside.\n");
    rmSync(join(project.path, "openspec", "changes"), { recursive: true });
    symlinkSync(outside, join(project.path, "openspec", "changes"), "dir");

    const log: string[] = [];
    expect(readOpenSpecChanges(project, (message) => log.push(message))).toEqual([]);
    expect(log.join("\n")).toMatch(/openspec\/changes` is a symbolic link/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("OpenSpec proposals", () => {
  it("takes the first heading as the title, after any frontmatter", () => {
    expect(
      parseProposal(
        "add-login",
        "---\ntitle: hidden\n---\n\n# Add login\r\n\r\nUsers sign in.\r\n",
      ),
    ).toEqual({ title: "Add login", body: "Users sign in." });
  });

  it("uses the folder id when the proposal has no heading", () => {
    expect(parseProposal("add-login", "Users sign in.\n")).toEqual({
      title: "add-login",
      body: "Users sign in.",
    });
  });
});

/**
 * An OpenSpec change read from the main checkout may be uncommitted, so it isn't in the builder's
 * worktree. The brief must say what to do then, not promise the proposal is already there.
 */
describe("OpenSpec builder brief", () => {
  const item = {
    id: "item-1",
    projectId: "project-1",
    workKey: "openspec:add-login",
    title: "Add login",
    summary: "Users sign in with an email and a password.",
    source: "openspec",
    area: null,
    acceptanceCriteria: [],
    score: null,
    stage: "building",
    type: "feature",
    classification: null,
    trust: "trusted",
    author: null,
    admittedBy: null,
    investigation: null,
    specApproval: null,
    issue: null,
    openspecChange: { id: "add-login", path: "openspec/changes/add-login" },
    pr: null,
    builderSessionId: null,
    builderProvider: null,
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    review: null,
    lessonsNote: null,
    followUps: [],
    spotCheck: null,
    checks: [],
    attempts: 0,
    reason: null,
    stop: null,
    failureKind: null,
    rebuiltFrom: null,
    note: null,
    mergeSha: null,
    mergePath: null,
    revertOf: null,
    triageRequestedAt: null,
    nudges: {},
    largeChange: null,
    sessionsArchivedAt: null,
    earlierSessionIds: [],
    sessionIds: [],
    itemBudgetSince: null,
    stepSince: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    mergedAt: null,
    finishedAt: null,
  } as unknown as FactoryItem;

  it("tells the builder to write a missing proposal from the title and the request", () => {
    const brief = builderPrompt(item, "");
    expect(brief).toMatch(/if `openspec\/changes\/add-login\/proposal\.md` (isn't|is not) there/i);
    expect(brief).toMatch(/create it from the item's title/);
    expect(brief).toMatch(/and the request text/);
    expect(brief).not.toContain("`proposal.md` is the request (already there).");
  });

  it("keeps the proposal when the worktree already has it", () => {
    const brief = builderPrompt(item, "");
    expect(brief).toMatch(/if it is there, keep it/i);
  });

  it("leaves a GitHub issue's brief without the OpenSpec plan block", () => {
    const issueItem = {
      ...item,
      workKey: "issue:31",
      source: "issue",
      openspecChange: null,
      issue: { number: 31, url: "https://github.com/owner/repo/issues/31" },
    } as FactoryItem;
    const brief = builderPrompt(issueItem, "");
    expect(brief).not.toContain("<openspec-change");
    expect(brief).not.toContain("create it from the item's title");
  });
});
