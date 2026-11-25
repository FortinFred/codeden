import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { needsYouItems } from "../src/services/factory/digest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #265: the Factory view's "Needs you" lane listed failed items whose issues were already
 * closed (a duplicate, or resolved by another PR). Closing an item's issue settles a failed item
 * that holds no open PR: it leaves "needs you" by itself, with the reason recorded.
 */

let env: FactoryEnv;
const { item, tick, enable, backlogItem, verifying, review, failed, keepConflicting, prEntry } =
  factorySteps(() => env);

/** Hold merges (the loop is paused) while work in flight keeps moving. */
function pause() {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
}

beforeEach(() => {
  env = createFactoryEnv();
});
afterEach(() => env.close());

/** A feature for a real (open) issue whose builder was stopped before it opened a PR. */
async function stoppedWithoutPr(title: string) {
  const issue = env.gh.openIssue({ projectId: env.project.id, title, author: "codeden" });
  const created = backlogItem(title, issue.number);
  await tick();
  const builder = item(created.id).builderSessionId as string;
  expect(builder).toBeTruthy();
  await env.setStatus(builder, "stopped");
  await tick();
  expect(item(created.id)).toMatchObject({
    stage: "failed",
    reason: "The builder session stopped without a pull request",
  });
  return { id: created.id, issue };
}

const viewRecent = async () =>
  (await env.factory.status(env.project.id)).viewRecent.map((w) => w.id);
const waiting = () => needsYouItems(env.factory.ctx, env.project.id).map((n) => n.item.id);

describe("closed issues settle their failed items (#265)", () => {
  it("moves a failed item out of needs you once its issue is closed", async () => {
    await enable();
    const { id, issue } = await stoppedWithoutPr("Duplicate of #232");
    expect(await viewRecent()).toContain(id);
    expect(waiting()).toEqual([id]);

    // Closed on GitHub as a duplicate.
    env.gh.closeIssue(issue.number, "duplicate");
    await tick();

    expect(item(id)).toMatchObject({
      stage: "rejected",
      reason: "The issue was closed on GitHub as a duplicate",
      failureKind: null,
    });
    expect(await viewRecent()).not.toContain(id);
    expect(waiting()).toEqual([]);
  });

  it("marks the work done when a merged pull request resolved the issue", async () => {
    await enable();
    const { id, issue } = await stoppedWithoutPr("Fix the counter");
    // Someone else's PR fixed it ("Fixes #n") and was merged; GitHub closed the issue.
    const other = env.gh.openPr({ sessionId: null, title: "Counter fix", files: ["src/a.ts"] });
    other.linkedIssues = [issue.number];
    other.ref = { ...other.ref, state: "merged" };
    env.gh.closeIssue(issue.number, "completed");
    await tick();

    expect(item(id)).toMatchObject({
      stage: "merged",
      reason: `The issue was closed on GitHub: resolved by #${other.ref.number}`,
      note: `Resolved by #${other.ref.number}`,
      pr: null,
    });
    expect(waiting()).toEqual([]);
  });

  it("settles as rejected when the issue was closed as completed without a pull request", async () => {
    await enable();
    const { id, issue } = await stoppedWithoutPr("Already works");
    env.gh.closeIssue(issue.number, "completed");
    await tick();
    expect(item(id)).toMatchObject({
      stage: "rejected",
      reason: "The issue was closed on GitHub as completed",
    });
  });

  it("leaves a failed item with an open pull request to a person", async () => {
    await enable();
    const issue = env.gh.openIssue({ projectId: env.project.id, title: "Counter", author: "x" });
    const { id, pr } = await verifying("success", "Counter", issue.number);
    failed(id);
    env.gh.closeIssue(issue.number, "not_planned");
    await tick();
    expect(item(id).stage).toBe("failed");
    expect(waiting()).toEqual([id]);
    expect(env.gh.closed.map((c) => c.number)).not.toContain(pr.ref.number);
  });

  it("leaves a failed rebuild to ownership when a person merges its original PR", async () => {
    await enable();
    const issue = env.gh.openIssue({ projectId: env.project.id, title: "Counter", author: "x" });
    const { id, pr } = await verifying("pending", "Counter", issue.number);
    pr.linkedIssues = [issue.number];
    // It keeps conflicting, is rebuilt, and the rebuild stops before its new PR exists.
    pr.mergeable = "conflicting";
    await tick();
    await keepConflicting(id);
    expect(item(id).rebuiltFrom?.number).toBe(pr.ref.number);
    await env.setStatus(item(id).builderSessionId as string, "stopped");
    await tick();
    expect(item(id)).toMatchObject({ stage: "failed", failureKind: "stuck", pr: null });

    // A person merges the original PR; its "Fixes #n" closes the issue in the same sync.
    pr.ref = { ...pr.ref, state: "merged" };
    env.gh.closeIssue(issue.number, "completed");
    await tick();
    expect(item(id)).toMatchObject({
      stage: "merged",
      note: "Merged on GitHub",
      pr: { number: pr.ref.number },
    });
    expect(item(id).mergedAt).not.toBeNull();
  });
});

describe("dismissing a failed item (#265)", () => {
  it("rejects it with the reason, and refuses while its pull request is open", async () => {
    await enable();
    const { id } = await stoppedWithoutPr("Not worth it");
    const dismissed = env.factory.dismiss(env.project.id, id, {}, "user");
    expect(dismissed).toMatchObject({
      stage: "rejected",
      reason:
        "Dismissed by you (it had stopped: The builder session stopped without a pull request)",
    });
    expect(waiting()).toEqual([]);

    const issue = env.gh.openIssue({ projectId: env.project.id, title: "Open PR", author: "x" });
    const open = await verifying("success", "Open PR", issue.number);
    failed(open.id);
    expect(() => env.factory.dismiss(env.project.id, open.id, {}, "user")).toThrow(/still open/);
    expect(() => env.factory.dismiss(env.project.id, id, { reason: "again" }, "user")).toThrow(
      /Only failed items/,
    );
  });
});

/**
 * Issue #55: a draft pull request is not ready to merge. Nothing on the ready path looked at
 * `pr.state`, so verification announced "Ready to merge", commented on the PR and (with
 * auto-merge on) queued it, while GitHub will not merge a draft. It has to wait on the draft,
 * and take the normal path once a person marks it ready.
 */
describe("a draft pull request waits on the draft (#55)", () => {
  it("is not announced ready, and is once a person marks it ready", async () => {
    await enable("software_factory", { autoMerge: false });
    const { id, pr } = await verifying("success", "Draft counter", 5);
    review(id);
    pr.ref = { ...pr.ref, state: "draft" };

    await tick();

    expect(item(id).stage).toBe("verifying");
    expect(env.inbox.find(`inbox:factory-ready:${id}`)).toBeUndefined();
    expect((await prEntry(pr.ref.number))?.state).not.toBe("waiting_for_you");
    expect(waiting()).not.toContain(id);

    // Marked ready on GitHub: the normal path takes it.
    pr.ref = { ...pr.ref, state: "open" };
    await tick();
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).toBe("open");
    expect(waiting()).toContain(id);
  });

  it("does not join the merge queue, nor merge", async () => {
    await enable();
    const { id, pr } = await verifying("success", "Draft queue", 6);
    review(id);
    pr.ref = { ...pr.ref, state: "draft" };
    pause();

    await tick();

    expect(await prEntry(pr.ref.number)).not.toMatchObject({ queuePosition: 1 });
    expect(await prEntry(pr.ref.number)).not.toMatchObject({ state: "queued" });
    expect(env.gh.merges).toEqual([]);

    // Marked ready: it joins the queue and merges on the resumed loop.
    pr.ref = { ...pr.ref, state: "open" };
    env.factory.resume(env.project.id);
    await tick();
    expect(env.gh.merges.map((m) => m.number)).toContain(pr.ref.number);
  });
});

/**
 * Issue #55: the digest promises the Factory view's "Needs you" definition, but `needsYouItems`
 * never passed the live flags (`prWaitsForYou`, `agentWaiting`), so a ready-to-merge PR or an
 * agent waiting on a question never reached "Waiting on you".
 */
describe("live work that waits on a person reaches the digest (#55)", () => {
  it("lists a pull request that passed every check and waits for a person to merge it", async () => {
    await enable("software_factory", { autoMerge: false });
    const { id } = await verifying("success", "Ready counter", 7);
    review(id);
    await tick();

    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).toBe("open");
    expect(waiting()).toContain(id);
  });

  it("lists an agent that waits on an answer", async () => {
    await enable();
    const created = backlogItem("Ask about counters", 9);
    await tick();
    expect(item(created.id).stage).toBe("building");

    await env.setStatus(item(created.id).builderSessionId as string, "waiting");

    expect(waiting()).toContain(created.id);
  });
});
