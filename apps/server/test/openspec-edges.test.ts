import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@codeden/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSpecChangeId,
  readOpenSpecChanges,
  writeOpenSpecChange,
} from "../src/services/factory/openspec";

/**
 * The OpenSpec change helpers on the edges of a filesystem: Windows device names, an oversized
 * proposal, and a folder left behind by an interrupted write.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(prefix = "openspec-"): Project {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "openspec", "changes"), { recursive: true });
  return { path: root } as Project;
}

const changesRoot = (p: Project) => join(p.path, "openspec", "changes");
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

describe("OpenSpec change ids on Windows", () => {
  it("never derives a DOS device name, which cannot be a folder there", () => {
    for (const title of ["CON", "prn", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
      const id = openSpecChangeId(title);
      expect(WINDOWS_DEVICE.test(id), `${title} became ${id}`).toBe(false);
    }
  });

  it("creates the folder under the safe id it returns", () => {
    const p = project();
    const created = writeOpenSpecChange(p, { title: "CON", body: "Reserved." });
    expect(WINDOWS_DEVICE.test(created.id)).toBe(false);
    expect(readFileSync(join(p.path, created.path, "proposal.md"), "utf8")).toContain("Reserved.");
  });
});

describe("OpenSpec proposals that are too large", () => {
  it("skips a proposal far over the cap without reading it, and takes the normal one in", () => {
    const p = project();
    const huge = join(changesRoot(p), "huge");
    mkdirSync(huge, { recursive: true });
    writeFileSync(join(huge, "proposal.md"), `# Huge\n\n${"x".repeat(10 * 1024 * 1024)}`);
    const small = join(changesRoot(p), "small");
    mkdirSync(small, { recursive: true });
    writeFileSync(join(small, "proposal.md"), "# Small\n\nFine.\n");
    expect(readOpenSpecChanges(p).map((c) => c.ref.id)).toEqual(["small"]);
  });
});

describe("OpenSpec folder left behind by an interrupted write", () => {
  it("reuses a folder holding only a stale tmp file", () => {
    const p = project();
    const dir = join(changesRoot(p), "add-login");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proposal.md.tmp"), "# Add login\n\nHalf-written.");
    const created = writeOpenSpecChange(p, { title: "Add login", body: "Users sign in." });
    expect(created).toEqual({ id: "add-login", path: "openspec/changes/add-login" });
    expect(readFileSync(join(dir, "proposal.md"), "utf8")).toBe("# Add login\n\nUsers sign in.\n");
    expect(existsSync(join(dir, "proposal.md.tmp"))).toBe(false);
  });

  it("writes into an empty folder", () => {
    const p = project();
    const dir = join(changesRoot(p), "add-login");
    mkdirSync(dir, { recursive: true });
    writeOpenSpecChange(p, { title: "Add login", body: "Users sign in." });
    expect(readFileSync(join(dir, "proposal.md"), "utf8")).toContain("Users sign in.");
  });

  it("still refuses a folder that has a real proposal, and leaves it alone", () => {
    const p = project();
    const dir = join(changesRoot(p), "add-login");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "proposal.md"), "# Add login\n\nKeep me.\n");
    expect(() => writeOpenSpecChange(p, { title: "Add login", body: "Other." })).toThrow(
      /already exists/,
    );
    expect(readFileSync(join(dir, "proposal.md"), "utf8")).toBe("# Add login\n\nKeep me.\n");
  });
});
