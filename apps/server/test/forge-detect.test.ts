import type { ForgejoSettings } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { matchForgejoRemote } from "../src/services/projects/detect";

const web: ForgejoSettings = {
  baseUrl: "https://forge.example.com",
  allowInsecureHttp: false,
};

const matcher = (url: string, connections: ForgejoSettings[] = [web]) =>
  matchForgejoRemote(url, connections);

describe("Forgejo remote matching", () => {
  it("matches an exact web origin and /<owner>/<repo>, with .git or a trailing slash", () => {
    for (const url of [
      "https://forge.example.com/acme/widgets",
      "https://forge.example.com/acme/widgets.git",
      "https://forge.example.com/acme/widgets/",
      "https://forge.example.com/acme/widgets.git/",
    ]) {
      expect(matcher(url), url).toEqual([
        {
          baseUrl: "https://forge.example.com",
          host: "forge.example.com",
          owner: "acme",
          repo: "widgets",
        },
      ]);
    }
  });

  it("keeps the scheme, host and port exact", () => {
    expect(matcher("http://forge.example.com/acme/widgets")).toEqual([]);
    expect(matcher("https://forge.example.com:8443/acme/widgets")).toEqual([]);
    expect(matcher("https://other.example.com/acme/widgets")).toEqual([]);
    expect(
      matcher("https://forge.example.com:8443/acme/widgets", [
        { baseUrl: "https://forge.example.com:8443", allowInsecureHttp: false },
      ]),
    ).toMatchObject([{ host: "forge.example.com:8443" }]);
  });

  it("matches a Forgejo served under a path prefix", () => {
    const prefixed: ForgejoSettings = {
      baseUrl: "https://example.com/forge",
      allowInsecureHttp: false,
    };
    expect(matcher("https://example.com/forge/acme/widgets.git", [prefixed])).toEqual([
      {
        baseUrl: "https://example.com/forge",
        host: "example.com",
        owner: "acme",
        repo: "widgets",
      },
    ]);
    expect(matcher("https://example.com/acme/widgets", [prefixed])).toEqual([]);
    expect(matcher("https://example.com/forge/acme/widgets/src/main", [prefixed])).toEqual([]);
  });

  it("matches a web URL whose credentials were redacted", () => {
    expect(matcher("https://***@forge.example.com/acme/widgets.git")).toMatchObject([
      { owner: "acme", repo: "widgets" },
    ]);
  });

  it("refuses deeper paths and nearly-right paths", () => {
    for (const url of [
      "https://forge.example.com/acme",
      "https://forge.example.com/acme/widgets/src/main",
      "https://forge.example.com/forge/acme/widgets",
      "https://forge.example.com/acme/widgets?ref=main",
      "file:///acme/widgets",
      "not a url",
    ]) {
      expect(matcher(url), url).toEqual([]);
    }
  });

  it("matches SSH only when the connection names an explicit sshHost", () => {
    const ssh: ForgejoSettings = { ...web, sshHost: "git.example.com" };
    for (const url of [
      "git@git.example.com:acme/widgets.git",
      "ssh://git@git.example.com/acme/widgets.git",
      "ssh://git@git.example.com:22/acme/widgets.git",
    ]) {
      expect(matcher(url, [ssh]), url).toEqual([
        {
          baseUrl: "https://forge.example.com",
          host: "git.example.com",
          owner: "acme",
          repo: "widgets",
        },
      ]);
    }
    expect(matcher("git@git.example.com:acme/widgets.git", [web])).toEqual([]);
    expect(matcher("git@other.example.com:acme/widgets.git", [ssh])).toEqual([]);
    expect(matcher("ssh://git@git.example.com:2222/acme/widgets.git", [ssh])).toEqual([]);
  });

  it("honours an SSH port in the connection", () => {
    const ssh: ForgejoSettings = { ...web, sshHost: "git.example.com:2222" };
    expect(matcher("ssh://git@git.example.com:2222/acme/widgets.git", [ssh])).toHaveLength(1);
    expect(matcher("ssh://git@git.example.com/acme/widgets.git", [ssh])).toEqual([]);
    expect(matcher("git@git.example.com:acme/widgets.git", [ssh])).toEqual([]);
  });

  it("never guesses when more than one connection matches", () => {
    const one: ForgejoSettings = { baseUrl: "https://forge.example.com", allowInsecureHttp: false };
    const two: ForgejoSettings = {
      baseUrl: "https://forge.example.com",
      sshHost: "git.example.com",
      allowInsecureHttp: false,
    };
    expect(matcher("git@git.example.com:acme/widgets.git", [one, two]).map((m) => m.owner)).toEqual(
      ["acme"],
    );
    // Two connections naming the same SSH host both match; the caller must not pick one.
    expect(
      matcher("git@git.example.com:acme/widgets.git", [
        two,
        { ...two, baseUrl: "https://mirror.example.com" },
      ]),
    ).toHaveLength(2);
  });
});
