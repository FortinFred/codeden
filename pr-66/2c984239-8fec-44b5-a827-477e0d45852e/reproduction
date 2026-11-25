import type { InboxItem, Snapshot } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InboxEntry } from "@/components/inbox/inbox-entry";
import { createMockClient } from "@/lib/api/mock";
import { inboxItems } from "@/lib/api/mock/fixtures/sessions";
import { groupInbox, inboxCounts } from "@/lib/inbox";
import { InboxPage } from "@/routes/inbox";
import { renderWithClient } from "./utils";

/**
 * #63: the inbox overstates the work. Only items `inboxWaitsOnYou` names wait on a person; the
 * rest (a PR ready, failed runs the factory handles, spot-checks, automation results, a changed
 * automation, the digest) are notices. A dismissed item was not resolved either.
 *
 * The mock world's open items: 5 that wait on the person (an approval, a question, a triage
 * decision, a spec, changed setup commands), 6 notices, plus one start conflict.
 */

function fixture(id: string): InboxItem {
  const item = inboxItems.find((i) => i.id === id);
  if (!item) throw new Error(`no fixture ${id}`);
  return item;
}

function closed(item: InboxItem, status: "resolved" | "dismissed"): InboxItem {
  return { ...item, status, resolvedAt: new Date(0).toISOString() };
}

describe("the inbox counts only what waits on you (#63)", () => {
  it("keeps notices out of the header and tab counts, counting them apart", () => {
    const counts = inboxCounts(inboxItems, 1);
    expect(counts).toEqual({ all: 6, asks: 6, reviews: 0, problems: 0, notices: 6 });
  });

  it("lists notices apart from the reviews, never under them", () => {
    expect(groupInbox(inboxItems, "all").map((g) => g.id)).toEqual([
      "approval",
      "question",
      "spec_approval",
      "setup_change",
      "triage",
    ]);
    expect(groupInbox(inboxItems, "reviews")).toEqual([]);
    expect(groupInbox(inboxItems, "notices").map((g) => g.id)).toEqual([
      "pr_review",
      "spot_check",
      "run_failed",
      "automation_result",
      "message",
    ]);
  });

  it("says how many items wait on you, not how many notices there are", async () => {
    renderWithClient(<InboxPage />, createMockClient(), { withRouter: true });
    const meta = await screen.findByText(/\d+ waiting on you/);
    expect(meta.textContent).toBe("6 waiting on you");
  });
});

describe("the inbox tells a dismissal from a resolution (#63)", () => {
  it("labels a dismissed entry Dismissed, not Resolved", async () => {
    renderWithClient(<InboxEntry item={closed(fixture("ib-audit"), "dismissed")} />, undefined, {
      withRouter: true,
    });
    const label = await screen.findByText(/^(Resolved|Dismissed)/);
    expect(label.textContent).toMatch(/^Dismissed/);
  });

  it("keeps Resolved for an item genuinely resolved", async () => {
    renderWithClient(<InboxEntry item={closed(fixture("ib-pr"), "resolved")} />, undefined, {
      withRouter: true,
    });
    const label = await screen.findByText(/^(Resolved|Dismissed)/);
    expect(label.textContent).toMatch(/^Resolved/);
  });

  it("heads the closed section neutrally", async () => {
    const base = createMockClient();
    const snapshot: Snapshot = {
      ...(await base.getSnapshot()),
      inbox: [closed(fixture("ib-audit"), "dismissed"), closed(fixture("ib-pr"), "resolved")],
    };
    const client = Object.assign(base, { getSnapshot: async () => snapshot });
    renderWithClient(<InboxPage />, client, { withRouter: true });

    const heading = await screen.findByText(/^Recently /);
    expect(heading.textContent).toBe("Recently closed");
  });
});
