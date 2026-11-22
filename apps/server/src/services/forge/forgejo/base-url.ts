import { isIP } from "node:net";
import { isPublicAddress } from "../../../network/public-fetch";
import { ForgeError } from "../../errors";

/**
 * A validated Forgejo base URL (`docs/forges.md` §6.3). `baseUrl` is the web root without a
 * trailing slash; `apiUrl` is where `/api/v1` calls are joined.
 */
export interface ForgejoBaseUrl {
  baseUrl: string;
  origin: string;
  apiUrl: string;
  host: string;
  /** True for plain HTTP, so a settings page can show the warning. */
  insecureHttp: boolean;
}

export interface BaseUrlOptions {
  /** Allow plain HTTP to a public host. An explicit user choice, never a default. */
  allowInsecureHttp?: boolean;
}

/**
 * Validate a forge base URL: http(s) only, no credentials, query or fragment. Plain HTTP is
 * accepted for loopback and private addresses (a self-hosted `http://localhost:3000` is normal);
 * a public host needs `allowInsecureHttp`, because the token would travel unencrypted.
 */
export function validateForgejoBaseUrl(
  input: string,
  options: BaseUrlOptions = {},
): ForgejoBaseUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ForgeError("forge_validation", "The Forgejo base URL is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ForgeError("forge_validation", "The Forgejo base URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new ForgeError(
      "forge_validation",
      "The Forgejo base URL must not contain credentials; the token is entered separately.",
    );
  }
  if (url.search || url.hash) {
    throw new ForgeError(
      "forge_validation",
      "The Forgejo base URL must not contain a query string or a fragment.",
    );
  }
  const insecureHttp = url.protocol === "http:";
  if (insecureHttp && !options.allowInsecureHttp && !isLocalHost(url.hostname)) {
    throw new ForgeError(
      "forge_validation",
      "Forgejo over plain HTTP is only allowed for a local or private address unless insecure HTTP is explicitly allowed.",
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  const baseUrl = `${url.protocol}//${url.host}${pathname}`;
  return {
    baseUrl,
    origin: url.origin,
    apiUrl: `${baseUrl}/api/v1/`,
    host: url.host,
    insecureHttp,
  };
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}
