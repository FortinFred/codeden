import {
  type ForgeAttachment,
  type ForgeFileCommit,
  type ForgePutFile,
  type ForgeUploadedAttachment,
  ForgeUploadedAttachment as ForgeUploadedAttachmentSchema,
} from "@codeden/contracts";
import { ForgeError } from "../../errors";
import { encodePath, type ForgejoContext, repoPath } from "./context";
import { branchHead, commitStatuses } from "./git";
import { repoInfo } from "./identity";
import { toForgeFileCommit } from "./map-git";
import type { ForgejoAttachment, ForgejoContents } from "./types";

/** A file read through the contents API, for the vision file and evidence fallback. */
export interface ForgejoFile {
  path: string;
  sha: string;
  /** Base64, as Forgejo returns it. */
  contents: string;
  size: number;
}

/** What a write through the contents API answered with. */
interface ForgejoFileResponse {
  content?: ForgejoContents;
  commit?: { sha?: string };
}

const WORKFLOW_DIRS = [".forgejo/workflows", ".gitea/workflows", ".github/workflows"];

/**
 * The Contents API and attachments (`docs/forges.md` §5.8). Forgejo has no Git Data write API:
 * one file per commit through `/contents`, evidence as issue/PR attachments, and no reverted tree
 * built through the API.
 */

/** Read one file through `GET /contents/{path}?ref=`. */
export async function readFile(
  context: ForgejoContext,
  path: string,
  ref?: string,
): Promise<ForgejoFile> {
  const { data } = await context.http.get<ForgejoContents | ForgejoContents[]>(
    `${repoPath(context)}/contents/${encodePath(path)}`,
    { ref },
  );
  if (Array.isArray(data)) {
    throw new ForgeError("forge_validation", `${path} is a directory, not a file.`);
  }
  if (!data?.sha) throw new ForgeError("forge_unavailable", "Forgejo returned no file.");
  return {
    path: data.path,
    sha: data.sha,
    contents: data.content ?? "",
    size: data.size ?? 0,
  };
}

/** Create or update one file, optionally on a new branch (the vision and evidence path). */
export async function putFile(
  context: ForgejoContext,
  request: ForgePutFile,
): Promise<ForgeFileCommit> {
  const body: Record<string, unknown> = {
    message: request.message,
    content: request.contents,
    branch: request.branch,
  };
  if (request.sha !== undefined) body.sha = request.sha;
  if (request.newBranch !== undefined) body.new_branch = request.newBranch;
  const { data } = await context.http.request<ForgejoFileResponse>(
    `${repoPath(context)}/contents/${encodePath(request.path)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
  return toForgeFileCommit(data?.content, data?.commit, request.path);
}

/** Upload attachments to an issue or PR, one request per file; the URLs go in the evidence comment. */
export async function attachFiles(
  context: ForgejoContext,
  number: number,
  files: ForgeAttachment[],
): Promise<ForgeUploadedAttachment[]> {
  const uploaded: ForgeUploadedAttachment[] = [];
  for (const file of files) {
    const form = new FormData();
    const bytes = Buffer.from(file.bytes, "base64");
    form.append(
      "attachment",
      new Blob([new Uint8Array(bytes)], { type: mimeType(file.name) }),
      file.name,
    );
    const { data } = await context.http.request<ForgejoAttachment | ForgejoAttachment[]>(
      `${repoPath(context)}/issues/${number}/assets`,
      { method: "POST", body: form },
    );
    const row = Array.isArray(data) ? data[0] : data;
    const url = row?.browser_download_url ?? row?.download_url ?? row?.html_url;
    if (!url) {
      throw new ForgeError(
        "forge_unavailable",
        "Forgejo returned an attachment without a download URL.",
      );
    }
    uploaded.push(
      ForgeUploadedAttachmentSchema.parse({
        name: row?.name ?? file.name,
        url,
        ...(file.caption ? { caption: file.caption } : {}),
      }),
    );
  }
  return uploaded;
}

/**
 * Whether a new head can be expected to get CI: true when Actions is on and a workflow file
 * exists; false only when Actions is off, no workflow exists and the default branch has never
 * had a commit status; otherwise null.
 */
export async function ciAvailable(context: ForgejoContext): Promise<boolean | null> {
  try {
    const info = await repoInfo(context);
    const workflow = await hasWorkflow(context);
    if (info.hasActions && workflow) return true;
    if (!info.hasActions && !workflow) {
      const head = await branchHead(context, info.defaultBranch);
      const checks = await commitStatuses(context, head);
      return checks.total === 0 ? false : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function hasWorkflow(context: ForgejoContext): Promise<boolean> {
  for (const dir of WORKFLOW_DIRS) {
    let data: ForgejoContents | ForgejoContents[];
    try {
      const result = await context.http.get<ForgejoContents | ForgejoContents[]>(
        `${repoPath(context)}/contents/${encodePath(dir)}`,
      );
      data = result.data;
    } catch (error) {
      if (error instanceof ForgeError && error.forgeCode === "forge_not_found") continue;
      throw error;
    }
    if (Array.isArray(data) && data.some((file) => /\.ya?ml$/i.test(file.name))) return true;
  }
  return false;
}

function mimeType(name: string): string {
  const extension = name.toLowerCase().split(".").pop();
  switch (extension) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "txt":
    case "log":
      return "text/plain";
    case "json":
      return "application/json";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
