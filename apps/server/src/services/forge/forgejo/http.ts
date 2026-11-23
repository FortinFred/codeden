import { CODEDEN_VERSION } from "@codeden/contracts";
import { errorMessage, ForgeError } from "../../errors";
import { type BaseUrlOptions, type ForgejoBaseUrl, validateForgejoBaseUrl } from "./base-url";

/** How a token is read. A 401 asks again once, so a rotated token is picked up. */
export type ForgejoTokenSource = string | (() => string | null | Promise<string | null>);

export interface ForgejoHttpOptions extends BaseUrlOptions {
  baseUrl: string;
  token: ForgejoTokenSource;
  /** Called after a 401, before the token is read again (usually clears a cache). */
  onUnauthorized?: () => void;
  /** How long one request may take, body included. Default 30 s. */
  timeoutMs?: number;
  /** Refuse a response body larger than this. Default 8 MiB. */
  maxResponseBytes?: number;
  /** Cross-origin redirects are always refused; same-origin ones follow up to this many. */
  maxRedirects?: number;
  /** `fetch` used for requests (tests run against a local HTTP server). */
  fetch?: typeof fetch;
}

export interface ForgejoRequest {
  method?: string;
  query?: Record<string, string | number | boolean | null | undefined | Array<string | number>>;
  /** A JSON string, or a FormData body for an upload. */
  body?: string | FormData;
  accept?: string;
  /** How to read the body: JSON (default), text (a `.diff`), or nothing. */
  as?: "json" | "text" | "none";
}

export interface ForgejoResult<T> {
  data: T;
  headers: Headers;
  status: number;
}

export interface PaginateOptions {
  /** Maximum items to return across pages. */
  limit?: number;
  /** Forgejo caps a page at 50; this is the page size asked for. */
  pageSize?: number;
  /** A hard stop, so a broken `Link` header can't loop forever. Default 20 pages. */
  maxPages?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * The HTTP layer of the Forgejo client (`docs/forges.md` §6.1, §6.3): the token goes in the
 * `Authorization` header only, cross-origin redirects are refused without forwarding it, bodies
 * and time are capped, and every failure becomes a `ForgeError` whose message is scrubbed of the
 * token.
 */
export class ForgejoHttp {
  readonly base: ForgejoBaseUrl;
  private readonly token: ForgejoTokenSource;
  private readonly onUnauthorized?: () => void;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ForgejoHttpOptions) {
    this.base = validateForgejoBaseUrl(options.baseUrl, options);
    this.token = options.token;
    this.onUnauthorized = options.onUnauthorized;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** A URL under `/api/v1`, with a path already segmented and encoded. */
  url(path: string): URL {
    const clean = path.replace(/^\/+/, "");
    const url = new URL(clean, this.base.apiUrl);
    if (url.origin !== this.base.origin) {
      throw new ForgeError("forge_validation", "A forge request escaped the configured host.");
    }
    return url;
  }

  /** GET JSON from the API. */
  get<T>(
    path: string,
    query?: ForgejoRequest["query"],
    options: Omit<ForgejoRequest, "method" | "query"> = {},
  ): Promise<ForgejoResult<T>> {
    return this.request<T>(path, { ...options, query });
  }

  async request<T>(path: string, request: ForgejoRequest = {}): Promise<ForgejoResult<T>> {
    let token = await this.readToken();
    const target = this.withQuery(this.url(path), request.query);
    try {
      let response = await this.open(target, request, token);
      if (response.status === 401) {
        await response.body?.cancel();
        this.onUnauthorized?.();
        const fresh = await this.readToken();
        if (!fresh || fresh === token) throw notConnected();
        token = fresh;
        response = await this.open(target, request, token);
        if (response.status === 401) {
          await response.body?.cancel();
          throw notConnected();
        }
      }
      return await this.consume<T>(response, request.as ?? "json", token);
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      const timedOut = (error as { name?: string }).name === "TimeoutError";
      const detail = timedOut
        ? `Forgejo did not answer within ${this.timeoutMs} ms.`
        : `Forgejo request failed: ${errorMessage(error)}`;
      throw new ForgeError("forge_unavailable", redactToken(detail, token));
    }
  }

  /**
   * Read every page of a list, stopping at `limit`, the reported total, the last short page or
   * the page cap. The cap is hard: a forge that ignores `page` cannot make this loop forever.
   */
  async paginate<T>(
    path: string,
    query: ForgejoRequest["query"] = {},
    options: PaginateOptions = {},
  ): Promise<T[]> {
    const pageSize = Math.min(options.pageSize ?? 50, 50);
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const maxPages = options.maxPages ?? 20;
    const items: T[] = [];
    let seen = 0;
    for (let page = 1; page <= maxPages; page++) {
      const result = await this.get<T[]>(path, { ...query, page, limit: pageSize });
      if (!Array.isArray(result.data)) {
        throw new ForgeError(
          "forge_unavailable",
          "Forgejo returned a list the client cannot read.",
        );
      }
      const rows = result.data;
      items.push(...rows.slice(0, Math.max(0, limit - items.length)));
      seen += rows.length;
      if (items.length >= limit || rows.length < pageSize) break;
      const totalHeader = result.headers.get("x-total-count");
      const total = totalHeader === null ? Number.NaN : Number(totalHeader);
      if (Number.isFinite(total) && seen >= total) break;
      const link = result.headers.get("link");
      if (link && !/rel="?next"?/i.test(link)) break;
    }
    return items;
  }

  private async readToken(): Promise<string> {
    const value = typeof this.token === "function" ? await this.token() : this.token;
    const token = value?.trim();
    if (!token) {
      throw new ForgeError(
        "forge_not_connected",
        "Forgejo is not connected. Add an access token in Settings.",
      );
    }
    return token;
  }

  private withQuery(url: URL, query: ForgejoRequest["query"]): URL {
    if (!query) return url;
    const next = new URL(url);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      const text = Array.isArray(value) ? value.join(",") : String(value);
      if (text.length > 0) next.searchParams.set(key, text);
    }
    return next;
  }

  /** Send one request, following same-origin redirects only. */
  private async open(url: URL, request: ForgejoRequest, token: string): Promise<Response> {
    let current = url;
    let method = request.method ?? "GET";
    let body = request.body;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      const response = await this.sendOnce(current, method, body, request.accept, token);
      if (!isRedirect(response.status)) return response;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new ForgeError("forge_unavailable", "Forgejo redirected without a location.");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new ForgeError(
          "forge_unavailable",
          "Forgejo redirected to a URL that cannot be read.",
        );
      }
      if (next.origin !== this.base.origin) {
        throw new ForgeError(
          "forge_unavailable",
          "Forgejo redirected to another origin; the token was not forwarded.",
        );
      }
      // A 303, and a 301/302 answer to a POST, become a bodyless GET.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
      }
      current = next;
    }
    throw new ForgeError("forge_unavailable", "Forgejo redirected too many times.");
  }

  private sendOnce(
    url: URL,
    method: string,
    body: string | FormData | undefined,
    accept: string | undefined,
    token: string,
  ): Promise<Response> {
    const headers = new Headers();
    headers.set("authorization", `token ${token}`);
    headers.set("accept", accept ?? "application/json");
    headers.set("user-agent", `codeden/${CODEDEN_VERSION}`);
    // A FormData body sets its own multipart boundary.
    if (typeof body === "string") headers.set("content-type", "application/json");
    return this.fetchImpl(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  private async consume<T>(
    response: Response,
    as: "json" | "text" | "none",
    token: string,
  ): Promise<ForgejoResult<T>> {
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > this.maxBytes) {
      await response.body?.cancel();
      throw new ForgeError(
        "forge_unavailable",
        `Forgejo's response is larger than ${this.maxBytes} bytes.`,
      );
    }
    if (as === "none" || response.status === 204 || response.status === 205) {
      await response.body?.cancel();
      if (!response.ok) throw this.errorFor(response.status, "", token, response.headers);
      return { data: null as T, headers: response.headers, status: response.status };
    }
    const text = await readText(response, this.maxBytes);
    if (!response.ok) throw this.errorFor(response.status, text, token, response.headers);
    if (as === "text") {
      return { data: text as T, headers: response.headers, status: response.status };
    }
    if (!text.trim())
      return { data: null as T, headers: response.headers, status: response.status };
    try {
      return { data: JSON.parse(text) as T, headers: response.headers, status: response.status };
    } catch {
      throw new ForgeError("forge_unavailable", "Forgejo returned a response that is not JSON.");
    }
  }

  private errorFor(status: number, text: string, token: string, headers?: Headers): ForgeError {
    const detail = apiMessage(text);
    const message = redactToken(
      detail ? `Forgejo: ${detail}` : `Forgejo request failed (HTTP ${status}).`,
      token,
    );
    const retryAfterMs = retryAfter(headers);
    switch (status) {
      case 401:
        return notConnected();
      case 403:
        return new ForgeError("forge_forbidden", message);
      case 404:
        return new ForgeError("forge_not_found", message);
      case 405:
      case 501:
        return new ForgeError("forge_not_allowed", message);
      case 409:
        return new ForgeError("forge_conflict", message);
      case 422:
        return new ForgeError("forge_validation", message);
      case 429:
        return new ForgeError("forge_rate_limited", message, undefined, retryAfterMs);
      default:
        return new ForgeError(
          status === 408 || status >= 500 ? "forge_unavailable" : "forge_validation",
          message,
        );
    }
  }
}

function notConnected(): ForgeError {
  return new ForgeError(
    "forge_not_connected",
    "Forgejo rejected the token. Add a new token in Settings.",
  );
}

/** A `Retry-After` header (seconds or an HTTP date) in milliseconds, if the forge sent one. */
function retryAfter(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ForgeError(
        "forge_unavailable",
        `Forgejo's response is larger than ${maxBytes} bytes.`,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function apiMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return truncate(parsed.message.trim());
    }
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      return truncate(parsed.error.trim());
    }
  } catch {
    // Plain text or HTML: use a short prefix below.
  }
  return truncate(trimmed);
}

function truncate(text: string): string {
  return text.length > 1_000 ? `${text.slice(0, 1_000)}…` : text;
}

/** Remove a token from any text that might be thrown, logged or shown. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}
