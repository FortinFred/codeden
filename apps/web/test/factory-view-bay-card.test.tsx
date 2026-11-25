import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BayCardView } from "@/components/factory-view/floor/cards";
import { repairBay } from "@/components/factory-view/scene/repair-bay";
import { viewPipeline } from "@/components/factory-view/stages";
import { createMockClient } from "@/lib/api/mock";
import { minutesAgo, NOW, prEntry, prRef, status, w } from "./scene-fixtures";
import { renderWithClient } from "./utils";

/**
 * #69: the repair bay has the same actions as the Needs you lane, and its own test. A stuck item
 * starts over (Rebuild) rather than sending a pull request whose CI can never pass back to
 * review.
 */

const stuck = w("stuck", 30, {
  stage: "failed",
  step: "stopped",
  pr: prRef(30),
  ownedPr: prRef(30),
  failureKind: "stuck",
  reason: "CI can never run: GitHub Actions is off",
  finishedAt: minutesAgo(30),
});

function stuckCrate() {
  const f = status({
    recent: [stuck],
    pullRequests: [prEntry("stuck", 30, { state: "stuck", note: "In your inbox" })],
  });
  const crate = repairBay(viewPipeline(f, new Map(), NOW)).find((c) => c.kind === "stuck");
  if (!crate) throw new Error("expected a stuck crate");
  return crate;
}

describe("the repair bay's crate actions (#69)", () => {
  it("rebuilds stuck work from the crate", async () => {
    const client = createMockClient();
    const retry = vi.spyOn(client.factory, "retry").mockResolvedValue({} as never);
    renderWithClient(
      <BayCardView
        crate={stuckCrate()}
        projectId="p1"
        onEnter={() => {}}
        onLeave={() => {}}
        onOpen={() => {}}
      />,
      client,
      { withRouter: true },
    );
    const entry = await screen.findByTestId("factory-view-floor-bay-entry");
    const rebuild = screen.getByRole("button", { name: /rebuild/i });
    fireEvent.click(rebuild);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("p1", "stuck", { mode: "rebuild" }));
    expect(entry.textContent).toMatch(/CI can't run/);
  });
});
