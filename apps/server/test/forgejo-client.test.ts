import { describe, expect, it } from "vitest";
import { ForgeError } from "../src/services/errors";
import { ForgejoClient } from "../src/services/forge/forgejo/client";
import { json, startFakeForge, text } from "./support/fake-forgejo";

const TOKEN = "s3cr3t-forgejo-token";

function client(
  baseUrl: string,
  extra: Partial<ConstructorParameters<typeof ForgejoClient>[0]> = {},
): ForgejoClient {
  return new ForgejoClient({
    baseUrl,
    token: TOKEN,
    owner: "acme",
    repo: "widgets",
    projectId: "p1",
    ...extra,
  });
}

function pathOf(url: string): string {
  return new URL(url, "http://localhost").pathname;
}

describe("Forgejo client", () => {
  it("sends the token header and reads the version", async () => {
    const forge = await startFakeForge((request, response) => {
      if (pathOf(request.url) === "/api/v1/version") {
        json(response, { version: "17.0.2" });
      } else {
        json(response, { message: "not found" }, 404);
      }
    });
    try {
      expect(await client(forge.baseUrl).version()).toBe("17.0.2");
      expect(forge.requests[0]?.headers.authorization).toBe(`token ${TOKEN}`);
      expect(forge.requests[0]?.url.startsWith("/api/v1/version")).toBe(true);
    } finally {
      await forge.close();
    }
  });

  it("refuses Forgejo older than 15.0 with a clear error", async () => {
    const forge = await startFakeForge((_request, response) => {
      json(response, { version: "14.0.3" });
    });
    try {
      await expect(client(forge.baseUrl).version()).rejects.toMatchObject({
        forgeCode: "forge_not_allowed",
        message: expect.stringContaining("15.0"),
      });
    } finally {
      await forge.close();
    }
  });

  it("paginates issues and drops pull request rows", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => {
      const number = index + 1;
      return {
        number,
        title: `Issue ${number}`,
        state: "open",
        html_url: `http://localhost:3000/acme/widgets/issues/${number}`,
        user: { login: "lee" },
        comments: 0,
        created_at: "2026-11-22T09:00:00Z",
        updated_at: "2026-11-22T10:00:00Z",
        ...(number === 10 ? { pull_request: { merged: false } } : {}),
      };
    });
    const forge = await startFakeForge((request, response) => {
      const url = new URL(request.url, "http://localhost");
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("limit") ?? "50");
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      response.writeHead(200, { "content-type": "application/json", "x-total-count": "51" });
      response.end(JSON.stringify(slice));
    });
    try {
      const issues = await client(forge.baseUrl).listIssues({
        state: "open",
        labels: [],
        limit: 100,
      });
      expect(issues).toHaveLength(50);
      expect(issues.some((issue) => issue.number === 10)).toBe(false);
      expect(
        forge.requests.map((request) => new URL(request.url, "http://x").searchParams.get("page")),
      ).toEqual(["1", "2"]);
    } finally {
      await forge.close();
    }
  });

  it("maps HTTP failures onto forge error codes", async () => {
    let status = 403;
    const forge = await startFakeForge((_request, response) => {
      json(response, { message: "nope" }, status);
    });
    try {
      const forgeClient = client(forge.baseUrl);
      const codes: Array<[number, string]> = [
        [403, "forge_forbidden"],
        [404, "forge_not_found"],
        [409, "forge_conflict"],
        [422, "forge_validation"],
        [405, "forge_not_allowed"],
        [429, "forge_rate_limited"],
        [503, "forge_unavailable"],
        [401, "forge_not_connected"],
      ];
      for (const [next, code] of codes) {
        status = next;
        await expect(forgeClient.repoInfo(), `${next}`).rejects.toMatchObject({ forgeCode: code });
      }
    } finally {
      await forge.close();
    }
  });

  it("reads a specific-repository token's 403 on /user as an unknown viewer", async () => {
    const forge = await startFakeForge((_request, response) => {
      json(response, { message: "no user scope" }, 403);
    });
    try {
      expect(await client(forge.baseUrl).viewerLogin()).toBeNull();
    } finally {
      await forge.close();
    }
  });

  it("retries a 401 once with a refreshed token", async () => {
    let calls = 0;
    const forge = await startFakeForge((request, response) => {
      calls++;
      if (calls === 1) {
        json(response, { message: "expired" }, 401);
        return;
      }
      if (request.headers.authorization !== "token fresh") {
        json(response, { message: "wrong token" }, 401);
        return;
      }
      json(response, { version: "17.0.2" });
    });
    try {
      const forgeClient = client(forge.baseUrl, {
        token: () => (calls === 0 ? "stale" : "fresh"),
      });
      expect(await forgeClient.version()).toBe("17.0.2");
      expect(forge.requests.map((request) => request.headers.authorization)).toEqual([
        "token stale",
        "token fresh",
      ]);
    } finally {
      await forge.close();
    }
  });

  it("caps response size and maps it to forge_unavailable", async () => {
    const forge = await startFakeForge((_request, response) => {
      json(response, { version: "x".repeat(1_000) });
    });
    try {
      await expect(
        client(forge.baseUrl, { maxResponseBytes: 100 }).version(),
      ).rejects.toMatchObject({
        forgeCode: "forge_unavailable",
        message: expect.stringContaining("larger than"),
      });
    } finally {
      await forge.close();
    }
  });

  it("times out as forge_unavailable", async () => {
    const forge = await startFakeForge(() => {
      // Never answer: the client's own deadline must fire.
    });
    try {
      await expect(client(forge.baseUrl, { timeoutMs: 50 }).version()).rejects.toMatchObject({
        forgeCode: "forge_unavailable",
        message: expect.stringContaining("did not answer"),
      });
    } finally {
      await forge.close();
    }
  });

  it("refuses a cross-origin redirect without forwarding the token", async () => {
    const other = await startFakeForge((_request, response) => {
      json(response, { version: "17.0.2" });
    });
    const forge = await startFakeForge((_request, response) => {
      response.writeHead(302, { location: `${other.baseUrl}/api/v1/version` });
      response.end();
    });
    try {
      await expect(client(forge.baseUrl).version()).rejects.toMatchObject({
        forgeCode: "forge_unavailable",
        message: expect.stringContaining("another origin"),
      });
      expect(other.requests).toHaveLength(0);
    } finally {
      await forge.close();
      await other.close();
    }
  });

  it("scrubs the token from an error message", async () => {
    const forge = await startFakeForge((_request, response) => {
      json(response, { message: `Forgejo rejected ${TOKEN}` }, 500);
    });
    try {
      const error = await client(forge.baseUrl)
        .repoInfo()
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ForgeError);
      const message = (error as ForgeError).message;
      expect(message).not.toContain(TOKEN);
      expect(message).toContain("[redacted]");
    } finally {
      await forge.close();
    }
  });

  it("resolves create-issue labels to IDs and drops unknown names", async () => {
    const logs: string[] = [];
    const forge = await startFakeForge((request, response) => {
      const path = pathOf(request.url);
      if (path === "/api/v1/repos/acme/widgets/labels") {
        json(response, [
          { id: 1, name: "bug" },
          { id: 2, name: "feature" },
        ]);
        return;
      }
      if (path === "/api/v1/repos/acme/widgets/issues" && request.method === "POST") {
        json(response, {
          number: 5,
          title: "Bug",
          state: "open",
          html_url: "http://localhost:3000/acme/widgets/issues/5",
          user: { login: "codeden-bot" },
          comments: 0,
          created_at: "2026-11-22T09:00:00Z",
          updated_at: "2026-11-22T10:00:00Z",
        });
        return;
      }
      json(response, { message: "not found" }, 404);
    });
    try {
      const issue = await client(forge.baseUrl, {
        log: (message) => logs.push(message),
      }).createIssue({
        title: "Bug",
        body: "",
        labels: ["bug", "missing"],
      });
      expect(issue.number).toBe(5);
      const posted = JSON.parse(
        forge.requests.find((request) => request.method === "POST")?.body ?? "{}",
      ) as { labels?: number[] };
      expect(posted.labels).toEqual([1]);
      expect(logs.join("\n")).toContain("missing");
      expect(logs.join("\n")).not.toContain(TOKEN);
    } finally {
      await forge.close();
    }
  });

  it("maps permission lookups without turning 403 into none", async () => {
    let mode: "write" | "none" | "forbidden" = "write";
    const forge = await startFakeForge((_request, response) => {
      if (mode === "none") json(response, { message: "not a collaborator" }, 404);
      else if (mode === "forbidden") json(response, { message: "no admin rights" }, 403);
      else json(response, { admin: false, push: true, pull: true });
    });
    try {
      const forgeClient = client(forge.baseUrl);
      expect(await forgeClient.permission("lee")).toBe("write");
      mode = "none";
      expect(await forgeClient.permission("lee")).toBe("none");
      mode = "forbidden";
      expect(await forgeClient.permission("lee")).toBe("unknown");
      const before = forge.requests.length;
      expect(await forgeClient.permission("acme")).toBe("owner");
      expect(forge.requests.length).toBe(before);
    } finally {
      await forge.close();
    }
  });

  it("reads comments in one request and keeps the most recent N", async () => {
    const forge = await startFakeForge((_request, response) => {
      json(response, [
        {
          id: 1,
          body: "first",
          user: { login: "lee" },
          created_at: "2026-11-22T09:00:00Z",
          html_url: "http://localhost:3000/acme/widgets/issues/3#issuecomment-1",
        },
        {
          id: 2,
          body: "second",
          user: { login: "sam" },
          created_at: "2026-11-22T09:30:00Z",
          html_url: "http://localhost:3000/acme/widgets/issues/3#issuecomment-2",
        },
        {
          id: 3,
          body: "third",
          user: { login: "sam" },
          created_at: "2026-11-22T10:00:00Z",
          html_url: "http://localhost:3000/acme/widgets/issues/3#issuecomment-3",
        },
      ]);
    });
    try {
      const rows = await client(forge.baseUrl).comments(3, { limit: 2 });
      expect(rows.map((row) => row.id)).toEqual([2, 3]);
      expect(forge.requests).toHaveLength(1);
      expect(new URL(forge.requests[0]?.url ?? "", "http://x").searchParams.get("page")).toBeNull();
    } finally {
      await forge.close();
    }
  });

  it("uploads one attachment per request with Forgejo's multipart field", async () => {
    const forge = await startFakeForge((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.body).toContain('name="attachment"');
      expect(request.body).toContain('filename="shot.png"');
      json(
        response,
        { name: "shot.png", browser_download_url: "http://localhost:3000/attachments/1" },
        201,
      );
    });
    try {
      const uploaded = await client(forge.baseUrl).attachFiles(3, [
        { name: "shot.png", bytes: "aGVsbG8=", caption: "The failing screen" },
        { name: "shot.png", bytes: "aGVsbG8=" },
      ]);
      expect(uploaded).toEqual([
        {
          name: "shot.png",
          url: "http://localhost:3000/attachments/1",
          caption: "The failing screen",
        },
        { name: "shot.png", url: "http://localhost:3000/attachments/1" },
      ]);
      expect(forge.requests).toHaveLength(2);
    } finally {
      await forge.close();
    }
  });

  it("reads a PR diff and refuses one whose head moved", async () => {
    let reads = 0;
    const forge = await startFakeForge((request, response) => {
      const path = pathOf(request.url);
      if (path === "/api/v1/repos/acme/widgets/pulls/4") {
        reads++;
        json(response, {
          number: 4,
          title: "Fix",
          state: "open",
          html_url: "http://localhost:3000/acme/widgets/pulls/4",
          head: { ref: "codeden/fix", sha: reads <= 3 ? "abc" : "moved" },
          base: { ref: "main", sha: "base" },
          mergeable: true,
        });
        return;
      }
      if (path === "/api/v1/repos/acme/widgets/pulls/4.diff") {
        text(
          response,
          [
            "diff --git a/src/a.ts b/src/a.ts",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -1 +1 @@",
            "-a",
            "+b",
            "",
          ].join("\n"),
        );
        return;
      }
      json(response, { message: "not found" }, 404);
    });
    try {
      const diff = await client(forge.baseUrl).pullDiff(4);
      expect(diff.headSha).toBe("abc");
      expect(diff.files[0]?.path).toBe("src/a.ts");
      expect(diff.files[0]?.additions).toBe(1);
      const moved = await client(forge.baseUrl).pullDiff(4);
      expect(moved).toEqual({ headSha: null, changedFiles: 0, files: [] });
    } finally {
      await forge.close();
    }
  });
});
