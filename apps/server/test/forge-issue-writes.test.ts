import type { Automation, AutomationRun, Project } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TriageService } from "../src/services/automations/triage";
import { isCodedenComment, withoutMarker } from "../src/services/github/issues";
import type { OrchestrationService } from "../src/services/orchestration/orchestration-service";
import type { SessionService } from "../src/services/sessions/session-service";
import { createForgeEnv, type ForgeEnv } from "./support/forge-env";

/**
 * `docs/forges.md` phase B1: issue writes on a Forgejo project through the shared service, so
 * the PM can comment, label, create and triage/close issues there. PR writes stay GitHub-only.
 */

let env: ForgeEnv;
const P = "p-forge";
const issueUrl = (number: number) => `http://127.0.0.1:3000/acme/widgets/issues/${number}`;

beforeEach(() => {
  env = createForgeEnv();
});
afterEach(async () => {
  await env.close();
});

const types = (from = 0) => env.events.slice(from).map((event) => event.type);
const body = (method: string, suffix: string) => {
  const request = env.forge.requests.find(
    (candidate) => candidate.method === method && candidate.url.endsWith(suffix),
  );
  return JSON.parse(request?.body ?? "{}") as Record<string, unknown>;
};

describe("forge issue writes", () => {
  it("creates an issue with label IDs, dropping and reporting an unknown name", async () => {
    const mark = env.events.length;
    const issue = await env.github.createIssue(P, {
      title: "Crash on save",
      body: "Steps to reproduce",
      labels: ["bug", "missing"],
    });

    expect(issue).toMatchObject({
      projectId: P,
      number: 1,
      title: "Crash on save",
      state: "open",
      labels: ["bug"],
      stateReason: null,
      url: issueUrl(1),
    });
    // Create takes IDs, resolved from the repository's labels; the unknown name never goes up.
    expect(body("POST", "/issues")).toMatchObject({
      title: "Crash on save",
      body: "Steps to reproduce",
      labels: [1],
    });
    expect(env.logs.join("\n")).toContain("missing");
    // The write is projected at once, as GitHub's is (no wait for the next poll).
    expect(types(mark)).toContain("issue.opened");
    expect(env.service.listIssues(P)).toMatchObject([{ number: 1, labels: ["bug"] }]);
  });

  it("comments with CodeDen's hidden marker, once", async () => {
    const issue = env.forge.addIssue({ title: "Bug" });

    const comment = await env.github.commentOnIssue(P, issue.number, "On it.");
    expect(comment.url).toContain("#issuecomment-");
    const stored = env.forge.issues.get(issue.number)?.comments.at(-1);
    expect(stored?.body).toBe(`On it.\n\n<!-- codeden -->`);
    // The sync recognises CodeDen's own comments and shows them without the marker.
    expect(isCodedenComment(stored?.body ?? "")).toBe(true);
    expect(withoutMarker(stored?.body ?? "")).toBe("On it.");

    // A body that already carries the marker is not marked twice.
    await env.github.commentOnIssue(P, issue.number, "Again.\n\n<!-- codeden -->");
    const again = env.forge.issues.get(issue.number)?.comments.at(-1);
    expect(again?.body.match(/<!-- codeden -->/g)).toHaveLength(1);
  });

  it("adds and removes labels by name, reporting what did not apply", async () => {
    const issue = env.forge.addIssue({ title: "Bug", labels: ["bug"] });
    await env.service.syncNow(P);

    const added = await env.github.labelIssue(P, issue.number, {
      add: ["enhancement", "urgent"],
      remove: [],
    });
    expect(added.labels).toEqual(["bug", "enhancement"]);
    expect(env.logs.join("\n")).toContain('"urgent"');
    const labeled = env.events.findLast((event) => event.type === "issue.labeled") as
      | { payload: { added: string[] } }
      | undefined;
    expect(labeled?.payload.added).toEqual(["enhancement"]);

    // Removing a label the issue doesn't have is not an error, as on GitHub.
    const removed = await env.github.labelIssue(P, issue.number, {
      add: [],
      remove: ["bug", "no-such-label"],
    });
    expect(removed.labels).toEqual(["enhancement"]);
  });

  it("triage closes the issue with a null state reason and claims no completion", async () => {
    const issue = env.forge.addIssue({ title: "Not ours", labels: ["needs info"] });
    await env.service.syncNow(P);
    const mark = env.events.length;

    const result = await env.github.triageIssue(P, issue.number, {
      decision: "out_of_scope",
      labels: ["bug"],
      removeLabels: ["needs info"],
      comment: "This belongs in another project.",
      close: true,
    });

    expect(result).toMatchObject({ decision: "out_of_scope", closed: true });
    expect(result.issue).toMatchObject({
      state: "closed",
      labels: ["bug"],
      stateReason: null,
      closedAt: expect.any(String),
    });
    expect(result.commentUrl).toContain("#issuecomment-");

    // The close is a bare state change: Forgejo has no reason field to send or read back.
    const patch = env.forge.requests.find(
      (request) => request.method === "PATCH" && request.url.endsWith(`/issues/${issue.number}`),
    );
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ state: "closed" });
    expect(env.forge.issues.get(issue.number)?.state).toBe("closed");

    // The projection and its events carry no close reason, so nothing reads as completed.
    const updated = env.events.slice(mark).findLast((event) => event.type === "issue.updated") as
      | { payload: { issue: { stateReason: string | null }; changes: string[] } }
      | undefined;
    expect(updated?.payload).toMatchObject({
      issue: { stateReason: null },
      changes: ["state"],
    });
    expect(JSON.stringify(env.events.slice(mark))).not.toContain("completed");
    expect(env.service.listIssues(P, { state: "closed" })[0]).toMatchObject({
      number: issue.number,
      stateReason: null,
    });
  });

  it("maps a failed write to the forge's own error code", async () => {
    await expect(env.github.commentOnIssue(P, 999, "Hello")).rejects.toMatchObject({
      code: "forge_not_found",
      status: 404,
    });
    await expect(env.github.labelIssue(P, 999, { add: ["bug"], remove: [] })).rejects.toMatchObject(
      { code: "forge_not_found" },
    );
    expect(env.githubRequests).toEqual([]);
  });

  it("never calls GitHub, and keeps PR and evidence writes refused", async () => {
    const issue = env.forge.addIssue({ title: "Bug" });
    await env.github.createIssue(P, { title: "New", body: "", labels: [] });
    await env.github.commentOnIssue(P, issue.number, "Hello");
    await env.github.labelIssue(P, issue.number, { add: ["bug"], remove: [] });
    await env.github.triageIssue(P, issue.number, {
      decision: "needs_info",
      labels: [],
      removeLabels: [],
      close: false,
    });
    expect(env.githubRequests).toEqual([]);

    const session = env.addSession();
    await expect(
      env.github.mergePr(`${P}:${issue.number}`, { method: "squash" }),
    ).rejects.toMatchObject({
      code: "not_a_github_project",
      status: 409,
    });
    // `attachEvidence` refuses synchronously (it never reaches the API call).
    try {
      env.github.attachEvidence(session.id, { summary: "not for a forge yet" });
      expect.unreachable("a forge project must not accept evidence");
    } catch (error) {
      expect(error).toMatchObject({ code: "not_a_github_project", status: 409 });
    }
    expect(env.githubRequests).toEqual([]);
  });
});

describe("forge triage", () => {
  const automation = {
    id: "a1",
    name: "Issue triage",
    action: { type: "triage", policy: { autoStart: true } },
  } as unknown as Automation;

  /** A `TriageService` over the forge environment, with a scripted orchestration and sessions. */
  function triageService() {
    const sent: string[] = [];
    const starts: unknown[] = [];
    const service = new TriageService({
      db: env.db.db,
      inbox: env.inbox,
      sessions: {
        start: async (request: unknown) => {
          starts.push(request);
          return { status: "started", session: { id: "s-triage" } };
        },
      } as unknown as SessionService,
      projects: env.projects,
      orchestration: () =>
        ({
          sendToRole: async (_role: string, _projectId: string, input: { text: string }) => {
            sent.push(input.text);
            return { sessionId: "pm-triage" };
          },
        }) as unknown as OrchestrationService,
      // The GitHub port answers for GitHub; a forge project must not consult it for trust.
      github: {
        viewerLogin: async () => "codeden-bot",
        issueAuthor: async () => {
          throw new Error("GitHub must not be asked about a forge issue");
        },
      },
      triageAutomation: () => automation,
    });
    return { service, sent, starts };
  }

  it("hands a new forge issue to the PM and keeps an untrusted author in the inbox", async () => {
    const issue = env.forge.addIssue({ title: "Crash", author: "lee" });
    await env.service.syncNow(P);
    const { service, sent, starts } = triageService();

    const pm = await service.request(
      env.forgeProject,
      automation,
      { id: "run-1" } as AutomationRun,
      { number: issue.number, title: issue.title, url: issueUrl(issue.number) },
    );
    expect(pm).toBe("pm-triage");
    expect(sent[0]).toContain(`New issue #${issue.number}: Crash`);
    expect(sent[0]).toContain(issueUrl(issue.number));
    expect(starts).toHaveLength(0);

    // "lee" is not a trusted author and a forge project has no live permission check yet.
    const decided = await service.report(env.forgeProject, {
      issueNumber: issue.number,
      decision: "ready",
      summary: "Clear bug.",
    });
    expect(decided.status).toBe("inbox");
    const item = env.inbox.get(`triage:${P}:${issue.number}`);
    expect(item.body).toContain("not one of this project's trusted authors");
    expect(starts).toHaveLength(0);

    // A trusted author of the project starts the session, as on GitHub.
    const trusted: Project = {
      ...env.forgeProject,
      factoryLimits: { ...env.forgeProject.factoryLimits, trustedAuthors: ["lee"] },
    };
    const started = await service.report(trusted, {
      issueNumber: issue.number,
      decision: "ready",
      summary: "Clear bug.",
    });
    expect(started.status).toBe("started");
    expect(starts).toHaveLength(1);
  });

  it("falls back to the forge's issue URL when the issue was never synced", async () => {
    const { service } = triageService();
    const decided = await service.report(env.forgeProject, {
      issueNumber: 9,
      decision: "ready",
      summary: "A bug.",
    });
    expect(decided.status).toBe("inbox");
    expect(env.inbox.get(`triage:${P}:9`).issue?.url).toBe(issueUrl(9));
  });
});
