import type { ForgeChecksSummary, ForgeCommit, ForgeCompare } from "@codeden/contracts";
import { ForgeError } from "../../errors";
import { type ForgejoContext, repoPath, seg } from "./context";
import { toForgeChecksSummary, toForgeCommit, toForgeCompare } from "./map-git";
import type {
  ForgejoBranch,
  ForgejoCombinedStatus,
  ForgejoCompare,
  ForgejoGitCommit,
} from "./types";

/**
 * Commit statuses, branches, comparisons and commits (`docs/forges.md` §5.5, §5.7, §5.8).
 * Forgejo has no `until` filter on commits, so `branchHeadAt` honestly returns null.
 */

/** A head's commit statuses, mapped to the checks summary (warning is a failure). */
export async function commitStatuses(
  context: ForgejoContext,
  sha: string,
): Promise<ForgeChecksSummary> {
  const first = await statusPage(context, sha, 1);
  const statuses = [...(first.statuses ?? [])];
  let total = first.total_count ?? statuses.length;
  for (let page = 2; page <= 20 && statuses.length < total; page++) {
    const next = await statusPage(context, sha, page);
    if ((next.statuses ?? []).length === 0) break;
    statuses.push(...(next.statuses ?? []));
    total = Math.max(total, next.total_count ?? total);
  }
  return toForgeChecksSummary({ ...first, statuses, total_count: total });
}

/** The branch's head commit SHA. */
export async function branchHead(context: ForgejoContext, branch: string): Promise<string> {
  const { data } = await context.http.get<ForgejoBranch>(
    `${repoPath(context)}/branches/${seg(branch)}`,
  );
  if (!data?.commit?.id) {
    throw new ForgeError("forge_unavailable", "Forgejo returned no branch head.");
  }
  return data.commit.id;
}

/** Forgejo's commit list has no `until` filter, so the head at a past time is unknown. */
export function branchHeadAt(_branch: string, _at: string): Promise<string | null> {
  return Promise.resolve(null);
}

/** Compare two refs; `behind` is Forgejo's `total_commits` and files are paths only. */
export async function compare(
  context: ForgejoContext,
  base: string,
  head: string,
): Promise<ForgeCompare> {
  const { data } = await context.http.get<ForgejoCompare>(
    `${repoPath(context)}/compare/${seg(base)}...${seg(head)}`,
  );
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no comparison.");
  return toForgeCompare(data);
}

/** A commit's message, tree and parents, for an exact revert comparison. */
export async function commit(context: ForgejoContext, sha: string): Promise<ForgeCommit> {
  const { data } = await context.http.get<ForgejoGitCommit>(
    `${repoPath(context)}/git/commits/${seg(sha)}`,
  );
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no commit.");
  return toForgeCommit(data);
}

async function statusPage(
  context: ForgejoContext,
  sha: string,
  page: number,
): Promise<ForgejoCombinedStatus> {
  const { data } = await context.http.get<ForgejoCombinedStatus>(
    `${repoPath(context)}/commits/${seg(sha)}/status`,
    { page, limit: 50 },
  );
  if (!data) throw new ForgeError("forge_unavailable", "Forgejo returned no commit status.");
  return data;
}
