import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactoryService, type FactoryServiceDeps } from "../src/services/factory/factory-service";
import { GithubFactoryPort, VISION_BRANCH } from "../src/services/factory/github-port";
import { ForgeFactoryPort, ProjectFactoryPort } from "../src/services/forge/factory-port";
import {
  EVIDENCE_BRANCH,
  EVIDENCE_HEADING,
  evidenceComment,
} from "../src/services/github/evidence";
import { createForgeEnv, type ForgeEnv } from "./support/forge-env";

/**
 * `docs/forges.md` §5.8 and §8.2, phase D: evidence on a Forgejo PR is an attachment comment
 * (absolute URLs, captions, the test-output details), or a `codeden/evidence` branch written
 * through the Contents API when attachments are unavailable. Secrets are refused before any
 * request, and the factory finds only CodeDen's own evidence comments.
 */

let env: ForgeEnv;
const P = "p-forge";
const PATH = ".codeden/VISION.md";

beforeEach(() => {
  env = createForgeEnv();
});
afterEach(async () => {
  await env.close();
});

function port(): ForgeFactoryPort {
  return new ForgeFactoryPort({ projects: env.projects, forge: env.service });
}

/** A PR with a session linked to it: the default evidence target. */
function prSession(): { session: Session; pr: number } {
  const pr = env.forge.addPr("codeden/panel", { title: "Add the panel" });
  const session = env.addSession({
    title: "Add the panel",
    pr: {
      number: pr.number,
      url: `${env.forge.baseUrl}/acme/widgets/pulls/${pr.number}`,
      state: "open",
      title: "Add the panel",
    },
  });
  return { session, pr: pr.number };
}

function comment(pr: number): string {
  return env.forge.issues.get(pr)?.comments.at(-1)?.body ?? "";
}

describe("attaching evidence on a Forgejo PR", () => {
  it("uploads each file as an attachment and posts one evidence comment", async () => {
    const { session, pr } = prSession();
    writeFileSync(join(env.dir, "panel.png"), Buffer.from("png-bytes"));

    const result = await env.github.attachEvidence(session.id, {
      files: [{ path: "panel.png", caption: "The new panel" }],
      summary: "Checked the settings panel",
      testOutput: "vitest: 12 passed",
    });

    expect(result.target).toEqual({ kind: "pr", number: pr });
    expect(result.commit).toBeNull();
    expect(env.forge.attachments).toHaveLength(1);
    const uploaded = env.forge.attachments[0];
    expect(uploaded?.number).toBe(pr);
    expect(result.files).toEqual([{ name: "panel.png", url: uploaded?.url }]);

    const body = comment(pr);
    expect(body.startsWith(EVIDENCE_HEADING)).toBe(true);
    expect(body).toContain("Checked the settings panel");
    expect(body).toContain(`![The new panel](${uploaded?.url})`);
    expect(body).toContain("*The new panel*");
    expect(body).toContain("<details><summary>Test output</summary>");
    expect(body).toContain("vitest: 12 passed");
    // The URL is absolute: a relative /attachments/... would resolve against the comment page.
    expect(uploaded?.url.startsWith(`${env.forge.baseUrl}/attachments/`)).toBe(true);
    expect(env.forge.issues.get(pr)?.comments.at(-1)?.author).toBe(env.forge.viewer);
    // One upload per request, as the API expects.
    expect(
      env.forge.requests.filter((r) => r.method === "POST" && r.url.includes("/assets")),
    ).toHaveLength(1);
  });

  it("commits to the codeden/evidence branch when attachments are disabled", async () => {
    const { session, pr } = prSession();
    writeFileSync(join(env.dir, "panel.png"), Buffer.from("png-bytes"));
    env.forge.attachmentsEnabled = false;

    const result = await env.github.attachEvidence(session.id, {
      files: [{ path: "panel.png", caption: "The new panel" }],
    });

    const path = `pr-${pr}/${session.id}/panel.png`;
    const rawUrl = `${env.forge.baseUrl}/acme/widgets/raw/branch/${EVIDENCE_BRANCH}/${path}`;
    expect(result.commit).toBeTruthy();
    expect(result.files).toEqual([{ name: "panel.png", url: rawUrl }]);
    expect(env.forge.attachments).toEqual([]);
    expect(env.forge.files.has(`${EVIDENCE_BRANCH}\u0000${path}`)).toBe(true);
    const created = env.forge.requests.find(
      (request) =>
        request.method === "PUT" && JSON.parse(request.body || "{}").new_branch === EVIDENCE_BRANCH,
    );
    expect(JSON.parse(created?.body ?? "{}")).toMatchObject({
      branch: "main",
      new_branch: EVIDENCE_BRANCH,
    });
    const body = comment(pr);
    expect(body).toContain(`![The new panel](${rawUrl})`);
    expect(body).toContain(`Committed to the \`${EVIDENCE_BRANCH}\` branch`);
    expect(body).toContain(`\`${path}\``);
  });

  it("falls back when a file is larger than the instance allows", async () => {
    const { session, pr } = prSession();
    writeFileSync(join(env.dir, "panel.png"), Buffer.from("png-bytes"));
    env.forge.maxAttachmentBytes = 0;

    const result = await env.github.attachEvidence(session.id, {
      files: [{ path: "panel.png" }],
    });

    expect(result.commit).toBeTruthy();
    expect(comment(pr)).toContain(`/raw/branch/${EVIDENCE_BRANCH}/`);
  });

  it("refuses a secret file before any upload or contents write", async () => {
    const { session, pr } = prSession();
    writeFileSync(join(env.dir, ".env"), "SECRET=hunter2\n");

    await expect(
      env.github.attachEvidence(session.id, { files: [{ path: ".env" }] }),
    ).rejects.toMatchObject({ code: "secret_file", status: 403 });

    expect(env.forge.attachments).toEqual([]);
    expect(env.forge.files.size).toBe(0);
    expect(env.forge.requests).toEqual([]);
    expect(env.forge.issues.get(pr)?.comments).toEqual([]);
  });
});

describe("the factory reads evidence on a Forgejo PR", () => {
  it("finds CodeDen's own attachment and branch links, and its test output", async () => {
    const first = env.forge.addPr("codeden/a");
    const body = evidenceComment({
      files: [
        {
          name: "panel.png",
          path: "panel.png",
          url: `${env.forge.baseUrl}/attachments/5001`,
          isImage: true,
        },
        {
          name: "log.png",
          path: "pr-1/s1/log.png",
          url: `${env.forge.baseUrl}/acme/widgets/raw/branch/${EVIDENCE_BRANCH}/pr-1/s1/log.png`,
          isImage: true,
        },
      ],
      testOutput: "12 passed",
      sessionLabel: "CodeDen session `s1`",
    });
    env.forge.addComment(first.number, body, env.forge.viewer ?? "coden-bot");

    expect(await port().evidence(P, first.number, null)).toEqual({
      screenshots: true,
      testOutput: true,
    });
  });

  it("ignores a stranger's evidence comment on a public repository", async () => {
    const pr = env.forge.addPr("codeden/a");
    const body = evidenceComment({
      files: [
        {
          name: "panel.png",
          path: "panel.png",
          url: `${env.forge.baseUrl}/attachments/5002`,
          isImage: true,
        },
      ],
      testOutput: "12 passed",
      sessionLabel: "CodeDen session `s1`",
    });
    env.forge.addComment(pr.number, body, "mallory");

    expect(await port().evidence(P, pr.number, null)).toEqual({
      screenshots: false,
      testOutput: false,
    });
  });

  it("ignores an image that is not on the configured host", async () => {
    const pr = env.forge.addPr("codeden/a");
    const body = evidenceComment({
      files: [
        {
          name: "panel.png",
          path: "panel.png",
          url: "https://elsewhere.example/attachments/5003",
          isImage: true,
        },
      ],
      sessionLabel: "CodeDen session `s1`",
    });
    env.forge.addComment(pr.number, body, env.forge.viewer ?? "coden-bot");

    expect((await port().evidence(P, pr.number, null)).screenshots).toBe(false);
  });

  it("fails closed when no viewer is known, so nobody's comment is CodeDen's own", async () => {
    const pr = env.forge.addPr("codeden/a");
    env.forge.addComment(
      pr.number,
      evidenceComment({
        files: [
          {
            name: "panel.png",
            path: "panel.png",
            url: `${env.forge.baseUrl}/attachments/5004`,
            isImage: true,
          },
        ],
        sessionLabel: "CodeDen session `s1`",
      }),
      "coden-bot",
    );
    env.forge.viewer = null;

    expect(await port().evidence(P, pr.number, null)).toEqual({
      screenshots: false,
      testOutput: false,
    });
  });
});

describe("sharing the vision on a Forgejo project", () => {
  const vision = "# Vision\n\n## Goals\n- Count things\n";

  it("commits the file to codeden/vision and opens its PR, then updates the same PR", async () => {
    const ref = await port().shareVision(P, PATH, vision);

    expect(ref).toMatchObject({ state: "open", title: "Update the project vision" });
    const file = env.forge.files.get(`${VISION_BRANCH}\u0000${PATH}`);
    expect(file?.contents).toBe(Buffer.from(vision, "utf8").toString("base64"));
    expect(
      JSON.parse(env.forge.requests.find((r) => r.method === "PUT")?.body ?? "{}"),
    ).toMatchObject({ branch: "main", new_branch: VISION_BRANCH });
    expect(env.forge.issues.get(ref?.number ?? 0)).toMatchObject({
      pullRequest: true,
      headBranch: VISION_BRANCH,
      baseBranch: "main",
    });

    const next = "# Vision\n\n## Goals\n- Count more things\n";
    const updated = await port().shareVision(P, PATH, next);

    expect(updated?.number).toBe(ref?.number);
    expect(env.forge.issues.size).toBe(1);
    expect(env.forge.files.get(`${VISION_BRANCH}\u0000${PATH}`)?.contents).toBe(
      Buffer.from(next, "utf8").toString("base64"),
    );
    const updates = env.forge.requests.filter(
      (request) => request.method === "PUT" && request.url.includes("/contents/"),
    );
    expect(updates).toHaveLength(2);
    expect(JSON.parse(updates[1]?.body ?? "{}")).toMatchObject({ branch: VISION_BRANCH });
    expect(JSON.parse(updates[1]?.body ?? "{}")).not.toHaveProperty("new_branch");
  });

  it("answers null when the default branch already has the file", async () => {
    env.forge.files.set(`main\u0000${PATH}`, {
      branch: "main",
      path: PATH,
      contents: Buffer.from(vision, "utf8").toString("base64"),
      sha: "blob-main",
    });

    expect(await port().shareVision(P, PATH, vision)).toBeNull();
    expect(env.forge.issues.size).toBe(0);
    expect(env.forge.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("shares the vision from the editor's save path through the forge port", async () => {
    const factory = new FactoryService({
      db: env.db.db,
      store: env.store,
      projects: env.projects,
      repo: env.repo,
      sessions: {} as FactoryServiceDeps["sessions"],
      runner: {} as FactoryServiceDeps["runner"],
      usage: {} as FactoryServiceDeps["usage"],
      inbox: env.inbox,
      notify: () => undefined,
      settings: {} as FactoryServiceDeps["settings"],
      exec: async () => ({
        code: null,
        stdout: "",
        stderr: "",
        notFound: true,
        timedOut: false,
        path: null,
      }),
      github: new ProjectFactoryPort({
        projects: env.projects,
        github: new GithubFactoryPort(env.github),
        forge: port(),
      }),
      archiveSession: async () => undefined,
      options: { autoTick: false },
    });
    try {
      const saved = await factory.putVision(P, vision);
      expect(saved).toMatchObject({ exists: true, shareError: null });
      expect(saved.pr?.state).toBe("open");
      expect(env.forge.files.has(`${VISION_BRANCH}\u0000${PATH}`)).toBe(true);
    } finally {
      factory.stop();
    }
  });

  it("resets a stale branch from a closed vision PR before opening the new one", async () => {
    const old = await port().shareVision(P, PATH, vision);
    env.forge.touch(old?.number ?? 0, (row) => {
      row.state = "closed";
      row.merged = true;
    });
    expect(env.forge.branchHeads.has(VISION_BRANCH)).toBe(true);

    const ref = await port().shareVision(P, PATH, "# Vision\n\n## Goals\n- Start over\n");

    expect(ref?.number).not.toBe(old?.number);
    expect(
      env.forge.requests.some(
        (request) => request.method === "DELETE" && request.url.includes("/branches/"),
      ),
    ).toBe(true);
    const latest = env.forge.requests.filter((request) => request.method === "PUT").at(-1);
    expect(JSON.parse(latest?.body ?? "{}")).toMatchObject({
      branch: "main",
      new_branch: VISION_BRANCH,
    });
    expect(env.forge.issues.get(ref?.number ?? 0)?.state).toBe("open");
  });
});
