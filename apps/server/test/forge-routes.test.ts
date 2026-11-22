import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgejoSettings, ForgesResponse } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startServer } from "../src";
import { ForgeError } from "../src/services/errors";
import type { ForgejoConnectionClient } from "../src/services/forge/connection";
import { removeTree } from "./support/remove-tree";

const TOKEN = "a".repeat(64);
let home: string;
let server: RunningServer;

const client = (_config: ForgejoSettings, token: string): ForgejoConnectionClient => ({
  version: async () => {
    if (token === "rejected") {
      throw new ForgeError("forge_not_connected", "Forgejo rejected the token.");
    }
    return "17.0.2";
  },
  viewerLogin: async () => (token === "repository-token" ? null : "lee"),
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "codeden-forge-routes-"));
  server = await startServer({
    port: 0,
    dataDir: join(home, "data"),
    token: TOKEN,
    runner: false,
    secrets: "memory",
    checkSetupOnStart: false,
    userHome: join(home, "user"),
    forgejo: { client },
  });
});

afterEach(async () => {
  await server.close();
  await removeTree(home);
});

const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) as unknown };
};

describe("/api/forges", () => {
  it("reports, saves, tests and removes the Forgejo connection without returning its token", async () => {
    const empty = await call("GET", "/forges");
    expect(empty.status).toBe(200);
    expect((empty.json() as ForgesResponse).forges).toEqual([
      {
        provider: "forgejo",
        connected: false,
        baseUrl: null,
        host: null,
        login: null,
        message: expect.stringContaining("not configured"),
        version: null,
      },
    ]);

    const saved = await call("PUT", "/forges/forgejo", {
      baseUrl: "https://forge.example.com/",
      token: "good-token",
    });
    expect(saved.status).toBe(200);
    expect(saved.json()).toMatchObject({
      provider: "forgejo",
      connected: true,
      baseUrl: "https://forge.example.com",
      host: "forge.example.com",
      login: "lee",
      version: "17.0.2",
    });
    expect(saved.text).not.toContain("good-token");

    const status = await call("GET", "/forges");
    expect((status.json() as ForgesResponse).forges[0]).toMatchObject({
      connected: true,
      login: "lee",
    });

    const unknown = await call("POST", "/forges/forgejo/test", { token: "repository-token" });
    expect(unknown.json()).toMatchObject({
      connected: true,
      login: null,
      message: expect.stringContaining("repository-only"),
    });

    const rejected = await call("POST", "/forges/forgejo/test", { token: "rejected" });
    expect(rejected.json()).toMatchObject({ connected: false, login: null });

    const removed = await call("DELETE", "/forges/forgejo");
    expect(removed.json()).toMatchObject({ connected: false, baseUrl: null });
    expect((await call("GET", "/forges")).text).not.toContain("good-token");
  });

  it("refuses an insecure public base URL and an invalid SSH host", async () => {
    const insecure = await call("PUT", "/forges/forgejo", {
      baseUrl: "http://forge.example.com",
    });
    expect(insecure.status).toBe(422);
    expect(insecure.json()).toMatchObject({ error: { code: "forge_validation" } });

    const ssh = await call("PUT", "/forges/forgejo", {
      baseUrl: "https://forge.example.com",
      sshHost: "git@forge.example.com",
    });
    expect(ssh.status).toBe(422);
    expect(ssh.json()).toMatchObject({ error: { code: "forge_validation" } });
  });
});
