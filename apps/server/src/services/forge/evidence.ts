import type { ForgeUploadedAttachment, Session } from "@codeden/contracts";
import type { ArtifactService } from "../artifacts";
import { badRequest, ForgeError } from "../errors";
import {
  type AttachEvidenceInput,
  type AttachEvidenceResult,
  readEvidence,
} from "../github/attach";
import {
  EVIDENCE_BRANCH,
  type EvidenceFile,
  evidenceComment,
  evidenceFileNames,
  isImageName,
  type PublishedEvidence,
} from "../github/evidence";
import type { WorkspaceFs } from "../workspace-fs/workspace-fs";
import type { ForgejoClient } from "./forgejo/client";

/**
 * Evidence on a Forgejo issue or pull request (`docs/forges.md` §5.8, §8.2, phase D): each file
 * is uploaded as an attachment and the returned absolute URL goes in the same evidence comment
 * GitHub posts. When attachments are disabled or a file exceeds the instance's limits, the file
 * is committed to the normal `codeden/evidence` branch through the Contents API instead, because
 * Forgejo has no Git Data write API and no orphan branch. The file checks and secret rules are
 * the GitHub path's (`readEvidence`), before any upload or commit.
 */

/** The target an evidence comment lands on: the session's PR, else its issue. */
function evidenceTarget(
  session: Session,
  input: AttachEvidenceInput,
): { kind: "pr" | "issue"; number: number } {
  const target =
    input.target ??
    (session.pr
      ? { kind: "pr" as const, number: session.pr.number }
      : session.issue
        ? { kind: "issue" as const, number: session.issue.number }
        : null);
  if (!target) {
    throw badRequest("This session has no pull request or issue yet; pass target", "no_target");
  }
  return target;
}

/** Attach evidence to a Forgejo issue or PR and post the evidence comment. */
export async function attachForgeEvidence(opts: {
  client: ForgejoClient;
  session: Session;
  artifacts: ArtifactService;
  input: AttachEvidenceInput;
  defaultBranch: string;
  home?: string;
  remote?: WorkspaceFs;
}): Promise<AttachEvidenceResult> {
  const { client, session, input } = opts;
  const target = evidenceTarget(session, input);
  const files = await readEvidence(
    session,
    opts.artifacts,
    input.files ?? [],
    opts.home,
    opts.remote,
  );
  if (files.length === 0 && !input.summary && !input.testOutput) {
    throw badRequest("Pass files, a summary or test output");
  }
  const folder = `${target.kind}-${target.number}/${session.id}`;
  const message = `Evidence for ${target.kind === "pr" ? "PR" : "issue"} #${target.number} (session ${session.id})`;
  const published = files.length
    ? await publishFiles(client, target.number, folder, files, opts.defaultBranch, message)
    : { files: [], committed: [] };
  const body = evidenceComment({
    files: published.files,
    summary: input.summary,
    testOutput: input.testOutput,
    sessionLabel: session.title
      ? `CodeDen session ${session.title} (\`${session.id}\`)`
      : `CodeDen session \`${session.id}\``,
    ...(published.committed.length
      ? {
          note: `Committed to the \`${EVIDENCE_BRANCH}\` branch: ${published.committed
            .map((file) => `\`${file.path}\``)
            .join(", ")}`,
        }
      : {}),
  });
  const comment = await client.comment(target.number, body);
  return {
    target,
    commentUrl: comment.url,
    commit: published.committed.at(-1)?.commitSha ?? null,
    files: published.files.map((file) => ({ name: file.name, url: file.url })),
  };
}

/** Upload each file; a file the attachment API refuses is committed to the evidence branch. */
async function publishFiles(
  client: ForgejoClient,
  number: number,
  folder: string,
  files: EvidenceFile[],
  defaultBranch: string,
  message: string,
): Promise<{ files: PublishedEvidence[]; committed: Array<{ path: string; commitSha: string }> }> {
  const names = evidenceFileNames(files.map((file) => file.name));
  const published: PublishedEvidence[] = [];
  const committed: Array<{ path: string; commitSha: string }> = [];
  for (const [index, file] of files.entries()) {
    const name = names[index] ?? file.name;
    try {
      const uploaded = await upload(client, number, name, file);
      published.push({
        name: uploaded.name,
        path: uploaded.name,
        url: uploaded.url,
        isImage: isImageName(name),
        ...(file.caption ? { caption: file.caption } : {}),
      });
    } catch (error) {
      if (!attachmentsUnavailable(error)) throw error;
      const path = `${folder}/${name}`;
      const written = await commitEvidenceFile(client, {
        path,
        bytes: file.bytes,
        message,
        defaultBranch,
      });
      committed.push({ path, commitSha: written });
      published.push({
        name,
        path,
        url: rawUrl(client, path),
        isImage: isImageName(name),
        ...(file.caption ? { caption: file.caption } : {}),
      });
    }
  }
  return { files: published, committed };
}

async function upload(
  client: ForgejoClient,
  number: number,
  name: string,
  file: EvidenceFile,
): Promise<ForgeUploadedAttachment> {
  const [uploaded] = await client.attachFiles(number, [
    {
      name,
      bytes: file.bytes.toString("base64"),
      ...(file.caption ? { caption: file.caption } : {}),
    },
  ]);
  if (!uploaded) {
    throw new ForgeError(
      "forge_unavailable",
      "Forgejo returned no attachment for an uploaded file.",
    );
  }
  return uploaded;
}

/**
 * The attachment API could not take the file: attachments are disabled (404), the file is too
 * large or its type is refused (413/415/422), or this token may not upload (403). Anything else
 * (not connected, rate limited, the forge is down) is not a reason to write a branch instead.
 */
function attachmentsUnavailable(error: unknown): boolean {
  if (!(error instanceof ForgeError)) return false;
  return (
    error.forgeCode === "forge_not_found" ||
    error.forgeCode === "forge_validation" ||
    error.forgeCode === "forge_forbidden" ||
    error.forgeCode === "forge_not_allowed"
  );
}

/**
 * Commit one evidence file through the Contents API: update it when it already exists, else
 * create the branch from the default branch on first use. Returns the commit SHA.
 */
async function commitEvidenceFile(
  client: ForgejoClient,
  opts: { path: string; bytes: Buffer; message: string; defaultBranch: string },
): Promise<string> {
  const contents = opts.bytes.toString("base64");
  let existing: { sha: string } | null = null;
  try {
    existing = await client.readFile(opts.path, EVIDENCE_BRANCH);
  } catch (error) {
    if (!(error instanceof ForgeError && error.forgeCode === "forge_not_found")) throw error;
  }
  if (existing) {
    const written = await client.putFile({
      path: opts.path,
      contents,
      branch: EVIDENCE_BRANCH,
      sha: existing.sha,
      message: opts.message,
    });
    return written.commitSha;
  }
  try {
    const written = await client.putFile({
      path: opts.path,
      contents,
      branch: EVIDENCE_BRANCH,
      message: opts.message,
    });
    return written.commitSha;
  } catch (error) {
    // The branch itself does not exist yet (a 404, or a 422 on some releases): create it from
    // the default branch.
    if (
      !(
        error instanceof ForgeError &&
        (error.forgeCode === "forge_not_found" || error.forgeCode === "forge_validation")
      )
    ) {
      throw error;
    }
    const written = await client.putFile({
      path: opts.path,
      contents,
      branch: opts.defaultBranch,
      newBranch: EVIDENCE_BRANCH,
      message: opts.message,
    });
    return written.commitSha;
  }
}

/** The absolute raw URL Forgejo serves inline for a readable repository (§8.2). */
function rawUrl(client: ForgejoClient, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${client.http.base.baseUrl}/${encodeURIComponent(client.owner)}/${encodeURIComponent(
    client.repo,
  )}/raw/branch/${EVIDENCE_BRANCH}/${encoded}`;
}

/**
 * Evidence comments CodeDen posted, by the viewer: the heading, image links to the configured
 * host (an `/attachments/...` upload or a `/raw/branch/...` fallback) and the test-output block.
 */
export function forgeEvidenceComment(
  body: string,
  baseUrl: string,
): { screenshots: boolean; testOutput: boolean } {
  return {
    screenshots: hasForgeImage(body, baseUrl),
    testOutput: /<summary>Test output<\/summary>/i.test(body),
  };
}

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g;

function hasForgeImage(body: string, baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return false;
  }
  for (const match of body.matchAll(MARKDOWN_IMAGE)) {
    const link = match[1];
    if (!link) continue;
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (url.host.toLowerCase() !== host) continue;
    if (url.pathname.includes("/attachments/") || url.pathname.includes("/raw/branch/")) {
      return true;
    }
  }
  return false;
}
