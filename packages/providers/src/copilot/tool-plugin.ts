import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODEDEN_VERSION } from "@codeden/contracts";

/**
 * CodeDen's tools for a session whose provider can't use CodeDen's MCP server, because a company
 * policy blocks MCP (`Settings.agentTools.withoutMcp`): a local Copilot plugin holding a skill
 * and a self-contained bridge script. Copilot opens the plugin with `--plugin-dir`, the agent
 * runs the script, and the script calls the same role-scoped tool endpoint CodeDen's MCP clients
 * use. No MCP server is configured, so nothing is left for the policy to refuse.
 *
 * The session token is only ever passed in the agent's environment (`CODEDEN_TOOLS_TOKEN`), never
 * written to a file or a command line, so these files hold no secret. The folder sits in the OS
 * temp directory and is removed when the session closes.
 */
export interface CopilotToolPlugin {
  /** The plugin folder, passed to Copilot as `--plugin-dir <dir>`. */
  readonly dir: string;
  /** The skill's bridge script, which the generated SKILL.md tells the agent to run. */
  readonly script: string;
  /** Delete the folder and everything in it. Safe to call more than once. */
  remove(): void;
}

/** The skill (and plugin) name the agent sees. */
export const TOOL_SKILL_NAME = "codeden-tools";

/** Where the plugin's bridge finds CodeDen's tool endpoint and this session's token. */
export const CODEDEN_TOOLS_URL_ENV = "CODEDEN_TOOLS_URL";
export const CODEDEN_TOOLS_TOKEN_ENV = "CODEDEN_TOOLS_TOKEN";

/** The tools every agent session gets, and one line on what each is for. */
const AGENT_TOOLS: ReadonlyArray<{ name: string; summary: string }> = [
  {
    name: "report_progress",
    summary: "one line about what you are doing now, at the start of each phase",
  },
  {
    name: "ask_user",
    summary:
      "ask the user a decision only they can make; returns their answer, or `pending` (then end your turn and continue without it)",
  },
  { name: "share_to_chat", summary: "show the user a file or image in the chat" },
  {
    name: "suggest_followups",
    summary: "2 to 4 short next prompts the user might send; call it last every turn",
  },
  { name: "finish", summary: "record the outcome and a short summary when your task is done" },
  { name: "browser_navigate", summary: "open a URL in the browser the user watches" },
  { name: "browser_snapshot", summary: "the page's accessibility tree, with element refs" },
  { name: "browser_click", summary: "click an element by its snapshot ref" },
  { name: "browser_type", summary: "fill an editable element, or type at the cursor" },
  { name: "browser_press", summary: "press a key or chord on the focused element" },
  { name: "browser_mouse", summary: "click, hover, drag or scroll at pixel coordinates" },
  { name: "browser_select", summary: "choose options of a `<select>` menu by ref" },
  { name: "browser_upload", summary: "upload files through a file input or upload button" },
  { name: "browser_dialog", summary: "answer an alert, confirm or prompt dialog" },
  {
    name: "browser_screenshot",
    summary: "a PNG of the page, saved as an artifact and returned to you",
  },
  { name: "browser_logs", summary: "console messages and network requests of the tab" },
  { name: "browser_wait", summary: "wait for a selector, some text or network idle" },
  { name: "browser_evaluate", summary: "evaluate JavaScript in the page" },
  { name: "browser_open_dev_server", summary: "open a local dev server in a new tab" },
  {
    name: "create_pull_request",
    summary: "push your branch and open (or update) its pull request",
  },
  { name: "attach_evidence", summary: "post screenshots, files and test output on a PR or issue" },
  { name: "comment_on_issue", summary: "post a short Markdown comment on an issue or PR" },
  { name: "get_pr_status", summary: "a pull request's checks, reviews and mergeability" },
  { name: "generate_image", summary: "create an image file in your worktree" },
];

const FACTORY_TOOLS =
  "Factory sessions also have `factory_report_reproduction`, `factory_submit_analysis`, `factory_submit_review`, `factory_plan_round`, `factory_file_issue`, `factory_report_findings` and `factory_record_decision` (only the ones your role is offered).";

/** The skill file: when to use it, the exact command, and every tool it can run. */
function skillMarkdown(script: string): string {
  const command = `node "${script}" <tool> '<json arguments>'`;
  return `---
name: ${TOOL_SKILL_NAME}
description: Run CodeDen's session tools (progress, questions, sharing, finishing, browser, GitHub, factory). Use this skill whenever you need a CodeDen tool. CodeDen's MCP server is not used in this session.
---

# CodeDen tools

CodeDen's MCP server is not used in this session: the provider's company policy blocks MCP.
Every CodeDen tool is run through the bridge script in this skill, one tool per command:

\`\`\`
${command}
\`\`\`

- \`<tool>\` is one of the names below.
- \`'<json arguments>'\` is one shell-quoted JSON object, for example \`'{"text":"Reading the code"}'\`.
  Use \`'{}'\` for a tool without arguments.
- The bridge prints the tool's result, and saves any images to files it names.
- Exit code 0 means the tool succeeded. A tool that reported an error exits 1 and prints why;
  a usage or environment problem exits 2.
- Run one tool per command; don't chain them. \`ask_user\` may take a few minutes: if it
  returns \`pending\`, do not wait or ask again, finish what you can and end your turn.

## Tools

${AGENT_TOOLS.map((tool) => `- \`${tool.name}\`: ${tool.summary}`).join("\n")}

${FACTORY_TOOLS}

For anything else on GitHub (reading or editing issues, labels, checks, reviews) use the \`gh\`
CLI, which is signed in as the user. GitHub has no API for uploading images, so \`gh\` can't
attach screenshots: use \`attach_evidence\`, or reuse the image URLs it returns.
`;
}

/**
 * The bridge: one tool call over plain HTTP JSON-RPC to CodeDen's loopback endpoint, with the
 * token from the environment. Plain Node, no dependencies, so it runs wherever the agent does.
 */
const BRIDGE_SCRIPT = `#!/usr/bin/env node
// CodeDen tool bridge, generated by CodeDen. Runs one CodeDen tool without MCP.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [name, raw = "{}"] = process.argv.slice(2);
if (!name) {
  console.error("usage: node codeden-tool.mjs <tool> '<json arguments>'");
  process.exit(2);
}
const url = process.env.${CODEDEN_TOOLS_URL_ENV};
const token = process.env.${CODEDEN_TOOLS_TOKEN_ENV};
if (!url || !token) {
  console.error("CodeDen tools are unavailable in this session (the tool endpoint variables are missing).");
  process.exit(2);
}
let args;
try {
  args = raw.trim() ? JSON.parse(raw) : {};
} catch (error) {
  console.error("Invalid JSON arguments: " + (error && error.message ? error.message : String(error)));
  process.exit(2);
}

let response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
} catch (error) {
  console.error("CodeDen server unreachable: " + (error && error.message ? error.message : String(error)));
  process.exit(1);
}
const body = await response.text();
if (!response.ok) {
  console.error("CodeDen returned HTTP " + response.status + ": " + body.slice(0, 300));
  process.exit(1);
}
const message = parseMessage(response.headers.get("content-type") || "", body);
if (!message) {
  console.error("CodeDen returned no tool result.");
  process.exit(1);
}
if (message.error) {
  console.error(message.error.message || JSON.stringify(message.error));
  process.exit(1);
}
const result = message.result || {};
const content = Array.isArray(result.content) ? result.content : [];
const text = content
  .filter((part) => part && part.type === "text" && typeof part.text === "string")
  .map((part) => part.text)
  .join("\\n");
if (text) (result.isError ? console.error : console.log)(text);
for (const [index, part] of content.entries()) {
  if (!part || part.type !== "image" || typeof part.data !== "string") continue;
  const ext =
    part.mimeType === "image/jpeg" ? "jpg" :
    part.mimeType === "image/gif" ? "gif" :
    part.mimeType === "image/webp" ? "webp" : "png";
  const file = join(
    tmpdir(),
    "codeden-tool-" + process.pid + "-" + Date.now() + "-" + index + "." + ext,
  );
  writeFileSync(file, Buffer.from(part.data, "base64"), { mode: 0o600 });
  console.log("File: " + file);
}
process.exitCode = result.isError ? 1 : 0;

function parseMessage(contentType, body) {
  if (/text\\/event-stream/i.test(contentType)) {
    let last;
    for (const line of body.split(/\\r?\\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const message = JSON.parse(data);
        if (message && (message.result !== undefined || message.error !== undefined)) last = message;
      } catch {
        // A keep-alive or a comment line: not a result.
      }
    }
    return last;
  }
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
`;

/** A session id as a folder name: safe characters only, and short. */
function folderName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
}

/**
 * Write the plugin for one session to a fresh owner-only folder in the OS temp directory.
 * `remove()` deletes it; the caller must call it when the session closes.
 */
export function writeCopilotToolPlugin(opts: { sessionId: string }): CopilotToolPlugin {
  const dir = mkdtempSync(path.join(tmpdir(), `codeden-tools-${folderName(opts.sessionId)}-`));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    chmodSync(dir, 0o700);
    const skillDir = path.join(dir, "skills", TOOL_SKILL_NAME);
    const scripts = path.join(skillDir, "scripts");
    mkdirSync(scripts, { recursive: true, mode: 0o700 });
    const script = path.join(scripts, "codeden-tool.mjs");
    writeFileSync(
      path.join(dir, "plugin.json"),
      `${JSON.stringify(
        {
          name: TOOL_SKILL_NAME,
          version: CODEDEN_VERSION,
          description: "CodeDen's session tools, run through a skill and a bridge script (no MCP)",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    writeFileSync(path.join(skillDir, "SKILL.md"), skillMarkdown(script), { mode: 0o600 });
    writeFileSync(script, BRIDGE_SCRIPT, { mode: 0o600 });
    return { dir, script, remove };
  } catch (error) {
    remove();
    throw error;
  }
}
