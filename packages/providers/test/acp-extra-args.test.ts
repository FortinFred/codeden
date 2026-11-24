import { describe, expect, it } from "vitest";
import { AcpSession } from "../src/acp/session";
import { CURSOR_AGENT } from "../src/cursor/adapter";
import { chunk, fakeAcp, fakeAgent } from "./support/fake-acp";

/** A plugin folder a provider-generated session opens from its command line (`toolSkills`). */
describe("ACP session extra arguments", () => {
  const acp = fakeAcp();

  it("passes them after the agent's own, and calls onClosed once the session closes", async () => {
    let closed = false;
    const session = new AcpSession(acp.options([chunk("Done.")]), {
      executable: fakeAgent,
      spec: CURSOR_AGENT,
      extraArgs: ["--plugin-dir", "/tmp/codeden-tools-x"],
      onClosed: () => {
        closed = true;
      },
    });
    await session.start();
    // The fake agent logs its argv as soon as it starts.
    const deadline = Date.now() + 10_000;
    while (acp.logged("argv").length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(acp.logged("argv")[0]?.params.args).toEqual([
      "acp",
      "--plugin-dir",
      "/tmp/codeden-tools-x",
    ]);
    await session.close();
    expect(closed).toBe(true);
  });
});
