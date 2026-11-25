import type { AgentEvent, ErrorInfo, Session, UserInput } from "@codeden/contracts";
import { agentEventToNewEvent, defaultSettings } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTokenStore } from "../src/mcp/tokens";
import type { RunnerPort } from "../src/services/runner-port";
import { SessionLifecycle } from "../src/services/sessions/lifecycle";
import { Outbox } from "../src/services/sessions/outbox";
import { SessionService, type SessionServiceDeps } from "../src/services/sessions/session-service";
import type { UtilityService } from "../src/services/utility";
import type { SettingsStore } from "../src/settings-store";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

/**
 * A role session's turn that fails for a passing reason (`usage_limit`, `transient`) is held
 * for the limit-reset or provider-switch path, like an agent's automatic retry: the session
 * stays idle with the messages that were queued behind the failed turn, instead of being
 * marked failed and having its queue delivered one failing turn at a time (#56).
 */

const T = "t-root";
const usage: ErrorInfo = {
  message: "You've hit your usage limit.",
  kind: "usage_limit",
  retryable: true,
  retryAt: "2026-11-10T22:00:00.000Z",
};
const input = (text: string): UserInput => ({ text, attachments: [] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("a role session at its provider limit", () => {
  let env: GithubEnv;
  let outbox: Outbox;
  let sessions: SessionService;
  let lifecycle: SessionLifecycle;
  /** Messages handed to the runner (a sent queued message ends up here). */
  let sent: string[];

  beforeEach(() => {
    env = createGithubEnv();
    outbox = new Outbox(env.db.db, env.store);
    sent = [];
    const runner = {
      isConnected: () => true,
      providers: () => [],
      request: vi.fn(async (command: { name: string; input?: UserInput }) => {
        if (command.name === "session.send") sent.push(command.input?.text ?? "");
        return {};
      }),
    } as unknown as RunnerPort;
    sessions = new SessionService({
      repo: env.repo,
      projects: { get: () => ({ archivedAt: null }) },
      runner,
      outbox,
      launcher: { fail: vi.fn(), resume: vi.fn() },
      artifacts: {
        externalizeAttachments: (i: UserInput) => i,
        resolveAttachments: (i: UserInput) => i,
      },
      inbox: { dismissRequestsForSession: () => {} },
      settings: { get: () => defaultSettings() },
      tokens: { revokeSession: () => {} },
    } as unknown as SessionServiceDeps);
    lifecycle = new SessionLifecycle({
      db: env.db.db,
      store: env.store,
      repo: env.repo,
      sessions,
      settings: { get: () => defaultSettings() } as unknown as SettingsStore,
      utility: {
        sessionTitle: async () => null,
        suggestFollowups: async () => [],
      } as unknown as UtilityService,
      tokens: { revokeSession: () => undefined } as unknown as McpTokenStore,
    });
    lifecycle.start();
  });

  afterEach(async () => {
    lifecycle.stop();
    await tick();
    await env.close();
  });

  /** A role session whose turn failed with `error` while two messages waited behind it. */
  const failWithQueued = (role: Session["role"], error: ErrorInfo): string => {
    const session = env.addSession({ role, status: "running", rootThreadId: T });
    const agent = (event: AgentEvent) =>
      env.store.append([agentEventToNewEvent(session.id, event)]);
    agent({ type: "thread.started", thread: { id: T } });
    outbox.push(session.id, input("first queued message"), "orchestrator");
    outbox.push(session.id, input("second queued message"), "orchestrator");
    agent({ type: "turn.started", threadId: T, turnId: "t1" });
    agent({ type: "turn.failed", threadId: T, turnId: "t1", error });
    return session.id;
  };

  const failedRuns = (id: string) =>
    env.inbox.list({ sessionId: id }).filter((i) => i.kind === "run_failed").length;

  it.each(["pm", "orchestrator"] as const)(
    "keeps the %s session idle with its queued messages and one visible failure",
    async (role) => {
      const id = failWithQueued(role, usage);
      await tick();
      await tick();

      expect({
        status: env.repo.get(id).status,
        queued: outbox.list(id).map((m) => m.input.text),
        // Nothing reaches the provider while it is at its limit.
        sent,
        failedRuns: failedRuns(id),
      }).toEqual({
        status: "idle",
        queued: ["first queued message", "second queued message"],
        sent: [],
        failedRuns: 1,
      });
    },
  );

  it("still delivers an agent session's queue, where a message cancels the automatic retry", async () => {
    const id = failWithQueued("agent", usage);
    await tick();
    await tick();

    expect({
      status: env.repo.get(id).status,
      queued: outbox.list(id).map((m) => m.input.text),
      sent,
      failedRuns: failedRuns(id),
    }).toEqual({
      status: "running",
      queued: ["second queued message"],
      sent: ["first queued message"],
      failedRuns: 0,
    });
  });
});
