import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateProjectResponse,
  DisconnectForgeResponse,
  type ForgejoSettings,
  type ForgesResponse,
  Project,
} from "@codeden/contracts";
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

  it("recognises a matching Forgejo remote and disconnects it", async () => {
    const configured = await call("PUT", "/forges/forgejo", {
      baseUrl: "https://forge.example.com",
      token: "good-token",
    });
    expect(configured.status).toBe(200);

    const folder = join(home, "widgets");
    mkdirSync(folder);
    execFileSync("git", ["-C", folder, "init", "-q", "-b", "main"], { stdio: "pipe" });
    execFileSync(
      "git",
      ["-C", folder, "remote", "add", "origin", "https://forge.example.com/acme/widgets.git"],
      { stdio: "pipe" },
    );
    const created = await call("POST", "/projects", { source: { type: "local", path: folder } });
    expect(created.status).toBe(201);
    const project = CreateProjectResponse.parse(created.json()).project;
    expect(project).toMatchObject({
      kind: "forge",
      forge: {
        provider: "forgejo",
        baseUrl: "https://forge.example.com",
        host: "forge.example.com",
        owner: "acme",
        repo: "widgets",
      },
    });

    // origin still matches the connection: disconnecting would undo itself on the next check.
    const present = await call("POST", `/projects/${project.id}/disconnect-forge`);
    expect(present.status).toBe(409);
    expect(present.json()).toMatchObject({ error: { code: "forge_remote_present" } });

    // A factory mode needs a GitHub project, so the forge stays put until the mode changes.
    server.store.append([
      {
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...project, autonomyMode: "software_factory" } },
      },
    ]);
    const refused = await call("POST", `/projects/${project.id}/disconnect-forge`);
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: "factory_mode" } });

    server.store.append([
      {
        type: "project.updated",
        sessionId: null,
        payload: { project: { ...project, autonomyMode: "assisted" } },
      },
    ]);
    execFileSync("git", ["-C", folder, "remote", "remove", "origin"], { stdio: "pipe" });
    const disconnected = await call("POST", `/projects/${project.id}/disconnect-forge`);
    expect(disconnected.status).toBe(200);
    expect(DisconnectForgeResponse.parse(disconnected.json()).project.kind).toBe("local");
    expect(Project.parse((await call("GET", `/projects/${project.id}`)).json())).toMatchObject({
      kind: "local",
    });

    // Only a forge project can be disconnected: not a local one, and not twice.
    const again = await call("POST", `/projects/${project.id}/disconnect-forge`);
    expect(again.status).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: "not_a_forge_project" } });
    const plain = join(home, "plain");
    mkdirSync(plain);
    const local = CreateProjectResponse.parse(
      (await call("POST", "/projects", { source: { type: "local", path: plain } })).json(),
    ).project;
    expect(local.kind).toBe("local");
    expect((await call("POST", `/projects/${local.id}/disconnect-forge`)).status).toBe(409);
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
