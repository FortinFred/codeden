import type {
  ForgeConnectionStatus,
  ForgejoConnectionRequest,
  ForgejoSettings,
  ForgejoTestRequest,
  Settings,
} from "@codeden/contracts";
import { errorMessage, ForgeError } from "../errors";
import type { SecretStore } from "../secrets";
import { validateForgejoBaseUrl } from "./forgejo/base-url";
import { ForgejoClient } from "./forgejo/client";
import { redactToken } from "./forgejo/http";
import { parseForgejoSshHost } from "./forgejo/ssh-host";

/** The keychain key the Forgejo token lives under (`docs/forges.md` §6.1); never in settings. */
export const FORGEJO_TOKEN_KEY = "forgejo.token" as const;

/** The part of the phase-0 Forgejo client a connection test needs; tests inject a scripted one. */
export interface ForgejoConnectionClient {
  version(): Promise<string>;
  viewerLogin(): Promise<string | null>;
}

export interface ForgejoConnectionDeps {
  /** Current settings, read on every call so a saved change applies at once. */
  settings: () => Pick<Settings, "forges">;
  /** Persist the non-secret connection (the route also appends `settings.updated`). */
  saveSettings: (forges: Settings["forges"]) => void;
  secrets: SecretStore;
  /** The client under test; the default is the phase-0 `ForgejoClient`. */
  client?: (config: ForgejoSettings, token: string) => ForgejoConnectionClient;
  /** Diagnostics only; never passed the token. */
  log?: (message: string) => void;
}

interface CachedLogin {
  token: string;
  baseUrl: string;
  login: string | null;
  version: string;
}

const NOT_CONFIGURED = "Forgejo is not configured. Add its URL and an access token in Settings.";
const NO_TOKEN = "Forgejo is configured, but no access token is stored. Add one in Settings.";
const UNKNOWN_VIEWER =
  "Connected to Forgejo; the token cannot read its account (it may be a repository-only token).";

/**
 * The Forgejo connection (`docs/forges.md` §6.1): reads the non-secret settings and the token
 * from `SecretStore`, then tests it with `GET /version` and `GET /user`. A 403 on `/user` is a
 * connected instance whose token cannot read an account (a specific-repository token); a 401 is
 * not connected. The token is never returned, logged or put in a message, and the login is cached
 * by token value (and base URL) until the token or connection changes.
 */
export class ForgejoConnection {
  private cached: CachedLogin | null = null;

  constructor(private readonly deps: ForgejoConnectionDeps) {}

  /** The saved connection, or null when Forgejo is not configured. */
  settings(): ForgejoSettings | null {
    return this.deps.settings().forges.forgejo;
  }

  /** The current state; a live test when no result is cached for the stored token. */
  async status(): Promise<ForgeConnectionStatus> {
    const config = this.settings();
    if (!config) {
      this.cached = null;
      return notConfigured();
    }
    let base: ReturnType<typeof validateForgejoBaseUrl>;
    try {
      base = validateForgejoBaseUrl(config.baseUrl, config);
    } catch (error) {
      this.cached = null;
      return failed(displayBaseUrl(config.baseUrl), null, error, null);
    }
    const token = await this.deps.secrets.get(FORGEJO_TOKEN_KEY);
    if (!token) {
      this.cached = null;
      return {
        provider: "forgejo",
        connected: false,
        baseUrl: base.baseUrl,
        host: base.host,
        login: null,
        message: NO_TOKEN,
        version: null,
      };
    }
    if (this.cached?.token === token && this.cached.baseUrl === base.baseUrl) {
      return connected(base.baseUrl, base.host, this.cached.login, this.cached.version);
    }
    return this.test();
  }

  /**
   * Test the saved connection, or the values in `overrides` before saving them. A missing field
   * falls back to what is saved. Never writes anything.
   */
  async test(overrides: ForgejoTestRequest = {}): Promise<ForgeConnectionStatus> {
    const saved = this.settings();
    const input = overrides.baseUrl ?? saved?.baseUrl;
    if (!input) return notConfigured();
    const allowInsecureHttp = overrides.allowInsecureHttp ?? saved?.allowInsecureHttp ?? false;
    let base: ReturnType<typeof validateForgejoBaseUrl>;
    try {
      base = validateForgejoBaseUrl(input, { allowInsecureHttp });
    } catch (error) {
      return failed(displayBaseUrl(input), null, error, overrides.token ?? null);
    }
    const token = overrides.token ?? (await this.deps.secrets.get(FORGEJO_TOKEN_KEY));
    if (!token) {
      return {
        provider: "forgejo",
        connected: false,
        baseUrl: base.baseUrl,
        host: base.host,
        login: null,
        message: NO_TOKEN,
        version: null,
      };
    }
    const config: ForgejoSettings = {
      baseUrl: base.baseUrl,
      ...(overrides.sshHost !== undefined || saved?.sshHost !== undefined
        ? { sshHost: overrides.sshHost ?? saved?.sshHost }
        : {}),
      allowInsecureHttp,
    };
    try {
      const client = this.clientFor(config, token);
      const version = await client.version();
      let login: string | null;
      try {
        login = await client.viewerLogin();
      } catch (error) {
        // A 403 means a specific-repository token, not a broken connection (§6.1).
        if (error instanceof ForgeError && error.forgeCode === "forge_forbidden") login = null;
        else throw error;
      }
      this.cached = { token, baseUrl: base.baseUrl, login, version };
      return connected(base.baseUrl, base.host, login, version);
    } catch (error) {
      if (this.cached?.token === token) this.cached = null;
      this.deps.log?.(
        `forgejo: connection test failed: ${redactToken(errorMessage(error), token)}`,
      );
      return failed(base.baseUrl, base.host, error, token);
    }
  }

  /**
   * Save a connection and its optional token, then test it. The token is write-only: when it is
   * omitted the stored one stays. Throws `forge_validation` for a base URL or SSH host CodeDen
   * refuses, before anything is saved.
   */
  async configure(request: ForgejoConnectionRequest): Promise<ForgeConnectionStatus> {
    const base = validateForgejoBaseUrl(request.baseUrl, {
      allowInsecureHttp: request.allowInsecureHttp,
    });
    const sshHost = request.sshHost?.trim();
    if (sshHost && !parseForgejoSshHost(sshHost)) {
      throw new ForgeError(
        "forge_validation",
        "The SSH host must be a host name (and optional port), with no user, scheme or path.",
      );
    }
    const config: ForgejoSettings = {
      baseUrl: base.baseUrl,
      ...(sshHost ? { sshHost } : {}),
      allowInsecureHttp: request.allowInsecureHttp === true,
    };
    this.deps.saveSettings({ forgejo: config });
    if (request.token) await this.deps.secrets.set(FORGEJO_TOKEN_KEY, request.token);
    this.cached = null;
    return this.test();
  }

  /** Remove the connection and its token. Idempotent: deleting twice still reports unconfigured. */
  async remove(): Promise<ForgeConnectionStatus> {
    // Forget the secret first: a failed settings write must not leave a token behind.
    await this.deps.secrets.delete(FORGEJO_TOKEN_KEY);
    this.deps.saveSettings({ forgejo: null });
    this.cached = null;
    return notConfigured();
  }

  private clientFor(config: ForgejoSettings, token: string): ForgejoConnectionClient {
    if (this.deps.client) return this.deps.client(config, token);
    // `/version` and `/user` need no repository; the client's coordinates are unused placeholders.
    return new ForgejoClient({
      baseUrl: config.baseUrl,
      token,
      owner: "_",
      repo: "_",
      allowInsecureHttp: config.allowInsecureHttp,
      onUnauthorized: () => {
        if (this.cached?.token === token) this.cached = null;
      },
    });
  }
}

function notConfigured(): ForgeConnectionStatus {
  return {
    provider: "forgejo",
    connected: false,
    baseUrl: null,
    host: null,
    login: null,
    message: NOT_CONFIGURED,
    version: null,
  };
}

function connected(
  baseUrl: string,
  host: string,
  login: string | null,
  version: string,
): ForgeConnectionStatus {
  return {
    provider: "forgejo",
    connected: true,
    baseUrl,
    host,
    login,
    version,
    message: login ? `Connected as ${login}` : UNKNOWN_VIEWER,
  };
}

function failed(
  baseUrl: string | null,
  host: string | null,
  error: unknown,
  token: string | null,
): ForgeConnectionStatus {
  const message = token ? redactToken(errorMessage(error), token) : errorMessage(error);
  return {
    provider: "forgejo",
    connected: false,
    baseUrl,
    host,
    login: null,
    message,
    version: null,
  };
}

/** A URL safe to show: no credentials, query or fragment, and no trailing slash. */
function displayBaseUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}
