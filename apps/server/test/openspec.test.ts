import { describe, expect, it } from "vitest";
import { parseProposal } from "../src/services/factory/openspec";

/** Reading an OpenSpec change's proposal for the factory (§10.1). */

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
