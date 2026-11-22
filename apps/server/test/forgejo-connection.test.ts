import { type ForgejoSettings, Settings } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { ForgeError } from "../src/services/errors";
import { ForgejoConnection, type ForgejoConnectionClient } from "../src/services/forge/connection";
import { MemorySecretStore } from "../src/services/secrets";

const TOKEN = "s3cr3t-forgejo-token";
const config: ForgejoSettings = {
  baseUrl: "https://forge.example.com",
  allowInsecureHttp: false,
};

interface Script {
  version?: () => Promise<string>;
  viewer?: () => Promise<string | null>;
}

function connection(initial: ForgejoSettings | null, script: Script = {}) {
  let current = Settings.parse(initial ? { forges: { forgejo: initial } } : {});
  const secrets = new MemorySecretStore();
  const calls = { version: 0, viewer: 0, saved: 0 };
  const client = (): ForgejoConnectionClient => ({
    version: async () => {
      calls.version++;
      return script.version ? script.version() : "17.0.2";
    },
    viewerLogin: async () => {
      calls.viewer++;
      return script.viewer ? script.viewer() : "lee";
    },
  });
  const forgejo = new ForgejoConnection({
    settings: () => current,
    saveSettings: (forges) => {
      calls.saved++;
      current = Settings.parse({ ...current, forges });
    },
    secrets,
    client,
  });
  return { forgejo, secrets, calls, settings: () => current };
}

describe("ForgejoConnection", () => {
  it("reports not configured, then configured without a token", async () => {
    const plain = connection(null);
    expect(await plain.forgejo.status()).toEqual({
      provider: "forgejo",
      connected: false,
      baseUrl: null,
      host: null,
      login: null,
      message: expect.stringContaining("not configured"),
      version: null,
    });
    expect(plain.calls.version).toBe(0);

    const noToken = connection(config);
    const status = await noToken.forgejo.status();
    expect(status).toMatchObject({
      connected: false,
      baseUrl: "https://forge.example.com",
      host: "forge.example.com",
      login: null,
      version: null,
    });
    expect(status.message).toMatch(/no access token/);
    expect(noToken.calls.version).toBe(0);
  });

  it("tests /version then /user and reports the login", async () => {
    const env = connection(config);
    await env.secrets.set("forgejo.token", TOKEN);
    const status = await env.forgejo.status();
    expect(status).toEqual({
      provider: "forgejo",
      connected: true,
      baseUrl: "https://forge.example.com",
      host: "forge.example.com",
      login: "lee",
      message: "Connected as lee",
      version: "17.0.2",
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(env.calls).toMatchObject({ version: 1, viewer: 1 });
  });

  it("is connected with an unknown viewer when /user answers 403", async () => {
    const env = connection(config, { viewer: async () => null });
    await env.secrets.set("forgejo.token", TOKEN);
    const status = await env.forgejo.status();
    expect(status).toMatchObject({ connected: true, login: null, version: "17.0.2" });
    expect(status.message).toMatch(/repository-only token/);

    // The service also treats a client that surfaces the 403 itself as an unknown viewer.
    const thrown = connection(config, {
      viewer: async () => {
        throw new ForgeError("forge_forbidden", "no user scope");
      },
    });
    await thrown.secrets.set("forgejo.token", TOKEN);
    expect(await thrown.forgejo.status()).toMatchObject({ connected: true, login: null });
  });

  it("is not connected when the token is rejected, and scrubs it from messages", async () => {
    const rejected = connection(config, {
      version: async () => {
        throw new ForgeError("forge_not_connected", "Forgejo rejected the token.");
      },
    });
    await rejected.secrets.set("forgejo.token", TOKEN);
    expect(await rejected.forgejo.status()).toMatchObject({
      connected: false,
      login: null,
      version: null,
      message: "Forgejo rejected the token.",
    });

    const leaky = connection(config, {
      version: async () => {
        throw new Error(`bad token ${TOKEN}`);
      },
    });
    await leaky.secrets.set("forgejo.token", TOKEN);
    const status = await leaky.forgejo.status();
    expect(status.connected).toBe(false);
    expect(status.message).not.toContain(TOKEN);
    expect(status.message).toContain("[redacted]");
  });

  it("caches the login by token value, and re-tests when the token changes", async () => {
    const env = connection(config);
    await env.secrets.set("forgejo.token", TOKEN);
    await env.forgejo.status();
    await env.forgejo.status();
    expect(env.calls).toMatchObject({ version: 1, viewer: 1 });

    await env.secrets.set("forgejo.token", "another-token");
    await env.forgejo.status();
    expect(env.calls).toMatchObject({ version: 2, viewer: 2 });
  });

  it("tests before saving, and saves a connection with its write-only token", async () => {
    const env = connection(null);
    const status = await env.forgejo.configure({
      baseUrl: "https://forge.example.com/",
      sshHost: "git.example.com:2222",
      allowInsecureHttp: false,
      token: TOKEN,
    });
    expect(status).toMatchObject({
      connected: true,
      baseUrl: "https://forge.example.com",
      host: "forge.example.com",
      login: "lee",
    });
    expect(env.calls.saved).toBe(1);
    expect(env.settings().forges.forgejo).toEqual({
      baseUrl: "https://forge.example.com",
      sshHost: "git.example.com:2222",
      allowInsecureHttp: false,
    });
    expect(await env.secrets.get("forgejo.token")).toBe(TOKEN);

    // A later save without a token keeps the stored one.
    await env.forgejo.configure({ baseUrl: "https://forge.example.com" });
    expect(await env.secrets.get("forgejo.token")).toBe(TOKEN);
  });

  it("tests overrides without saving them", async () => {
    const env = connection(config);
    await env.secrets.set("forgejo.token", TOKEN);
    const status = await env.forgejo.test({
      baseUrl: "https://other.example.com",
      token: "override-token",
    });
    expect(status).toMatchObject({ connected: true, baseUrl: "https://other.example.com" });
    expect(env.calls.saved).toBe(0);
    expect(env.settings().forges.forgejo).toEqual(config);
  });

  it("refuses a bad base URL and SSH host before saving", async () => {
    const env = connection(null);
    await expect(
      env.forgejo.configure({ baseUrl: "http://forge.example.com" }),
    ).rejects.toMatchObject({ forgeCode: "forge_validation" });
    await expect(
      env.forgejo.configure({
        baseUrl: "https://forge.example.com",
        sshHost: "git@forge.example.com",
      }),
    ).rejects.toMatchObject({ forgeCode: "forge_validation" });
    expect(env.calls.saved).toBe(0);
  });

  it("removes the connection and its token", async () => {
    const env = connection(config);
    await env.secrets.set("forgejo.token", TOKEN);
    expect(await env.forgejo.remove()).toMatchObject({ connected: false, baseUrl: null });
    expect(env.settings().forges.forgejo).toBeNull();
    expect(await env.secrets.get("forgejo.token")).toBeNull();
    expect(env.calls.saved).toBe(1);
  });
});
