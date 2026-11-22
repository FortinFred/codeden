import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake forge received. */
export interface FakeForgeRequest {
  method: string;
  /** Path and query, e.g. `/api/v1/repos/acme/widgets/issues?page=1`. */
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export type FakeForgeHandler = (
  request: FakeForgeRequest,
  response: ServerResponse,
) => void | Promise<void>;

export interface FakeForge {
  baseUrl: string;
  requests: FakeForgeRequest[];
  close: () => Promise<void>;
}

/** A local HTTP server standing in for Forgejo; no network, no Forgejo process. */
export async function startFakeForge(handler: FakeForgeHandler): Promise<FakeForge> {
  const requests: FakeForgeRequest[] = [];
  const server = createServer(async (incoming, response) => {
    const body = await readBody(incoming);
    const request: FakeForgeRequest = {
      method: incoming.method ?? "GET",
      url: incoming.url ?? "/",
      headers: incoming.headers,
      body,
    };
    requests.push(request);
    try {
      await handler(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => close(server),
  };
}

/** Answer with JSON. */
export function json(
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

/** Answer with plain text (a `.diff`). */
export function text(
  response: ServerResponse,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "text/plain", ...headers });
  response.end(body);
}

function readBody(incoming: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    incoming.on("error", reject);
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
