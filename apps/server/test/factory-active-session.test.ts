import type { FactoryItem, MergeCheck } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFactoryEnv, type FactoryEnv } from "./support/factory-env";
import { factorySteps } from "./support/factory-steps";

/**
 * The work item the Factory view draws must point at the agent that is actually working: an
 * integrator rebasing a conflicting PR is the item's builder while the item stays in review, and
 * an idle reviewer must not keep the card looking idle (#57). An idle builder must not shadow a
 * reviewer that is working either.
 */
let env: FactoryEnv;
afterEach(() => env?.close());
const { item, tick, enable, verifying } = factorySteps(() => env);

const activeSessionOf = async (id: string) => {
  const status = await env.factory.status(env.project.id);
  return status.inProgress.find((w) => w.id === id)?.activeSessionId;
};

describe("the work item's active session (#57)", () => {
  it("is the integrator while it rebases a conflicting PR, not the idle reviewer", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    await enable("software_factory");
    const { id, pr } = await verifying("pending");
    // The reviewer waits between turns, as it does while the factory reads the PR.
    await env.setStatus(item(id).reviewerSessionId as string, "idle");
    // The PR's author is gone, so the conflict is handed to a fresh integrator.
    env.factory.data.updateItem(id, (i) => ({ ...i, builderSessionId: "deleted-session" }));
    pr.mergeable = "conflicting";
    await tick();

    const integrator = item(id).builderSessionId as string;
    expect(integrator).not.toBe("deleted-session");
    expect(env.repo.get(integrator).status).toBe("running");
    expect(item(id).stage).toBe("verifying");
    expect(await activeSessionOf(id)).toBe(integrator);
  });

  it("is the reviewer while it reviews, over an idle builder", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    await enable("software_factory");
    const { id } = await verifying("pending");
    const reviewer = item(id).reviewerSessionId as string;
    expect(env.repo.get(reviewer).status).toBe("running");
    expect(env.repo.get(item(id).builderSessionId as string).status).toBe("idle");

    expect(await activeSessionOf(id)).toBe(reviewer);
  });

  it("is a working reviewer even when the step moved on, over an idle builder", async () => {
    env = createFactoryEnv({ providers: ["claude", "codex"] });
    await enable("software_factory");
    const { id } = await verifying("pending");
    // Every merge check passed, so the item's step is merge while the reviewer keeps working.
    const at = new Date().toISOString();
    const checks: MergeCheck[] = [
      { name: "ci", state: "pass", detail: null, escalate: false, at },
      { name: "review", state: "pass", detail: null, escalate: false, at },
    ];
    env.factory.data.updateItem(id, (i: FactoryItem) => ({ ...i, checks }));
    const reviewer = item(id).reviewerSessionId as string;
    expect(env.repo.get(reviewer).status).toBe("running");
    expect(env.repo.get(item(id).builderSessionId as string).status).toBe("idle");

    expect(await activeSessionOf(id)).toBe(reviewer);
  });
});
