import {
  type ForgeConnectionStatus,
  type ForgejoConnectionRequest,
  type ForgejoSettings,
  type ForgejoTestRequest,
  Settings,
} from "@codeden/contracts";
import type { ForgesApi } from "../feature-apis";
import type { MockWorld } from "./world";

const delay = <T>(value: T, ms = 120): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const NOT_CONFIGURED = "Forgejo is not configured. Add its URL and an access token in Settings.";
const NO_TOKEN = "Forgejo is configured, but no access token is stored. Add one in Settings.";
const UNKNOWN_VIEWER =
  "Connected to Forgejo; the token cannot read its account (it may be a repository-only token).";
const VERSION = "17.0.2";

const notConfigured = (): ForgeConnectionStatus => ({
  provider: "forgejo",
  connected: false,
  baseUrl: null,
  host: null,
  login: null,
  message: NOT_CONFIGURED,
  version: null,
});

const hostOf = (baseUrl: string): string | null => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
};

const clean = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
};

/**
 * The in-memory Forgejo connection (`VITE_CODEDEN_MOCK=1`): the same statuses as the server's
 * `ForgejoConnection`, so the settings card works without a server. A token starting with
 * `rejected` fails, and `repository-token` is a token that cannot read `/user`.
 */
export function mockForgesApi(world: MockWorld): { forges: ForgesApi } {
  const initial = world.snapshot.settings.forges.forgejo;
  let config: ForgejoSettings | null = initial ? structuredClone(initial) : null;
  // The mock keeps the token in memory, never on the settings object, as the keychain does.
  let token: string | null = null;

  const status = (): ForgeConnectionStatus => {
    if (!config) return notConfigured();
    const host = hostOf(config.baseUrl);
    if (!host) return { ...notConfigured(), message: "The Forgejo URL is not valid." };
    if (!token) {
      return {
        provider: "forgejo",
        connected: false,
        baseUrl: config.baseUrl,
        host,
        login: null,
        message: NO_TOKEN,
        version: null,
      };
    }
    if (token.startsWith("rejected")) {
      return {
        provider: "forgejo",
        connected: false,
        baseUrl: config.baseUrl,
        host,
        login: null,
        message: "Forgejo rejected the token.",
        version: null,
      };
    }
    const login = token === "repository-token" ? null : "leon";
    return {
      provider: "forgejo",
      connected: true,
      baseUrl: config.baseUrl,
      host,
      login,
      message: login ? `Connected as ${login}` : UNKNOWN_VIEWER,
      version: VERSION,
    };
  };

  const test = (req: ForgejoTestRequest = {}): ForgeConnectionStatus => {
    const baseUrl = (req.baseUrl ?? config?.baseUrl ?? "").trim();
    if (!baseUrl) return notConfigured();
    const next: ForgejoSettings = {
      baseUrl: clean(baseUrl),
      ...((req.sshHost ?? config?.sshHost) ? { sshHost: req.sshHost ?? config?.sshHost } : {}),
      allowInsecureHttp: req.allowInsecureHttp ?? config?.allowInsecureHttp ?? false,
    };
    const host = hostOf(next.baseUrl);
    if (!host) return { ...notConfigured(), message: "The Forgejo URL is not valid." };
    const candidate = req.token ?? token;
    if (!candidate) {
      return {
        provider: "forgejo",
        connected: false,
        baseUrl: next.baseUrl,
        host,
        login: null,
        message: NO_TOKEN,
        version: null,
      };
    }
    if (candidate.startsWith("rejected")) {
      return {
        provider: "forgejo",
        connected: false,
        baseUrl: next.baseUrl,
        host,
        login: null,
        message: "Forgejo rejected the token.",
        version: null,
      };
    }
    const login = candidate === "repository-token" ? null : "leon";
    return {
      provider: "forgejo",
      connected: true,
      baseUrl: next.baseUrl,
      host,
      login,
      message: login ? `Connected as ${login}` : UNKNOWN_VIEWER,
      version: VERSION,
    };
  };

  const save = (req: ForgejoConnectionRequest) => {
    config = {
      baseUrl: clean(req.baseUrl),
      ...(req.sshHost?.trim() ? { sshHost: req.sshHost.trim() } : {}),
      allowInsecureHttp: req.allowInsecureHttp === true,
    };
    if (req.token) token = req.token;
    const settings = Settings.parse({
      ...world.snapshot.settings,
      forges: { forgejo: config },
    });
    world.emitDomain({ type: "settings.updated", sessionId: null, payload: { settings } });
    return status();
  };

  return {
    forges: {
      list: () => delay({ forges: [status()] }),
      saveForgejo: (req) => delay(save(req)),
      testForgejo: (req = {}) => delay(test(req), 300),
      removeForgejo: () => {
        token = null;
        config = null;
        const settings = Settings.parse({
          ...world.snapshot.settings,
          forges: { forgejo: null },
        });
        world.emitDomain({ type: "settings.updated", sessionId: null, payload: { settings } });
        return delay(notConfigured());
      },
    },
  };
}
