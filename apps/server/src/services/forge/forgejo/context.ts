import type { ForgePr, Mergeable } from "@codeden/contracts";
import { ForgeError } from "../../errors";
import type { ForgejoHttp } from "./http";
import { type PreviousMergeable, toForgePr, toMergeable } from "./map";
import type {
  ForgejoComment,
  ForgejoIssue,
  ForgejoLabel,
  ForgejoPull,
  ForgejoPullFile,
} from "./types";

/**
 * State shared by the Forgejo client's concern modules: the HTTP layer, the repository
 * coordinates, and the last `mergeable` read per PR (so a second false can mean a conflict).
 */
export interface ForgejoContext {
  http: ForgejoHttp;
  projectId: string;
  owner: string;
  repo: string;
  log?: (message: string) => void;
  /** The previous read of each open PR's head and mergeability. */
  mergeableReads: Map<number, PreviousMergeable>;
}

/** `repos/{owner}/{repo}` with each segment encoded. */
export function repoPath(context: ForgejoContext): string {
  return `repos/${seg(context.owner)}/${seg(context.repo)}`;
}

/** One URL path segment. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

/** A repository path, keeping its slashes. */
export function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(seg).join("/");
}

/** Read one issue by its repository index. */
export async function readIssue(context: ForgejoContext, number: number): Promise<ForgejoIssue> {
  const { data } = await context.http.get<ForgejoIssue>(`${repoPath(context)}/issues/${number}`);
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no issue.");
  return data;
}

/** Read one pull request by its repository index. */
export async function readPull(context: ForgejoContext, number: number): Promise<ForgejoPull> {
  const { data } = await context.http.get<ForgejoPull>(`${repoPath(context)}/pulls/${number}`);
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no pull request.");
  return data;
}

/**
 * Read comments, oldest first. The API schema has `since` (and `before`) but no page/limit, so
 * this is one request; a caller's `limit` keeps the most recent N.
 */
export async function readComments(
  context: ForgejoContext,
  number: number,
  options: { since?: string; limit?: number } = {},
): Promise<ForgejoComment[]> {
  const { data } = await context.http.get<ForgejoComment[]>(
    `${repoPath(context)}/issues/${number}/comments`,
    { since: options.since },
  );
  const rows = Array.isArray(data) ? data : [];
  return options.limit === undefined ? rows : rows.slice(-options.limit);
}

/** Read a PR's changed files across pages (Forgejo's listing carries no patch). */
export function readPullFiles(context: ForgejoContext, number: number): Promise<ForgejoPullFile[]> {
  return context.http.paginate<ForgejoPullFile>(`${repoPath(context)}/pulls/${number}/files`);
}

/** The repository's labels, for resolving create-issue label names to IDs. */
export function readRepoLabels(context: ForgejoContext): Promise<ForgejoLabel[]> {
  return context.http.paginate<ForgejoLabel>(`${repoPath(context)}/labels`, {}, { limit: 500 });
}

/** Map a PR row, settling `mergeable: false` against the previous read of the same head. */
export function mapPull(context: ForgejoContext, raw: ForgejoPull): ForgePr {
  const previous = context.mergeableReads.get(raw.number);
  const mergeable: Mergeable = toMergeable(raw, previous);
  context.mergeableReads.set(raw.number, {
    headSha: raw.head.sha,
    mergeable: raw.mergeable ?? null,
  });
  return toForgePr(context.projectId, raw, { mergeable });
}

/**
 * Resolve label names to the IDs create-issue requires. Names are matched exactly, then
 * case-insensitively; an unknown name is dropped and logged, never guessed (`§5.4`).
 */
export async function resolveLabels(context: ForgejoContext, names: string[]): Promise<number[]> {
  const labels = await readRepoLabels(context);
  const byName = new Map<string, ForgejoLabel>();
  for (const label of labels) {
    byName.set(label.name, label);
    if (!byName.has(label.name.toLowerCase())) byName.set(label.name.toLowerCase(), label);
  }
  const ids: number[] = [];
  for (const name of names) {
    const label = byName.get(name) ?? byName.get(name.toLowerCase());
    if (label) {
      if (!ids.includes(label.id)) ids.push(label.id);
    } else {
      context.log?.(`Forgejo: unknown label "${name}" was not applied.`);
    }
  }
  return ids;
}
