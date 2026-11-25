import { FactoryItem, type FactoryStatus, type FactoryWorkItem } from "@codeden/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockClient } from "@/lib/api/mock";
import { FactoryViewPage } from "@/routes/factory-view";
import { status, w } from "./scene-fixtures";
import { renderWithClient } from "./utils";

/**
 * #62: dismissing a stopped item from the Factory view's side sheet succeeded, the card left
 * the pipeline, and the sheet stayed open with the stale card's "Retry or dismiss" actions — so
 * Retry then answered `not_failed`. The sheet closes once its item is no longer drawn; Retry,
 * which keeps the item in the pipeline, leaves it open on the fresh card.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
);
vi.mock("sonner", () => ({ toast }));

const at = new Date().toISOString();

const prRef = {
  number: 170,
  url: "https://github.com/acme/shop/pull/170",
  state: "open" as const,
};

const stopped = (patch: Partial<FactoryWorkItem> = {}): FactoryWorkItem =>
  w("item-1", 170, {
    title: "Login times out",
    type: "bug",
    stage: "failed",
    step: "stopped",
    reason: "The builder session stopped without a pull request",
    failureKind: "checks",
    stepSince: at,
    finishedAt: at,
    updatedAt: at,
    ...patch,
  });

const factoryStatus = (recent: FactoryWorkItem[]): FactoryStatus =>
  status({ projectId: "p-storefront", mode: "software_factory", scout: null, recent });

const item = (patch: Partial<FactoryItem> = {}): FactoryItem =>
  FactoryItem.parse({
    id: "item-1",
    projectId: "p-storefront",
    workKey: "issue:170",
    title: "Login times out",
    summary: "The login form times out",
    source: "issue",
    area: null,
    acceptanceCriteria: [],
    score: null,
    stage: "failed",
    type: "bug",
    issue: { number: 170, url: "https://github.com/acme/shop/issues/170" },
    pr: null,
    builderSessionId: null,
    builderProvider: null,
    reviewerSessionId: null,
    reviewerProvider: null,
    reviewerNote: null,
    review: null,
    checks: [],
    attempts: 0,
    reason: "The builder session stopped without a pull request",
    note: null,
    mergeSha: null,
    revertOf: null,
    triageRequestedAt: null,
    investigation: null,
    specApproval: null,
    createdAt: at,
    updatedAt: at,
    mergedAt: null,
    finishedAt: at,
    ...patch,
  });

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeAll(() => {
  // The PM chat scrolls its transcript; jsdom doesn't.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

/** Render the view with a status that changes when the action succeeds. */
function renderView(after: FactoryStatus) {
  // A wide desktop screen, so the board shows every lane.
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  const client = createMockClient();
  let current = factoryStatus([stopped()]);
  // Cloned, as the server returns it, so the view gets a fresh status.
  vi.spyOn(client.factory, "status").mockImplementation(async () => structuredClone(current));
  vi.spyOn(client.factory, "item").mockImplementation(async () => ({ item: item(), cost: null }));
  renderWithClient(<FactoryViewPage projectId="p-storefront" />, client, { withRouter: true });
  const leavePipeline = () => {
    current = after;
  };
  return { client, leavePipeline };
}

async function openStoppedSheet(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: /^#170 Login times out/ }));
  const sheet = await screen.findByTestId("factory-view-sheet");
  // The body fetches the item before it renders what the item needs.
  await within(sheet).findByTestId("factory-view-need");
  return sheet;
}

describe("the Factory view's side sheet when its item moves (#62)", () => {
  it("closes after Dismiss takes the item out of the pipeline", async () => {
    const { client, leavePipeline } = renderView(factoryStatus([]));
    vi.spyOn(client.factory, "dismiss").mockImplementation(async () => {
      leavePipeline();
      return item();
    });
    const sheet = await openStoppedSheet();
    expect(within(sheet).getByText(/Retry or dismiss/)).toBeTruthy();

    fireEvent.click(within(sheet).getByRole("button", { name: "Dismiss #170" }));

    await waitFor(() => expect(screen.queryByTestId("factory-view-sheet")).toBeNull());
  });

  it("stays open on the fresh card after Retry puts it back in review", async () => {
    const reviewing = stopped({
      stage: "verifying",
      step: "review",
      pr: prRef,
      ownedPr: prRef,
      failureKind: null,
      reason: null,
      finishedAt: null,
    });
    const { client, leavePipeline } = renderView(factoryStatus([reviewing]));
    vi.spyOn(client.factory, "retry").mockImplementation(async () => {
      leavePipeline();
      return item({ stage: "verifying", pr: prRef });
    });
    const sheet = await openStoppedSheet();

    fireEvent.click(within(sheet).getByRole("button", { name: "Retry #170" }));

    // It moved to Reviewing; the sheet follows it and drops the stale actions.
    await waitFor(() => expect(within(sheet).queryByText(/Retry or dismiss/)).toBeNull());
    expect(screen.getByTestId("factory-view-sheet")).toBe(sheet);
  });
});
