import {
  type FactoryItem,
  FactoryLimits,
  type FactoryPrEntry,
  FactoryStatus,
  type FactoryWorkItem,
} from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PipelineBoard } from "@/components/factory-view/pipeline-board";
import { viewPipeline } from "@/components/factory-view/stages";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

/**
 * Issue #61: stopped work the board misrepresents. A change over the size limit is invisible
 * (no card, but it failed), and a stuck item's lane action a re-review that can never pass.
 */

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime();
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const prRef = (n: number) => ({
  number: n,
  url: `https://github.com/acme/shop/pull/${n}`,
  state: "open" as const,
});

function w(id: string, n: number, patch: Partial<FactoryWorkItem>): FactoryWorkItem {
  return {
    id,
    title: `Item ${n}`,
    workKey: `issue:${n}`,
    issue: { number: n, url: `https://github.com/acme/shop/issues/${n}` },
    openspecChange: null,
    pr: null,
    score: null,
    sessionId: null,
    reviewerSessionId: null,
    activeSessionId: null,
    stage: "failed",
    step: "stopped",
    type: "bug",
    trust: "trusted",
    author: "octocat",
    source: "issue",
    specApproval: null,
    attempts: 0,
    reason: "The builder session stopped without a pull request",
    note: null,
    failureKind: "checks",
    stepSince: minutesAgo(60),
    mergedAt: null,
    finishedAt: minutesAgo(60),
    checks: null,
    ownedPr: null,
    recovering: false,
    cost: null,
    updatedAt: minutesAgo(60),
    ...patch,
  };
}

function status(recent: FactoryWorkItem[], pullRequests: FactoryPrEntry[] = []): FactoryStatus {
  return FactoryStatus.parse({
    projectId: "p1",
    mode: "software_factory",
    experimental: true,
    loopState: "idle",
    pausedReason: null,
    killSwitch: false,
    globalKillSwitch: false,
    limits: FactoryLimits.parse({ dailyBudget: { usd: 20 } }),
    tuning: {},
    spendToday: { usd: 0, tokens: 0 },
    mergesToday: 0,
    consecutiveFailures: 0,
    activeSessions: 0,
    backlog: [],
    inProgress: [],
    mergeChecks: [],
    recent,
    pullRequests,
    visionExists: true,
    lastDigest: null,
    lastTickAt: null,
  });
}

const pr = (itemId: string, n: number, patch: Partial<FactoryPrEntry>): FactoryPrEntry => ({
  itemId,
  title: `PR ${n}`,
  pr: prRef(n),
  state: "checking",
  queuePosition: null,
  note: null,
  ...patch,
});

const allCards = (p: ReturnType<typeof viewPipeline>) => [
  ...Object.values(p.stages).flat(),
  ...p.needsYou,
];

describe("stopped work on the Factory board (#61)", () => {
  it("draws a change over the size limit, with the shared label, and counts it", () => {
    const tooLarge = w("too-large", 70, {
      reason: "size: 6,000 lines in 2 files",
      pr: prRef(70),
      ownedPr: prRef(70),
    });
    const p = viewPipeline(
      status([tooLarge], [pr("too-large", 70, { state: "waiting_for_you" })]),
      new Map(),
      NOW,
    );
    // It failed, so it is on the board; the header's failed count matches the cards it draws.
    const card = allCards(p).find((c) => c.item.id === "too-large");
    expect(card).toBeDefined();
    expect(card?.state).toBe("failed");
    expect(p.failed).toBe(1);
    // In the shared words for a size failure, so the PM's next step is visible.
    const label = "Waiting on the PM to split or allow it";
    expect(card?.activity === label || card?.need?.label === label).toBe(true);
  });

  it("offers a stuck item a Rebuild, not a re-review its CI can never pass", async () => {
    const stuck = w("stuck", 30, {
      failureKind: "stuck",
      pr: prRef(30),
      ownedPr: prRef(30),
      reason: "CI can never run: GitHub Actions is off",
      finishedAt: minutesAgo(60 * 48),
    });
    const f = status([stuck], [pr("stuck", 30, { state: "stuck", note: "In your inbox" })]);
    const p = viewPipeline(f, new Map(), NOW);
    const client = createMockClient();
    const retry = vi.spyOn(client.factory, "retry").mockResolvedValue({} as FactoryItem);
    renderWithClient(<PipelineBoard f={f} pipeline={p} now={NOW} onOpen={() => {}} />, client, {
      withRouter: true,
    });
    const lane = await screen.findByTestId("factory-view-needs-you");
    // The shared stopped label, not "Retry: stopped with PR open".
    expect(within(lane).getByText("CI can't run on this repository")).toBeTruthy();
    // Starting over is the only thing that can help: Rebuild, not a fresh review.
    const rebuild = within(lane).getByRole("button", { name: /rebuild/i });
    fireEvent.click(rebuild);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p1", "stuck", { mode: "rebuild" }));
  });
});
