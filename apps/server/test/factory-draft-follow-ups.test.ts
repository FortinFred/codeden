import { afterEach, describe, expect, it } from "vitest";
import { advanceVerifying, DRAFT_NOTE, READY_RECHECK_MS } from "../src/services/factory/verify";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * Issue #68, the loose ends #59's draft handling left: the draft note has to go once the pull
 * request is ready (and queued), a pull request converted to a draft has to close its
 * "Ready to merge" inbox item, and the PM must be able to allow a size-failed draft that waits
 * on nobody but the PM.
 */

let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, later, enable, backlogItem, verifying, review, prEntry } = factorySteps(
  () => env,
);

/** Hold merges (the loop is paused) while work in flight keeps moving. */
function pause() {
  const loop = env.factory.data.loopOrNew(env.project.id);
  env.factory.data.saveLoop({ ...loop, state: "paused", pausedReason: "held by the test" });
}

describe("draft pull request follow-ups (#68)", () => {
  it("clears the draft note when the pull request is marked ready and joins the queue", async () => {
    env = createFactoryEnv();
    await enable();
    const { id, pr } = await verifying("success", "Draft counter", 11);
    review(id);
    pause();

    pr.ref = { ...pr.ref, state: "draft" };
    await tick();
    expect(item(id).note).toBe(DRAFT_NOTE);

    // The verification step alone: the queue pass that follows it in a tick may write its own
    // note ("waiting while the loop is paused"), which would hide the stale draft note.
    pr.ref = { ...pr.ref, state: "open" };
    const loop = env.factory.data.loopOrNew(env.project.id);
    const project = env.factory.ctx.projects.get(env.project.id);
    await advanceVerifying(env.factory.ctx, project, loop, item(id));

    expect(item(id).nudges.merge_queued).toBeTruthy();
    expect(await prEntry(pr.ref.number)).toMatchObject({ queuePosition: 1 });
    expect(item(id).note).toBeNull();
  });

  it("closes the ready-to-merge inbox item when the pull request becomes a draft", async () => {
    env = createFactoryEnv();
    await enable("software_factory", { autoMerge: false });
    const { id, pr } = await verifying("success", "Ready then draft", 12);
    review(id);
    await tick();
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).toBe("open");

    // A ready PR is read again only after READY_RECHECK_MS; until then its draft state is unseen.
    later(READY_RECHECK_MS + 1);
    pr.ref = { ...pr.ref, state: "draft" };
    await tick();

    expect(item(id).note).toBe(DRAFT_NOTE);
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).not.toBe("open");

    // Marked ready again: the normal path announces it afresh instead of leaving it resolved.
    pr.ref = { ...pr.ref, state: "open" };
    await tick();
    expect(env.inbox.find(`inbox:factory-ready:${id}`)?.status).toBe("open");
  });

  it("lets the PM allow a size-failed draft without waiting for someone to mark it ready", async () => {
    env = createFactoryEnv();
    await enable();
    const created = backlogItem("Scaffold the app", 13);
    await tick();
    const builder = item(created.id).builderSessionId as string;
    // 6,000 lines of code over the 5,000 default; the 9,000 lockfile lines don't count.
    const pr = env.gh.openPr({
      sessionId: builder,
      title: "Scaffold the app",
      files: ["src/app.ts", "test/app.test.ts", "package-lock.json"],
      fileLines: [
        { path: "src/app.ts", lines: 5_500 },
        { path: "test/app.test.ts", lines: 500 },
        { path: "package-lock.json", lines: 9_000 },
      ],
    });
    pr.ref = { ...pr.ref, state: "draft" };
    await env.setStatus(builder, "idle");
    await tick();

    expect(item(created.id).stage).toBe("failed");
    expect(item(created.id).checks.find((c) => c.name === "size")?.state).toBe("fail");

    const allowed = env.factory.allowLargeChange(env.project.id, {
      itemId: created.id,
      reason: "Initial scaffold; it can't be split",
    });
    expect(allowed.stage).toBe("verifying");
  });
});
