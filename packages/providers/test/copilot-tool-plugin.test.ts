import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEDEN_TOOLS_TOKEN_ENV,
  CODEDEN_TOOLS_URL_ENV,
  writeCopilotToolPlugin,
} from "../src/copilot/tool-plugin";

const TOKEN = "cdm_test-session-token";

const TOOLS = [
  { name: "report_progress", summary: "report what you are doing now" },
  { name: "finish", summary: "record the outcome when your task is done" },
  { name: "browser_screenshot", summary: "a PNG of the page, saved as an artifact" },
  { name: "create_pull_request", summary: "push your branch and open its pull request" },
  { name: "attach_evidence", summary: "post screenshots and test output on a PR or issue" },
  { name: "generate_image", summary: "create an image file in your worktree" },
];

type Reply = { status?: number; type: string; body: (body: unknown) => string };

/** A loopback stand-in for CodeDen's tool endpoint, answering one scripted reply. */
async function stubEndpoint(reply: Reply) {
  const seen: Array<{ authorization?: string; body: unknown }> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      seen.push({ authorization: req.headers.authorization, body });
      res.writeHead(reply.status ?? 200, { "content-type": reply.type });
      res.end(reply.body(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return {
    url,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sse = (result: unknown) => ({
  type: "text/event-stream",
  body: () => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`,
});

const json = (result: unknown) => ({
  type: "application/json",
  body: () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
});

function run(
  script: string,
  args: string[],
  url: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        env: {
          ...process.env,
          [CODEDEN_TOOLS_URL_ENV]: url,
          [CODEDEN_TOOLS_TOKEN_ENV]: TOKEN,
        },
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const plugins: Array<{ remove(): void }> = [];
afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.remove();
});

function pluginFor(sessionId = "s1", tools = TOOLS) {
  const plugin = writeCopilotToolPlugin({ sessionId, tools });
  plugins.push(plugin);
  return plugin;
}

describe("Copilot's CodeDen tool plugin", () => {
  it("writes a plugin with a skill and a bridge script, with no secret in it", () => {
    const plugin = pluginFor();
    const manifest = JSON.parse(readFileSync(join(plugin.dir, "plugin.json"), "utf8"));
    expect(manifest.name).toBe("codeden-tools");
    expect(existsSync(plugin.script)).toBe(true);
    const skill = readFileSync(join(plugin.dir, "skills", "codeden-tools", "SKILL.md"), "utf8");
    expect(skill).toContain("name: codeden-tools");
    expect(skill).toContain(plugin.script);
    expect(skill).toContain('node "');
    for (const tool of [
      "report_progress",
      "finish",
      "browser_screenshot",
      "create_pull_request",
      "attach_evidence",
      "generate_image",
    ]) {
      expect(skill, tool).toContain(`\`${tool}\``);
    }
    expect(skill).not.toContain("`start_session`");
    for (const file of [
      "plugin.json",
      "skills/codeden-tools/SKILL.md",
      "skills/codeden-tools/scripts/codeden-tool.mjs",
    ]) {
      const text = readFileSync(join(plugin.dir, file), "utf8");
      expect(text, file).not.toContain(TOKEN);
      if (process.platform !== "win32") {
        expect(statSync(join(plugin.dir, file)).mode & 0o777, file).toBe(0o600);
      }
    }
  });

  it("documents the tools it is given, so a PM's skill lists its own tools", () => {
    const plugin = pluginFor("pm-1", [
      { name: "start_session", summary: "start an agent session" },
      { name: "get_project_status", summary: "the project's state and budget" },
    ]);
    const skill = readFileSync(join(plugin.dir, "skills", "codeden-tools", "SKILL.md"), "utf8");
    expect(skill).toContain("`start_session`: start an agent session");
    expect(skill).toContain("`get_project_status`");
    for (const tool of ["finish", "create_pull_request", "browser_screenshot"]) {
      expect(skill, tool).not.toContain(`\`${tool}\``);
    }
  });

  it("runs a tool over SSE and prints its text", async () => {
    const endpoint = await stubEndpoint(
      sse({ content: [{ type: "text", text: "Progress recorded." }] }),
    );
    try {
      const plugin = pluginFor();
      const result = await run(
        plugin.script,
        ["report_progress", '{"text":"Reading code"}'],
        endpoint.url,
      );
      expect(result).toMatchObject({ code: 0, stdout: "Progress recorded.\n" });
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
      expect(endpoint.seen[0]?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(endpoint.seen[0]?.body).toMatchObject({
        method: "tools/call",
        params: { name: "report_progress", arguments: { text: "Reading code" } },
      });
    } finally {
      await endpoint.close();
    }
  });

  it("reads a plain JSON answer too", async () => {
    const endpoint = await stubEndpoint(json({ content: [{ type: "text", text: "Hello" }] }));
    try {
      const result = await run(pluginFor().script, ["finish", "{}"], endpoint.url);
      expect(result.stdout).toBe("Hello\n");
      expect(result.code).toBe(0);
    } finally {
      await endpoint.close();
    }
  });

  it("prints the tool's error and exits 1", async () => {
    const endpoint = await stubEndpoint(
      sse({ content: [{ type: "text", text: "the user dismissed the question" }], isError: true }),
    );
    try {
      const result = await run(
        pluginFor().script,
        ["ask_user", '{"question":"Go?"}'],
        endpoint.url,
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("the user dismissed the question");
    } finally {
      await endpoint.close();
    }
  });

  it("saves an image content part to a file it names", async () => {
    const data = Buffer.from("not really a png").toString("base64");
    const endpoint = await stubEndpoint(
      sse({
        content: [
          { type: "text", text: "Screenshot saved." },
          { type: "image", data, mimeType: "image/png" },
        ],
      }),
    );
    try {
      const result = await run(pluginFor().script, ["browser_screenshot", "{}"], endpoint.url);
      expect(result.code).toBe(0);
      const file = /^File: (.+)$/m.exec(result.stdout)?.[1];
      expect(file).toBeTruthy();
      expect(readFileSync(file as string).toString()).toBe("not really a png");
    } finally {
      await endpoint.close();
    }
  });

  it("refuses invalid arguments without calling the endpoint", async () => {
    const endpoint = await stubEndpoint(sse({ content: [] }));
    try {
      const result = await run(pluginFor().script, ["report_progress", "{oops"], endpoint.url);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Invalid JSON arguments");
      expect(endpoint.seen).toHaveLength(0);
    } finally {
      await endpoint.close();
    }
  });

  it("removes the folder on request", () => {
    const plugin = pluginFor();
    expect(existsSync(plugin.dir)).toBe(true);
    plugin.remove();
    expect(existsSync(plugin.dir)).toBe(false);
  });
});
