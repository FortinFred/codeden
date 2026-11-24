import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ItemOf, RuntimeResponse, SessionOptions } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderSession } from "../src/adapter";
import { CopilotAdapter } from "../src/copilot/adapter";
import { validateEventStream } from "../src/replay/validate";
import { readJsonLines } from "./support/json-lines";

const fakeCopilot = {
  kind: "node-script" as const,
  path: process.execPath,
  script: join(import.meta.dirname, "fixtures", "fake-copilot", "copilot.mjs"),
};

/** The title Copilot CLI gives a permission request for a path outside its trusted folders. */
const OUTSIDE = "Access paths outside trusted directories";

/** The options Copilot 1.0.115 offers (ACP `kind`s with its own ids). */
const COPILOT_OPTIONS = [
  { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
  { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject_once", kind: "reject_once", name: "Deny" },
];

type Step = Record<string, unknown>;
type Logged = { method: string; params: Record<string, unknown> & { outcome?: unknown } };
type Request = ItemOf<"approval_request"> | ItemOf<"user_question">;

/** The `tool_call` Copilot reports before it asks (its own title, the path it reached). */
const readCall = (id: string, path: string): Step => ({
  update: {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: `Viewing ${path}`,
    kind: "read",
    status: "pending",
    rawInput: { path },
    locations: [{ path }],
  },
});

/** Copilot's own ask for a path outside the folders it trusts: a `read` call titled as above. */
const pathAsk = (id: string, path: string): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: {
      toolCallId: id,
      title: OUTSIDE,
      kind: "read",
      status: "pending",
      rawInput: { path },
      locations: [{ path }],
    },
    options: COPILOT_OPTIONS,
  },
});

/** An ask of another kind with Copilot's path title: a spoofed title, judged as its kind. */
const titledAsk = (id: string, kind: string, rawInput: unknown): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: { toolCallId: id, title: OUTSIDE, kind, status: "pending", rawInput },
    options: COPILOT_OPTIONS,
  },
});

/** An ask of another kind with a title naming a URL: judged as its kind, never as a fetch. */
const urlTitledAsk = (id: string, kind: string, title: string, rawInput: unknown): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: { toolCallId: id, title, kind, status: "pending", rawInput },
    options: COPILOT_OPTIONS,
  },
});

/** The `tool_call` Copilot reports before it asks about a search outside its folders. */
const searchCall = (id: string, path: string): Step => ({
  update: {
    sessionUpdate: "tool_call",
    toolCallId: id,
    title: `Searching for "secret" in ${path}`,
    kind: "search",
    status: "pending",
    rawInput: { pattern: "secret", path },
    locations: [{ path }],
  },
});

/** Copilot's own ask for a search outside the folders it trusts. */
const searchAsk = (id: string, path: string): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: {
      toolCallId: id,
      title: OUTSIDE,
      kind: "search",
      status: "pending",
      rawInput: { pattern: "secret", path },
      locations: [{ path }],
    },
    options: COPILOT_OPTIONS,
  },
});

/** Copilot's own ask before it fetches a URL. */
const fetchAsk = (id: string, url: string): Step => ({
  request: "session/request_permission",
  params: {
    toolCall: {
      toolCallId: id,
      title: `Fetching ${url}`,
      kind: "fetch",
      status: "pending",
      rawInput: { url },
    },
    options: COPILOT_OPTIONS,
  },
});

const done: Step = { stopReason: "end_turn" };

let dir: string;
const sessions: ProviderSession[] = [];
const logFile = () => join(dir, "acp.log");
const logged = (method?: string): Logged[] =>
  existsSync(logFile())
    ? readJsonLines<Logged>(logFile()).filter((m) => !method || m.method === method)
    : [];
const answers = () =>
  logged("answer:session/request_permission").map(
    (m) => (m.params.outcome as { optionId?: string }).optionId ?? m.params.outcome,
  );

function options(script: Step[], extra: Partial<SessionOptions> = {}): SessionOptions {
  const file = join(dir, `script-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(script));
  return {
    sessionId: "s1",
    role: "agent",
    cwd: dir,
    autonomy: "auto",
    mcpServers: [],
    additionalDirectories: [],
    planMode: false,
    ...extra,
    env: { FAKE_ACP_LOG: logFile(), FAKE_ACP_SCRIPT: file, ...extra.env },
  };
}

const isTurnEnd = (e: AgentEvent) =>
  e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted";

/** Reads a session's events, answering approvals with `answer`. */
class Reader {
  readonly all: AgentEvent[] = [];
  readonly asked: Request[] = [];
  private readonly it: AsyncIterator<AgentEvent>;
  answer: (item: Request) => RuntimeResponse | undefined = () => ({
    kind: "approval",
    decision: "allow_once",
  });

  constructor(private readonly session: ProviderSession) {
    this.it = session.events[Symbol.asyncIterator]();
  }

  async turn(text: string): Promise<AgentEvent[]> {
    const from = this.all.length;
    await this.session.send({ text, attachments: [] });
    for (;;) {
      const next = await this.it.next();
      if (next.done) throw new Error("event stream ended");
      const e = next.value;
      this.all.push(e);
      if (
        e.type === "item.started" &&
        (e.item.kind === "approval_request" || e.item.kind === "user_question")
      ) {
        this.asked.push(e.item);
        const response = this.answer(e.item);
        if (response) await this.session.respond(e.item.requestId, response);
      }
      if (isTurnEnd(e)) return this.all.slice(from);
    }
  }
}

async function open(script: Step[], extra: Partial<SessionOptions> = {}) {
  const adapter = new CopilotAdapter({ executable: fakeCopilot, probeTimeoutMs: 5_000 });
  const session = await adapter.openSession(options(script, extra));
  sessions.push(session);
  return { session, reader: new Reader(session) };
}

const approvals = (reader: Reader): ItemOf<"approval_request">[] =>
  reader.asked.filter((i): i is ItemOf<"approval_request"> => i.kind === "approval_request");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codeden-copilot-"));
});

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

describe("Copilot CLI's own path ask over ACP", () => {
  it("asks the user instead of granting a read outside the folders it trusts", async () => {
    const outside = join(homedir(), "codeden-outside-the-worktree", "notes.md");
    const { reader } = await open([readCall("c1", outside), pathAsk("c1", outside), done]);
    const events = await reader.turn("Look outside");

    const [ask] = approvals(reader);
    expect(ask).toMatchObject({
      kind: "approval_request",
      action: "outside_worktree",
      title: OUTSIDE,
      paths: [outside],
    });
    expect(ask?.reason).toContain(outside);
    expect(answers()).toEqual(["allow_once"]);
    expect(validateEventStream(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
  });

  it("answers deny with Copilot's reject option, and allow_session once per path", async () => {
    const outside = join(homedir(), "codeden-outside-the-worktree", "notes.md");
    const other = join(homedir(), "codeden-elsewhere", "file.txt");
    const script = [
      readCall("c1", outside),
      pathAsk("c1", outside),
      pathAsk("c2", outside),
      pathAsk("c3", other),
      done,
    ];
    const { reader } = await open(script);
    reader.answer = () =>
      reader.asked.length === 1
        ? { kind: "approval", decision: "allow_session" }
        : { kind: "approval", decision: "deny" };
    await reader.turn("Look around");

    // The first path is remembered by CodeDen, the second ask for it is not shown again; another
    // path still asks, and the deny reaches Copilot as a rejection.
    expect(approvals(reader).map((a) => a.paths)).toEqual([[outside], [other]]);
    expect(answers()).toEqual(["allow_once", "allow_once", "reject_once"]);
    expect(reader.all).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        item: expect.objectContaining({ kind: "approval_request", decidedBy: "policy" }),
      }),
    );
  });

  it("surfaces the ask at every level", async () => {
    const outside = join(homedir(), "codeden-outside-the-worktree", "notes.md");
    for (const autonomy of ["supervised", "full", "read_only"] as const) {
      const { reader } = await open(
        [readCall(`c-${autonomy}`, outside), pathAsk(`c-${autonomy}`, outside), done],
        {
          autonomy,
        },
      );
      await reader.turn("Look outside");
      expect(approvals(reader).map((a) => a.action)).toEqual(["outside_worktree"]);
    }
  });

  it("trusts the session's own artifacts folder for reading, never for writing", async () => {
    const artifacts = join(homedir(), "codeden-artifacts-home", "artifacts", "s1");
    const shot = join(artifacts, "screenshot.png");
    const elsewhere = join(homedir(), "codeden-artifacts-home", "elsewhere.png");
    // Another session's artifacts folder is not this session's own.
    const otherSession = join(homedir(), "codeden-artifacts-home", "artifacts", "s2", "shot.png");
    const { reader } = await open(
      [
        // CodeDen hands the session its attachments and screenshots from this folder: reading
        // one is no widening, so Copilot's ask must not reach the user.
        readCall("own", shot),
        pathAsk("own", shot),
        // A read outside it, or in another session's folder, still asks.
        readCall("other", elsewhere),
        pathAsk("other", elsewhere),
        readCall("other-session", otherSession),
        pathAsk("other-session", otherSession),
        // Only reading is trusted there: writing still asks (the folder is in CodeDen's home).
        titledAsk("write", "edit", { path: shot }),
        done,
      ],
      { artifactsDir: artifacts },
    );
    await reader.turn("Look at my screenshot");

    expect(approvals(reader).map((a) => a.paths)).toEqual([[elsewhere], [otherSession], [shot]]);
    expect(answers()).toEqual(["allow_once", "allow_once", "allow_once", "allow_once"]);
  });

  it("honours a remembered allow for a read path in a read-only session", async () => {
    const outside = join(homedir(), "codeden-outside-the-worktree", "notes.md");
    const other = join(homedir(), "codeden-elsewhere", "file.txt");
    const { reader } = await open(
      [
        readCall("c1", outside),
        pathAsk("c1", outside),
        pathAsk("c2", outside),
        readCall("c3", other),
        pathAsk("c3", other),
        done,
      ],
      { readOnly: true },
    );
    reader.answer = () =>
      reader.asked.length === 1
        ? { kind: "approval", decision: "allow_session" }
        : { kind: "approval", decision: "deny" };
    await reader.turn("Look outside");

    // The option the card offers must stick for a path CodeDen judged safe: the second ask for
    // the same read is answered without showing the card again. Another path still asks, and a
    // deny still reaches Copilot as a rejection.
    expect(approvals(reader).map((a) => a.paths)).toEqual([[outside], [other]]);
    expect(answers()).toEqual(["allow_once", "allow_once", "reject_once"]);
  });

  it("leaves reads inside the worktree, the extra folders and temp, and other kinds, alone", async () => {
    const extra = mkdtempSync(join(tmpdir(), "codeden-copilot-extra-"));
    const otherTemp = mkdtempSync(join(tmpdir(), "codeden-copilot-temp-"));
    const { reader } = await open(
      [
        // The title alone is not enough: a path inside the session's own folders is no widening.
        pathAsk("in-worktree", join(dir, "src", "index.ts")),
        pathAsk("in-extra", join(extra, "notes.md")),
        pathAsk("in-temp", join(otherTemp, "scratch.txt")),
        // A command or an edit titled like the path ask is judged as what it is.
        titledAsk("command", "execute", { command: "echo hi", description: "Print" }),
        titledAsk("edit", "edit", { path: join(dir, "src", "index.ts") }),
        done,
      ],
      { additionalDirectories: [extra] },
    );
    await reader.turn("Stay inside");

    expect(approvals(reader)).toEqual([]);
    expect(answers()).toEqual([
      "allow_once",
      "allow_once",
      "allow_once",
      "allow_once",
      "allow_once",
    ]);
  });
});

describe("Copilot CLI's own search and URL asks over ACP", () => {
  it("asks the user instead of granting a search outside the folders it trusts", async () => {
    const outside = join(homedir(), "codeden-outside-the-worktree");
    const { reader } = await open([searchCall("s1", outside), searchAsk("s1", outside), done]);
    const events = await reader.turn("Search outside");

    const [ask] = approvals(reader);
    expect(ask).toMatchObject({
      kind: "approval_request",
      action: "outside_worktree",
      title: OUTSIDE,
    });
    expect(ask?.reason).toContain(outside);
    expect(answers()).toEqual(["allow_once"]);
    expect(validateEventStream(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", stopReason: "end_turn" });
  });

  it("leaves a search inside the worktree, the extra folders and temp alone", async () => {
    const extra = mkdtempSync(join(tmpdir(), "codeden-copilot-extra-"));
    const otherTemp = mkdtempSync(join(tmpdir(), "codeden-copilot-temp-"));
    const { reader } = await open(
      [
        searchAsk("in-worktree", join(dir, "src")),
        searchAsk("in-extra", extra),
        searchAsk("in-temp", otherTemp),
        done,
      ],
      { additionalDirectories: [extra] },
    );
    await reader.turn("Search inside");

    expect(approvals(reader)).toEqual([]);
    expect(answers()).toEqual(["allow_once", "allow_once", "allow_once"]);
  });

  it("asks the user before a fetch, naming the URL, and remembers the host for the session", async () => {
    const url = "https://example.com/notes/a.md";
    const sameHost = "https://example.com/notes/b.md";
    const otherHost = "https://elsewhere.test/data.json";
    const { reader } = await open([
      fetchAsk("f1", url),
      fetchAsk("f2", sameHost),
      fetchAsk("f3", otherHost),
      done,
    ]);
    reader.answer = () =>
      reader.asked.length === 1
        ? { kind: "approval", decision: "allow_session" }
        : { kind: "approval", decision: "deny" };
    await reader.turn("Fetch things");

    // The first URL asks and is remembered by host; the second URL on that host is not shown
    // again, while another host still asks, and the deny reaches Copilot as a rejection.
    expect(approvals(reader).map((a) => a.action)).toEqual(["network", "network"]);
    expect(approvals(reader).map((a) => a.title)).toEqual([`Fetch ${url}`, `Fetch ${otherHost}`]);
    expect(approvals(reader).map((a) => a.reason)).toEqual([
      expect.stringContaining(url),
      expect.stringContaining(otherHost),
    ]);
    // The remembered URL is still answered (Copilot asked, and CodeDen allows it), with no card.
    expect(answers()).toEqual(["allow_once", "allow_once", "reject_once"]);
  });

  it("surfaces a URL ask at every level", async () => {
    const url = "https://example.com/notes/a.md";
    for (const autonomy of ["supervised", "full", "read_only"] as const) {
      const { reader } = await open([fetchAsk(`f-${autonomy}`, url), done], { autonomy });
      await reader.turn("Fetch it");
      expect(approvals(reader).map((a) => a.action)).toEqual(["network"]);
    }
  });

  it("judges a command titled like a URL ask as the command it is", async () => {
    const url = "https://example.com/notes/a.md";
    const { reader } = await open(
      [
        urlTitledAsk("command", "execute", `Fetching ${url}`, { command: `curl ${url}`, url }),
        done,
      ],
      { autonomy: "full" },
    );
    await reader.turn("Run it");

    expect(approvals(reader)).toEqual([]);
  });
});
