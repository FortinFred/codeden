import type { AgentEvent } from "@codeden/contracts";
import { describe, expect, it } from "vitest";
import { answerPermission } from "../src/acp/approvals";
import { AcpEventMapper } from "../src/acp/mapper";
import { AcpPolicy } from "../src/acp/policy";
import { ApprovalBroker } from "../src/approvals";
import { chunk, fakeAcp, permission, type Request } from "./support/fake-acp";

/**
 * Copilot CLI's permission requests over ACP (copilot-cli 1.0.114, `copilot --acp`), driven
 * through the Copilot adapter against the scripted agent. Copilot ends a turn silently when a
 * request is answered `cancelled` or with a JSON-RPC error (copilot-cli#5514), so every ask
 * CodeDen can see must become an approval, a policy decision or an explicit notice.
 */
const acp = fakeAcp();

const MCP_SERVERS = [
  { transport: "http" as const, name: "codeden", url: "http://127.0.0.1:4000/mcp", trusted: true },
  { transport: "http" as const, name: "github", url: "http://127.0.0.1:4001/mcp" },
];

const answers = () => acp.logged("answer:session/request_permission").map((m) => m.params);
const notices = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "item.completed" && e.item.kind === "notice" ? [e.item] : []));

describe("Copilot CLI approvals", () => {
  it("shows a subagent's ask, labelled with its agent id, and answers the same request", async () => {
    const { reader } = await acp.openCopilot(
      [
        // Copilot sends a subagent's tool calls on the root session, with its agent id.
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            kind: "execute",
            status: "pending",
            title: "mkdir -p out",
            rawInput: { command: "mkdir -p out" },
            _meta: { "github.com/copilot": { agentId: "agent-7" } },
          },
        },
        // The ask itself repeats the call without the agent id.
        permission({
          toolCallId: "call-1",
          kind: "execute",
          title: "mkdir -p out",
          rawInput: { command: "mkdir -p out" },
        }),
      ],
      { autonomy: "supervised" },
    );
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "allow_once" };
    };
    await reader.turn("Make the folder");

    expect(asked).toMatchObject([
      { kind: "approval_request", action: "command", title: "Subagent: Run `mkdir -p out`" },
    ]);
    expect(answers()).toEqual([{ outcome: { outcome: "selected", optionId: "allow-once" } }]);
  });

  it("answers a request that offers only 'always' options instead of cancelling it", async () => {
    const onlyAlways = [
      { optionId: "always", name: "Always allow", kind: "allow_always" },
      { optionId: "never", name: "Always deny", kind: "reject_always" },
    ];
    const allow = await acp.openCopilot(
      [
        permission(
          { toolCallId: "a", kind: "execute", rawInput: { command: "pnpm build" } },
          undefined,
          onlyAlways,
        ),
      ],
      { autonomy: "supervised" },
    );
    allow.reader.answer = () => ({ kind: "approval", decision: "allow_once" });
    await allow.reader.turn("Build it");
    expect(answers().at(-1)).toEqual({ outcome: { outcome: "selected", optionId: "always" } });

    const deny = await acp.openCopilot(
      [
        permission(
          { toolCallId: "b", kind: "execute", rawInput: { command: "pnpm build" } },
          undefined,
          onlyAlways,
        ),
      ],
      { autonomy: "supervised" },
    );
    deny.reader.answer = () => ({ kind: "approval", decision: "deny" });
    await deny.reader.turn("Build it");
    expect(answers().at(-1)).toEqual({ outcome: { outcome: "selected", optionId: "never" } });
  });

  it("shows a policy escalation, and 'allow this session' covers the repeated call", async () => {
    const ask = (toolCallId: string) =>
      permission({ toolCallId, kind: "execute", rawInput: { command: "pnpm build" } });
    const { reader } = await acp.openCopilot([ask("one"), ask("two")], { autonomy: "supervised" });
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "allow_session" };
    };
    const events = await reader.turn("Build it");

    // One decision; the second ask is approved by the session approval, in the transcript only.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ action: "command", command: "pnpm build" });
    expect(answers()).toEqual([
      { outcome: { outcome: "selected", optionId: "allow-once" } },
      { outcome: { outcome: "selected", optionId: "allow-once" } },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        item: expect.objectContaining({
          kind: "approval_request",
          status: "completed",
          decidedBy: "policy",
          reason: expect.stringContaining("Supervised"),
        }),
      }),
    );
  });

  it("answers a URL request, and asks for a write outside the worktree", async () => {
    const { reader } = await acp.openCopilot(
      [
        permission({
          toolCallId: "url",
          kind: "fetch",
          title: "Fetch content from this URL.",
          rawInput: { url: "https://example.com/page" },
        }),
        permission({
          toolCallId: "outside",
          kind: "edit",
          title: "Edit a file outside the worktree",
          rawInput: { fileName: "/etc/codeden-elsewhere.txt" },
          locations: [{ path: "/etc/codeden-elsewhere.txt" }],
        }),
      ],
      { autonomy: "auto" },
    );
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "deny" };
    };
    await reader.turn("Look it up");

    // A fetch is answered by the policy (no host allow-list to judge it against); the write
    // outside the worktree reaches the user, and the denial answers that request.
    expect(asked).toMatchObject([
      { action: "outside_worktree", paths: ["/etc/codeden-elsewhere.txt"] },
    ]);
    expect(answeredOptions()).toEqual(["allow-once", "reject-once"]);
  });

  it("recognises CodeDen's own MCP tool by the tool call it repeats, and asks for others", async () => {
    const toolCall = (toolCallId: string, title: string) => ({
      update: { sessionUpdate: "tool_call", toolCallId, kind: "other", status: "pending", title },
    });
    const { reader } = await acp.openCopilot(
      [
        toolCall("own", "codeden-finish"),
        permission({
          toolCallId: "own",
          kind: "other",
          title: "finish",
          rawInput: { sort: "column" },
        }),
        toolCall("other", "github-create_issue"),
        permission({
          toolCallId: "other",
          kind: "other",
          title: "create_issue",
          rawInput: { title: "Bug" },
        }),
      ],
      { autonomy: "supervised", mcpServers: MCP_SERVERS },
    );
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "allow_once" };
    };
    await reader.turn("Finish the work");

    // CodeDen's own tool never asks; another server's does, named.
    expect(asked).toMatchObject([{ action: "tool", title: "Run github: create_issue" }]);
    expect(answeredOptions()).toEqual(["allow-once", "allow-once"]);
  });

  it("makes a request CodeDen cannot answer visible, and never answers with an error", async () => {
    const { reader } = await acp.openCopilot(
      [
        chunk("Working."),
        permission(
          { toolCallId: "odd", kind: "execute", rawInput: { command: "pnpm build" } },
          undefined,
          [{ optionId: "later", name: "Ask me later", kind: "defer" }],
        ),
      ],
      { autonomy: "supervised" },
    );
    const events = await reader.turn("Build it");

    expect(answers()).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(notices(events)).toMatchObject([
      {
        level: "warning",
        code: "approval_unanswerable",
        message: expect.stringContaining("no option"),
      },
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("turns a request from work that outlived the prompt into an approval, not a silent end", async () => {
    const { reader } = await acp.openCopilot(
      [
        chunk("I started a background task."),
        {
          late: "session/request_permission",
          params: {
            toolCall: {
              toolCallId: "bg-1",
              kind: "execute",
              title: "mkdir -p bg",
              rawInput: { command: "mkdir -p bg" },
            },
            options: [
              { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
              { optionId: "reject-once", kind: "reject_once", name: "Deny" },
            ],
          },
        },
      ],
      { autonomy: "supervised" },
    );
    const asked: Request[] = [];
    reader.answer = (item) => {
      asked.push(item);
      return { kind: "approval", decision: "allow_once" };
    };

    const first = await reader.turn("Start it");
    expect(first.at(-1)).toMatchObject({ type: "turn.completed" });

    // No turn is running: CodeDen opens one for the ask, so it is answered instead of lost.
    const approval = await reader.until(
      (e) => e.type === "item.started" && e.item.kind === "approval_request",
    );
    expect(approval).toMatchObject({
      type: "item.started",
      item: { kind: "approval_request", command: "mkdir -p bg" },
    });
    const end = await reader.until(
      (e) => e.type === "turn.completed" && e.turnId.startsWith("turn-background"),
    );
    expect(end).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
    await waitFor(() => answers().length > 0);
    expect(answers()).toEqual([{ outcome: { outcome: "selected", optionId: "allow-once" } }]);
    expect(notices(reader.all)).toMatchObject([
      { code: "background_approval", message: expect.stringContaining("no turn was running") },
    ]);
  });
});

/** The option ids CodeDen selected, in the order the requests were answered. */
function answeredOptions(): string[] {
  return answers().map((params) => (params.outcome as { optionId: string }).optionId);
}

/** The agent appends its log asynchronously; wait for what it recorded after the answer. */
async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the agent's log");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("answering a permission request that fails", () => {
  it("refuses the call with a visible notice instead of failing the request", async () => {
    const cwd = acp.dir;
    const events: AgentEvent[] = [];
    const mapper = new AcpEventMapper({
      sessionId: "s1",
      emit: (event) => events.push(event),
      tools: { cwd, mcpServers: [] },
    });
    mapper.beginTurn("turn-1");
    const question = await answerPermission(
      {
        sessionId: "s1",
        toolCall: { toolCallId: "c1", kind: "execute", rawInput: { command: "pnpm build" } },
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "reject-once", kind: "reject_once" },
        ],
      },
      {
        broker: new ApprovalBroker((event) => events.push(event)),
        policy: new AcpPolicy("auto", { cwd, extraRoots: [] }),
        mapper,
        cwd,
        label: "Copilot CLI",
        mcpServers: [],
        trustedServers: [],
        // A vendor answer that breaks must not take the request down with it.
        own: () => {
          throw new Error("unreadable vendor answer");
        },
      },
    );

    expect(question).toEqual({ outcome: { outcome: "selected", optionId: "reject-once" } });
    expect(notices(events)).toMatchObject([
      {
        level: "warning",
        code: "approval_failed",
        message: expect.stringContaining("unreadable vendor answer"),
      },
    ]);
  });
});
