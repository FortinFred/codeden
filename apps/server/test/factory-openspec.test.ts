import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FactoryAnalysisReport,
  OPENSPEC_CHANGE_EXISTS,
  OPENSPEC_CHANGE_ROOT_UNSAFE,
  OPENSPEC_NOT_WORK_SOURCE,
  openSpecChangeId,
  type Project,
} from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * An OpenSpec work source (§10.1): the project's `openspec/changes/` folders are the factory's
 * work, with their proposal, design, spec and tasks in the pull request; GitHub issues are not
 * taken in, and pull requests, CI and merge still run on GitHub.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const s = factorySteps(() => env);

/** Write a change folder with its proposal. */
function change(id: string, contents: string): void {
  const dir = join(env.project.path, "openspec", "changes", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "proposal.md"), contents);
}

const items = () => env.factory.data.items(env.project.id);
const changeItem = (id: string) => items().find((i) => i.openspecChange?.id === id);
const startFor = (id: string) => env.starts.find((start) => start.workKey === `openspec:${id}`);

/** The error a call refused with (the service throws synchronously). */
function refusal(run: () => unknown): { status?: number; code?: string } {
  try {
    run();
  } catch (error) {
    return error as { status?: number; code?: string };
  }
  throw new Error("Expected the call to be refused");
}

describe("an OpenSpec work source (#21)", () => {
  it("takes each change folder as a feature item, with no issue", async () => {
    env = createFactoryEnv();
    change("add-login", "# Add login\n\nUsers need to sign in.\n");
    change("add-search", "---\ntitle: search\n---\n\n# Add search\n\nSearch the docs.\n");
    mkdirSync(join(env.project.path, "openspec", "changes", "empty"), { recursive: true });
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    await s.tick();

    // No issue is created or taken in.
    expect(env.gh.issues).toEqual([]);
    expect(items()).toHaveLength(2);
    expect(changeItem("empty")).toBeUndefined();
    expect(changeItem("add-login")).toMatchObject({
      source: "openspec",
      type: "feature",
      workKey: "openspec:add-login",
      title: "Add login",
      summary: "Users need to sign in.",
      trust: "trusted",
      issue: null,
      openspecChange: { id: "add-login", path: "openspec/changes/add-login" },
    });
    // A heading after a frontmatter block is the title too.
    expect(changeItem("add-search")).toMatchObject({
      title: "Add search",
      summary: "Search the docs.",
    });

    const brief = startFor("add-login")?.input?.text ?? "";
    expect(brief).toContain("OpenSpec change `add-login`");
    expect(brief).toContain("openspec/changes/add-login");
    expect(brief).toContain("Users need to sign in.");
    expect(brief).toContain("design.md");
    expect(brief).toContain("tasks.md");
    expect(brief).toContain("don't add `Fixes #N`");
    expect(env.starts.every((start) => start.issue == null)).toBe(true);

    const status = await env.factory.status(env.project.id);
    const inFlight = status.inProgress.find((w) => w.openspecChange?.id === "add-login");
    expect(inFlight?.openspecChange).toEqual({
      id: "add-login",
      path: "openspec/changes/add-login",
    });
  });

  it("replaces GitHub intake, and the GitHub work source is unchanged", async () => {
    env = createFactoryEnv();
    change("add-login", "# Add login\n\nUsers need to sign in.\n");
    env.gh.openIssue({
      projectId: env.project.id,
      title: "Add a counter",
      author: "codeden",
      labels: ["enhancement"],
    });
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    await s.tick();
    // Only the change is work; the open issue is left alone.
    expect(items().map((i) => i.workKey)).toEqual(["openspec:add-login"]);
    expect(env.gh.issues).toHaveLength(1);

    await env.close();
    env = createFactoryEnv();
    env.gh.openIssue({
      projectId: env.project.id,
      title: "Add a counter",
      author: "codeden",
      labels: ["enhancement"],
    });
    await s.enable();
    await s.tick();
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ source: "issue", openspecChange: null });
    expect(items()[0]?.workKey).toMatch(/^issue:\d+$/);
  });

  it("skips what it cannot read, and a removed change does not fail its item", async () => {
    env = createFactoryEnv();
    change("add-login", "# Add login\n\nUsers need to sign in.\n");
    mkdirSync(join(env.project.path, "openspec", "changes", "no-proposal"), { recursive: true });
    // A proposal.md that is a folder, not a file.
    mkdirSync(join(env.project.path, "openspec", "changes", "odd", "proposal.md"), {
      recursive: true,
    });
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    await s.tick();
    expect(items().map((i) => i.workKey)).toEqual(["openspec:add-login"]);

    rmSync(join(env.project.path, "openspec", "changes", "add-login"), { recursive: true });
    await s.tick();
    expect(items()).toHaveLength(1);
    expect(changeItem("add-login")?.stage).not.toBe("rejected");
  });

  it("does not take in changes from a symlinked changes folder", async () => {
    env = createFactoryEnv();
    const outside = mkdtempSync(join(tmpdir(), "codeden-openspec-outside-"));
    mkdirSync(join(outside, "add-login"));
    writeFileSync(
      join(outside, "add-login", "proposal.md"),
      "# Add login\n\nOutside the project.\n",
    );
    mkdirSync(join(env.project.path, "openspec"), { recursive: true });
    symlinkSync(outside, join(env.project.path, "openspec", "changes"), "dir");
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    await s.tick();

    expect(items()).toEqual([]);
    expect(env.starts).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("keeps working when the project path is itself a symlink", async () => {
    env = createFactoryEnv();
    const link = join(mkdtempSync(join(tmpdir(), "codeden-project-link-")), "project");
    symlinkSync(env.project.path, link, "dir");
    const linked = env.updateProject({ path: link });
    change("add-login", "# Add login\n\nUsers need to sign in.\n");
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    await s.tick();

    expect(items().map((i) => i.workKey)).toEqual(["openspec:add-login"]);
    const created = env.factory.createOpenSpecChange(linked.id, { title: "Add search", body: "" });
    expect(created.change.id).toBe("add-search");
    expect(
      existsSync(join(env.project.path, "openspec", "changes", "add-search", "proposal.md")),
    ).toBe(true);
    rmSync(join(link, ".."), { recursive: true, force: true });
  });

  it("reviews and merges an OpenSpec item with no issue", async () => {
    env = createFactoryEnv();
    change("add-login", "# Add login\n\nUsers need to sign in.\n");
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    await s.tick();
    const id = changeItem("add-login")?.id as string;
    const builder = s.item(id).builderSessionId as string;
    await env.factory.submitAnalysis(env.repo.get(builder), {
      decision: "implement",
      summary: "No sign-in yet",
      spec: "A sign-in page",
      acceptanceCriteria: ["Signing in works"],
    });
    await env.setStatus(builder, "idle");
    const { pr } = await s.openPr(id);
    await s.tick();
    expect(s.item(id).stage).toBe("verifying");
    expect(s.item(id).reviewerSessionId).toBeTruthy();
    await s.review(id, {
      verdict: "approve",
      summary: "Meets the criteria",
      criteria: [{ criterion: "Signing in works", met: true }],
      vision: { aligned: true },
      tests: { adequate: true },
      security: { concerns: [] },
    });
    await s.tick();
    expect(env.gh.merges.map((merge) => merge.number)).toContain(pr.ref.number);
    await s.tick();
    expect(s.item(id).stage).toBe("merged");
  });

  it("approves a spec with no issue, without commenting on GitHub", async () => {
    env = createFactoryEnv();
    change("add-login", "# Add login\n\nUsers need to sign in.\n");
    await s.enable("software_factory", {
      tuning: { workSource: "openspec", specApproval: true },
    });
    await s.tick();
    const item = changeItem("add-login");
    const builder = env.repo.get(item?.builderSessionId as string);
    const report: FactoryAnalysisReport = {
      decision: "implement",
      summary: "No sign-in yet",
      spec: "A sign-in page and a session cookie",
      acceptanceCriteria: ["Signing in works"],
    };
    expect((await env.factory.submitAnalysis(builder, report)).recorded).toBe(true);
    expect(changeItem("add-login")?.specApproval).toMatchObject({ state: "pending" });
    // The factory's comment paths no-op without an issue.
    expect(env.gh.comments).toEqual([]);
  });
});

describe("creating an OpenSpec change from the app (#33)", () => {
  it("writes the proposal, and the next tick takes it in", async () => {
    env = createFactoryEnv();
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    const created = env.factory.createOpenSpecChange(env.project.id, {
      title: "  Add gift cards  ",
      body: "Shoppers want to pay with a gift card.\n",
    });
    expect(created.change).toEqual({
      id: "add-gift-cards",
      path: "openspec/changes/add-gift-cards",
    });
    expect(created.message).toContain("next factory check");
    const file = join(env.project.path, "openspec", "changes", "add-gift-cards", "proposal.md");
    expect(readFileSync(file, "utf8")).toBe(
      "# Add gift cards\n\nShoppers want to pay with a gift card.\n",
    );

    await s.tick();
    expect(changeItem("add-gift-cards")).toMatchObject({
      source: "openspec",
      type: "feature",
      title: "Add gift cards",
      summary: "Shoppers want to pay with a gift card.",
      workKey: "openspec:add-gift-cards",
    });
  });

  it("derives a folder id that can never leave openspec/changes/", () => {
    expect(openSpecChangeId("../../Café / Passwörd!")).toBe("cafe-password");
    expect(openSpecChangeId("!!!")).toBe("change");
    expect(openSpecChangeId("x".repeat(300))).toHaveLength(100);
    expect(openSpecChangeId("Add gift cards")).not.toMatch(/[./]/);
  });

  it("prefixes a Windows device name, which cannot be a folder there", () => {
    expect(openSpecChangeId("CON")).toBe("change-con");
    expect(openSpecChangeId("lpt9")).toBe("change-lpt9");
    expect(openSpecChangeId("console")).toBe("console");
  });

  it("refuses an existing folder rather than overwrite it", async () => {
    env = createFactoryEnv();
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });
    change("add-login", "# Add login\n\nKeep me.\n");
    expect(
      refusal(() =>
        env.factory.createOpenSpecChange(env.project.id, {
          title: "Add login",
          body: "Something else",
        }),
      ),
    ).toMatchObject({ status: 409, code: OPENSPEC_CHANGE_EXISTS });
    expect(
      readFileSync(
        join(env.project.path, "openspec", "changes", "add-login", "proposal.md"),
        "utf8",
      ),
    ).toBe("# Add login\n\nKeep me.\n");
  });

  it("refuses a symlinked changes folder, and leaves its target untouched", async () => {
    env = createFactoryEnv();
    const outside = mkdtempSync(join(tmpdir(), "codeden-openspec-outside-"));
    mkdirSync(join(env.project.path, "openspec"), { recursive: true });
    symlinkSync(outside, join(env.project.path, "openspec", "changes"), "dir");
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });

    expect(
      refusal(() =>
        env.factory.createOpenSpecChange(env.project.id, { title: "Add login", body: "Sign in." }),
      ),
    ).toMatchObject({ status: 409, code: OPENSPEC_CHANGE_ROOT_UNSAFE });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked change folder, and leaves its target untouched", async () => {
    env = createFactoryEnv();
    const outside = mkdtempSync(join(tmpdir(), "codeden-openspec-outside-"));
    mkdirSync(join(env.project.path, "openspec", "changes"), { recursive: true });
    symlinkSync(outside, join(env.project.path, "openspec", "changes", "add-login"), "dir");
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });

    expect(
      refusal(() =>
        env.factory.createOpenSpecChange(env.project.id, { title: "Add login", body: "Sign in." }),
      ),
    ).toMatchObject({ status: 409, code: OPENSPEC_CHANGE_ROOT_UNSAFE });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a symlinked openspec folder, and leaves its target untouched", async () => {
    env = createFactoryEnv();
    const outside = mkdtempSync(join(tmpdir(), "codeden-openspec-outside-"));
    symlinkSync(outside, join(env.project.path, "openspec"), "dir");
    await s.enable("software_factory", { tuning: { workSource: "openspec" } });

    expect(
      refusal(() =>
        env.factory.createOpenSpecChange(env.project.id, { title: "Add login", body: "Sign in." }),
      ),
    ).toMatchObject({ status: 409, code: OPENSPEC_CHANGE_ROOT_UNSAFE });
    expect(readdirSync(outside)).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("needs the OpenSpec work source, so a change is never written where nothing reads it", async () => {
    env = createFactoryEnv();
    await s.enable();
    expect(
      refusal(() =>
        env.factory.createOpenSpecChange(env.project.id, { title: "Add login", body: "" }),
      ),
    ).toMatchObject({ status: 409, code: OPENSPEC_NOT_WORK_SOURCE });
    expect(existsSync(join(env.project.path, "openspec"))).toBe(false);
  });
});

/**
 * Pull requests, CI and merge still run on GitHub, so an OpenSpec work source on a local project
 * could never finish a change. The rule is refused at both doors (the mode switch and New
 * change), before anything is written.
 */
describe("the OpenSpec work source needs a GitHub project (#75)", () => {
  /** The error a call refused with, whether it throws now or rejects. */
  async function rejectionOf(run: () => unknown): Promise<{ status?: number; code?: string }> {
    try {
      await run();
    } catch (error) {
      return error as { status?: number; code?: string };
    }
    throw new Error("Expected the call to be refused");
  }

  // A local project carries no GitHub repo; the factory only reads the kind.
  const localProject = () => env.updateProject({ kind: "local" } as Partial<Project>);

  it("refuses the work source when a person switches a local project to it", async () => {
    env = createFactoryEnv();
    const local = localProject();
    expect(
      await rejectionOf(() =>
        env.factory.setMode(local.id, {
          mode: "software_factory",
          limits: local.factoryLimits,
          tuning: { workSource: "openspec", minBacklog: 0 },
        } as Parameters<FactoryEnv["factory"]["setMode"]>[1]),
      ),
    ).toMatchObject({ status: 400, code: "openspec_needs_github" });
    expect(env.factory.data.loopOrNew(local.id, env.now()).tuning.workSource).not.toBe("openspec");
    expect(existsSync(join(env.project.path, "openspec"))).toBe(false);
  });

  it("still switches a GitHub project to the OpenSpec work source", async () => {
    env = createFactoryEnv();
    await env.factory.setMode(env.project.id, {
      mode: "software_factory",
      limits: env.project.factoryLimits,
      tuning: { workSource: "openspec", minBacklog: 0 },
    } as Parameters<FactoryEnv["factory"]["setMode"]>[1]);
    expect(env.factory.data.loopOrNew(env.project.id, env.now()).tuning.workSource).toBe(
      "openspec",
    );
  });

  it("refuses a New change on a local project", async () => {
    env = createFactoryEnv();
    const local = localProject();
    expect(
      await rejectionOf(() =>
        env.factory.createOpenSpecChange(local.id, { title: "Add login", body: "Sign in." }),
      ),
    ).toMatchObject({ status: 400, code: "openspec_needs_github" });
    expect(existsSync(join(env.project.path, "openspec"))).toBe(false);
  });
});
